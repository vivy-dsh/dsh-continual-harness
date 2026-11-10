import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetDigest, OciSkillRunner, SkillOwner } from '../src/skill-owner.ts'
import type { IsolatedRunner, SkillCandidateInput, ValidationSuite } from '../src/skill-owner.ts'
import { renderSkillMarkdown } from '../src/skills.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }) })
function fixture(options: { scores?: number[]; authorized?: () => boolean; runner?: IsolatedRunner; suite?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-owner-')); dirs.push(root)
  const calls: string[] = [], scores = [...(options.scores ?? [1, 0.7, 0.7])]
  const runner: IsolatedRunner = options.runner ?? {
    environmentDigest: async () => 'trusted-test-oci-environment',
    run: async (_suite, test, dir) => { calls.push(`${test.id}:${dir}`); return { completed: true, score: scores.shift() ?? 1 } },
  }
  const suite: ValidationSuite = { policyVersion: 'test-policy-v1', image: `test@sha256:${'a'.repeat(64)}`, platform: 'linux', timeoutMs: 1000, mandatory: [{ id: 'execute', command: ['/trusted/execute'] }], holdout: [{ id: 'independent-holdout', command: ['/trusted/evaluate'] }] }
  if (options.suite !== false) writeFileSync(join(root, 'validation-suite.json'), JSON.stringify(suite))
  const authorizationRequests: unknown[] = []
  const owner = new SkillOwner(root, async request => { authorizationRequests.push(request); return options.authorized?.() ?? true }, { runner })
  const input: SkillCandidateInput = { skillId: 'test-skill', entry: { content: 'Run the trusted procedure.', description: 'Use when testing.' }, expectedDigest: null, subjectId: 'subject-one', ticketId: 'ticket-one', evidenceRefs: [{ sessionId: 's1', eventId: 'primary-e1' }], idempotencyKey: 'candidate-one' }
  const publish = async () => {
    const candidate = owner.stageCandidate(input), validation = await owner.validateCandidate(candidate.candidateId)
    return owner.publishCandidate({ candidateId: candidate.candidateId, receiptId: validation.receiptId!, idempotencyKey: 'publication-one', subjectId: input.subjectId, ticketId: input.ticketId })
  }
  return { root, owner, input, suite, calls, publish, authorizationRequests }
}
describe('immutable SkillOwner gate', () => {
  it.skipIf(process.platform === 'win32')('makes the entire mounted bundle traversable by the isolated non-root user under umask 077', () => {
    const { owner, input } = fixture(), previous = process.umask(0o077)
    try {
      const candidate = owner.stageCandidate({ ...input, entry: { content: 'Procedure.', files: { 'scripts/nested/execute.sh': 'true' } } })
      const dir = owner.bundleDir(candidate.candidateId)
      expect(statSync(dir).mode & 0o777).toBe(0o755)
      expect(statSync(join(dir, 'scripts')).mode & 0o777).toBe(0o755)
      expect(statSync(join(dir, 'scripts', 'nested')).mode & 0o777).toBe(0o755)
    } finally { process.umask(previous) }
  })
  it('stages outside discovery and publishes only after real mandatory and paired holdout execution', async () => {
    const { owner, input, calls, publish, authorizationRequests } = fixture()
    const candidate = owner.stageCandidate(input)
    expect(owner.status({})).toEqual([])
    expect(owner.stageCandidate(input)).toEqual(candidate)
    const publication = await publish()
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('execute:')
    expect(calls[1]).toContain('empty-baseline')
    expect(publication.bundleDigest).toEqual(candidate.bundleDigest)
    expect(authorizationRequests[0]).toMatchObject({ candidateId: candidate.candidateId, entryDigest: assetDigest(candidate.entry), expectedDigest: null, evidenceRefs: input.evidenceRefs })
    expect(owner.status({ idempotencyKey: 'publication-one' })).toEqual(publication)
    expect(owner.status({ idempotencyKey: 'unknown' })).toBeNull()
  })
  it('blocks no cases and unavailable isolation instead of passing', async () => {
    const absent = fixture({ suite: false }); const c = absent.owner.stageCandidate(absent.input)
    expect((await absent.owner.validateCandidate(c.candidateId)).status).toBe('blocked')
    const unavailable = fixture({ runner: { environmentDigest: async () => { throw new Error('Docker unavailable') }, run: async () => { throw new Error('must never execute on host') } } })
    expect((await unavailable.owner.validateCandidate(unavailable.owner.stageCandidate(unavailable.input).candidateId)).status).toBe('blocked')
  })
  it('rejects mandatory failures and independent holdout regressions without significance requirements', async () => {
    for (const scores of [[0, 1, 1], [1, 1, 0.9]]) {
      const { owner, input } = fixture({ scores }); const c = owner.stageCandidate(input)
      expect((await owner.validateCandidate(c.candidateId)).status).toBe('rejected')
      expect(owner.status({})).toEqual([])
    }
  })
  it('blocks inconclusive runner output', async () => {
    const { owner, input } = fixture({ scores: [1, Number.NaN, 1] })
    expect((await owner.validateCandidate(owner.stageCandidate(input).candidateId)).status).toBe('blocked')
  })
  it('rejects caller-fabricated passed receipt and canceled live Ticket', async () => {
    let authorized = true
    const { owner, root, input } = fixture({ authorized: () => authorized })
    const c = owner.stageCandidate(input)
    mkdirSync(join(root, 'validations'))
    writeFileSync(join(root, 'validations', 'forged.json'), JSON.stringify({ status: 'passed', candidateId: c.candidateId, bundleDigest: c.bundleDigest, baselineDigest: null }))
    const request = { candidateId: c.candidateId, receiptId: 'forged', idempotencyKey: 'pub', subjectId: input.subjectId, ticketId: input.ticketId }
    await expect(owner.publishCandidate(request)).rejects.toThrow('Trusted validation receipt')
    const validation = await owner.validateCandidate(c.candidateId); authorized = false
    await expect(owner.publishCandidate({ ...request, receiptId: validation.receiptId! })).rejects.toThrow('not currently authorized')
  })
  it('rechecks policy and baseline at owner commit', async () => {
    const { owner, input, suite, root } = fixture()
    const c = owner.stageCandidate(input), validation = await owner.validateCandidate(c.candidateId)
    writeFileSync(join(root, 'validation-suite.json'), JSON.stringify({ ...suite, policyVersion: 'changed' }))
    await expect(owner.publishCandidate({ candidateId: c.candidateId, receiptId: validation.receiptId!, idempotencyKey: 'pub', subjectId: input.subjectId, ticketId: input.ticketId })).rejects.toThrow('current policy')
    writeFileSync(join(root, 'validation-suite.json'), JSON.stringify(suite))
    await owner.publishCandidate({ candidateId: c.candidateId, receiptId: validation.receiptId!, idempotencyKey: 'pub', subjectId: input.subjectId, ticketId: input.ticketId })
    expect(() => owner.stageCandidate({ ...input, idempotencyKey: 'stale-update' })).toThrow('baseline conflict')
  })
  it('pins already-listed bodies and resources to their immutable version', async () => {
    const { owner, input, publish } = fixture(); const first = await publish()
    const provider = owner.provider({ invalidate() {} }), old = (await provider.list())[0]!
    expect(old.rank).toBe(390) // Project/custom user roots retain their established precedence.
    const next = owner.stageCandidate({ ...input, expectedDigest: first.bundleDigest, entry: { content: 'The new procedure.' }, idempotencyKey: 'second' })
    const validation = await owner.validateCandidate(next.candidateId)
    await owner.publishCandidate({ candidateId: next.candidateId, receiptId: validation.receiptId!, idempotencyKey: 'second-pub', subjectId: input.subjectId, ticketId: input.ticketId })
    expect((await provider.get(old)).content).toBe(input.entry.content)
    expect((await provider.get((await provider.list())[0]!)).content).toBe('The new procedure.')
    expect(old.resourceBase.path).toContain(first.bundleDigest)
  })
  it('rolls back through the same immutable candidate validation and CAS publication gate', async () => {
    const { owner, input, publish, calls } = fixture(), original = await publish()
    const update = owner.stageCandidate({ ...input, expectedDigest: original.bundleDigest, entry: { content: 'Changed procedure.' }, idempotencyKey: 'update' })
    const validation = await owner.validateCandidate(update.candidateId)
    const updated = await owner.publishCandidate({ candidateId: update.candidateId, receiptId: validation.receiptId!, idempotencyKey: 'update-pub', subjectId: input.subjectId, ticketId: input.ticketId })
    const rollback = owner.stageRollback({ ...input, expectedDigest: updated.bundleDigest, rollbackOf: original.publicationId, idempotencyKey: 'rollback' })
    expect(owner.currentDigest(input.skillId)).toBe(updated.bundleDigest)
    const checked = await owner.validateCandidate(rollback.candidateId)
    const restored = await owner.publishCandidate({ candidateId: rollback.candidateId, receiptId: checked.receiptId!, idempotencyKey: 'rollback-pub', subjectId: input.subjectId, ticketId: input.ticketId })
    expect(restored.version).toBe(3)
    expect(restored.bundleDigest).toBe(original.bundleDigest)
    expect(restored.rollbackOf).toBe(original.publicationId)
    expect(calls).toHaveLength(9)
  })
  it('rejects mutated staged bundles and unsafe paths before any live publication', () => {
    const { owner, input } = fixture(), c = owner.stageCandidate(input)
    const path = join(owner.bundleDir(c.candidateId), 'SKILL.md'); chmodSync(path, 0o600); writeFileSync(path, 'tampered')
    expect(() => owner.status({ candidateId: c.candidateId })).toThrow('digest mismatch')
    expect(() => owner.stageCandidate({ ...input, entry: { content: 'bad', files: { 'scripts/../secret': 'x' } }, idempotencyKey: 'unsafe' })).toThrow('invalid path')
  })
  it('migrates only author-marked byte-identical legacy bundles without touching user files', () => {
    const { root } = fixture(), skillsDir = join(root, 'skills'), ownerRoot = join(root, 'owner')
    const entry = { id: 'old-skill', kind: 'skill' as const, version: 1, updatedAt: '', content: 'Existing behavior' }
    mkdirSync(join(skillsDir, entry.id), { recursive: true }); writeFileSync(join(skillsDir, entry.id, 'SKILL.md'), renderSkillMarkdown(entry))
    mkdirSync(join(skillsDir, 'user-skill')); const userFile = join(skillsDir, 'user-skill', 'SKILL.md'); writeFileSync(userFile, 'User content')
    const owner = new SkillOwner(ownerRoot, async () => true, { skillsDir })
    expect(owner.migrateLegacy([entry, { ...entry, id: 'user-skill' }])).toEqual(['old-skill'])
    expect(owner.currentDigest('old-skill')).not.toBeNull()
    expect(readFileSync(userFile, 'utf8')).toBe('User content')
    expect(() => owner.stageCandidate({ skillId: 'user-skill', entry: { content: 'overwrite' }, expectedDigest: null, subjectId: 's', ticketId: 't', evidenceRefs: ['e'], idempotencyKey: 'x' })).toThrow('migrated by its owner')
    expect(existsSync(join(skillsDir, 'old-skill', 'SKILL.md'))).toBe(true)
  })
  it('requires digest-pinned matching OCI images and canonical digest order', async () => {
    const { suite } = fixture()
    await expect(new OciSkillRunner().environmentDigest({ ...suite, image: 'node:latest' })).rejects.toThrow('digest-pinned')
    expect(assetDigest({ b: 2, a: 1 })).toBe(assetDigest({ a: 1, b: 2 }))
  })
})

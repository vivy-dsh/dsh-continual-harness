import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetDigest, SkillOwner } from '../src/skill-owner.ts'
import type { SkillCandidateInput } from '../src/skill-owner.ts'
import { renderSkillMarkdown } from '../src/skills.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }) })
function fixture(options: { skillsDir?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-owner-')); dirs.push(root)
  const owner = new SkillOwner(root, options.skillsDir === undefined ? {} : { skillsDir: options.skillsDir })
  const input: SkillCandidateInput = { skillId: 'test-skill', entry: { content: 'Run the trusted procedure.', description: 'Use when testing.' }, expectedDigest: null, subjectId: 'subject-one', ticketId: 'ticket-one', evidenceRefs: [{ sessionId: 's1', eventId: 'primary-e1' }], idempotencyKey: 'candidate-one' }
  const approve = (candidateId: string, expectedBundleDigest: string) => owner.decide({ candidateId, decision: 'approved', confirm: true, expectedBundleDigest })
  const publish = async (candidateId: string, idempotencyKey = 'publication-one') => {
    const candidate = owner.status({ candidateId }) as { bundleDigest: string }
    approve(candidateId, candidate.bundleDigest)
    return owner.publishCandidate({ candidateId, idempotencyKey, subjectId: input.subjectId })
  }
  return { root, owner, input, approve, publish }
}
describe('immutable SkillOwner gate', () => {
  it.skipIf(process.platform === 'win32')('makes the entire mounted bundle traversable by the reviewing user under umask 077', () => {
    const { owner, input } = fixture(), previous = process.umask(0o077)
    try {
      const candidate = owner.stageCandidate({ ...input, entry: { content: 'Procedure.', files: { 'scripts/nested/execute.sh': 'true' } } })
      const dir = owner.bundleDir(candidate.candidateId)
      expect(statSync(dir).mode & 0o777).toBe(0o755)
      expect(statSync(join(dir, 'scripts')).mode & 0o777).toBe(0o755)
      expect(statSync(join(dir, 'scripts', 'nested')).mode & 0o777).toBe(0o755)
    } finally { process.umask(previous) }
  })
  it('stages outside discovery and publishes nothing until a human decides', () => {
    const { owner, input } = fixture()
    const candidate = owner.stageCandidate(input)
    expect(owner.status({})).toEqual([])
    expect(owner.stageCandidate(input)).toEqual(candidate)
    // The review surface shows the exact body a human has to read.
    expect(owner.pending()).toEqual([expect.objectContaining({ candidateId: candidate.candidateId, skillId: 'test-skill', content: input.entry.content, description: 'Use when testing.', files: [], baselineDigest: null })])
    expect(owner.decision(candidate.candidateId)).toBeNull()
  })
  it('requires an explicit confirmation and the reviewed digest before recording a decision', () => {
    const { owner, input } = fixture(), candidate = owner.stageCandidate(input)
    expect(() => owner.decide({ candidateId: candidate.candidateId, decision: 'approved', confirm: false, expectedBundleDigest: candidate.bundleDigest })).toThrow('explicit human confirmation')
    expect(() => owner.decide({ candidateId: candidate.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: 'f'.repeat(64) })).toThrow('Reviewed digest')
    const decision = owner.decide({ candidateId: candidate.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: candidate.bundleDigest })
    expect(decision).toMatchObject({ candidateId: candidate.candidateId, decision: 'approved', bundleDigest: candidate.bundleDigest, actor: 'panel' })
    expect(owner.pending()).toEqual([])
  })
  it('refuses publication without an approved decision and after a rejection', () => {
    const { owner, input } = fixture(), candidate = owner.stageCandidate(input)
    expect(() => owner.publishCandidate({ candidateId: candidate.candidateId, idempotencyKey: 'pub', subjectId: input.subjectId })).toThrow('recorded human approval')
    owner.decide({ candidateId: candidate.candidateId, decision: 'rejected', confirm: true, expectedBundleDigest: candidate.bundleDigest })
    expect(() => owner.publishCandidate({ candidateId: candidate.candidateId, idempotencyKey: 'pub', subjectId: input.subjectId })).toThrow('recorded human approval')
    expect(owner.status({})).toEqual([])
  })
  it('keeps one decision per candidate and one publication per approval', async () => {
    const { owner, input, publish } = fixture()
    const candidate = owner.stageCandidate(input), publication = await publish(candidate.candidateId)
    expect(publication.bundleDigest).toEqual(candidate.bundleDigest)
    expect(() => owner.decide({ candidateId: candidate.candidateId, decision: 'rejected', confirm: true, expectedBundleDigest: candidate.bundleDigest })).toThrow('already decided')
    expect(owner.status({ idempotencyKey: 'publication-one' })).toEqual(publication)
    expect(owner.status({ idempotencyKey: 'unknown' })).toBeNull()
    // A second idempotency key cannot spend the same approval again.
    expect(() => owner.publishCandidate({ candidateId: candidate.candidateId, idempotencyKey: 'publication-two', subjectId: input.subjectId })).toThrow('already used for another publication')
  })
  it('rejects a decision that was recorded for a different bundle', () => {
    const { owner, input } = fixture(), first = owner.stageCandidate(input), second = owner.stageCandidate({ ...input, entry: { content: 'Other procedure.' }, idempotencyKey: 'candidate-two' })
    owner.decide({ candidateId: first.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: first.bundleDigest })
    expect(() => owner.publishCandidate({ candidateId: second.candidateId, idempotencyKey: 'pub-two', subjectId: input.subjectId })).toThrow('recorded human approval')
  })
  it('conflicts on the baseline instead of overwriting a newer live version', async () => {
    const { owner, input, publish } = fixture(), first = await publish(owner.stageCandidate(input).candidateId)
    expect(() => owner.stageCandidate({ ...input, idempotencyKey: 'stale-update' })).toThrow('baseline conflict')
    const next = owner.stageCandidate({ ...input, expectedDigest: first.bundleDigest, entry: { content: 'The new procedure.' }, idempotencyKey: 'second' })
    expect(next.baselineDigest).toBe(first.bundleDigest)
  })
  it('pins already-listed bodies and resources to their immutable version', async () => {
    const { owner, input, publish } = fixture(), first = await publish(owner.stageCandidate(input).candidateId)
    const provider = owner.provider({ invalidate() {} }), old = (await provider.list())[0]!
    expect(old.rank).toBe(390) // Project/custom user roots retain their established precedence.
    const next = owner.stageCandidate({ ...input, expectedDigest: first.bundleDigest, entry: { content: 'The new procedure.' }, idempotencyKey: 'second' })
    await publish(next.candidateId, 'second-pub')
    expect((await provider.get(old)).content).toBe(input.entry.content)
    expect((await provider.get((await provider.list())[0]!)).content).toBe('The new procedure.')
    expect(old.resourceBase.path).toContain(first.bundleDigest)
  })
  it('rolls back through the same candidate and approval gate', async () => {
    const { owner, input, publish } = fixture(), original = await publish(owner.stageCandidate(input).candidateId)
    const update = owner.stageCandidate({ ...input, expectedDigest: original.bundleDigest, entry: { content: 'Changed procedure.' }, idempotencyKey: 'update' })
    const updated = await publish(update.candidateId, 'update-pub')
    const rollback = owner.stageRollback({ ...input, expectedDigest: updated.bundleDigest, rollbackOf: original.publicationId, idempotencyKey: 'rollback' })
    expect(owner.currentDigest(input.skillId)).toBe(updated.bundleDigest)
    const restored = await publish(rollback.candidateId, 'rollback-pub')
    expect(restored.version).toBe(3)
    expect(restored.bundleDigest).toBe(original.bundleDigest)
    expect(restored.rollbackOf).toBe(original.publicationId)
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
    const owner = new SkillOwner(ownerRoot, { skillsDir })
    expect(owner.migrateLegacy([entry, { ...entry, id: 'user-skill' }])).toEqual(['old-skill'])
    expect(owner.currentDigest('old-skill')).not.toBeNull()
    expect(readFileSync(userFile, 'utf8')).toBe('User content')
    expect(() => owner.stageCandidate({ skillId: 'user-skill', entry: { content: 'overwrite' }, expectedDigest: null, subjectId: 's', ticketId: 't', evidenceRefs: ['e'], idempotencyKey: 'x' })).toThrow('migrated by its owner')
    expect(existsSync(join(skillsDir, 'old-skill', 'SKILL.md'))).toBe(true)
  })
  it('keeps canonical digest order independent of key order', () => {
    expect(assetDigest({ b: 2, a: 1 })).toBe(assetDigest({ a: 1, b: 2 }))
  })
  it('commits the publication and the decision together, so a failed publish records nothing', () => {
    const { owner, input } = fixture()
    const first = owner.stageCandidate(input)
    const second = owner.stageCandidate({ ...input, entry: { content: 'Second procedure.' }, idempotencyKey: 'candidate-two' })
    const approved = owner.decideAndPublish({
      candidateId: first.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: first.bundleDigest,
      idempotencyKey: `panel:${first.candidateId}`, subjectId: input.subjectId,
    })
    expect(approved.publication).toMatchObject({ skillId: 'test-skill', version: 1 })
    expect(approved.decision).toMatchObject({ candidateId: first.candidateId, decision: 'approved' })
    // The second candidate was staged against "no live version"; the first approval made it stale.
    expect(() => owner.decideAndPublish({
      candidateId: second.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: second.bundleDigest,
      idempotencyKey: `panel:${second.candidateId}`, subjectId: input.subjectId,
    })).toThrow('baseline conflict')
    expect(owner.decision(second.candidateId)).toBeNull()
    expect(owner.pending().map(item => item.candidateId)).toContain(second.candidateId)
  })
  it('rebuilds a lost decision receipt from the publication instead of publishing twice', () => {
    const { owner, input } = fixture()
    const candidate = owner.stageCandidate(input)
    const args = { candidateId: candidate.candidateId, decision: 'approved' as const, confirm: true, expectedBundleDigest: candidate.bundleDigest, idempotencyKey: `panel:${candidate.candidateId}`, subjectId: input.subjectId }
    const first = owner.decideAndPublish(args)
    rmSync(join(owner.root, 'decisions', `${candidate.candidateId}.json`))
    const replay = owner.decideAndPublish(args)
    expect(replay.publication?.publicationId).toBe(first.publication!.publicationId)
    expect(replay.decision.decision).toBe('approved')
    expect((owner.status({}) as unknown[]).length).toBe(1)
  })
  it('lists decided candidates with the publication they produced, including rejected alone', () => {
    const { owner, input } = fixture()
    const approved = owner.stageCandidate(input)
    const rejected = owner.stageCandidate({ ...input, entry: { content: 'Rejected procedure.' }, idempotencyKey: 'candidate-two' })
    owner.decideAndPublish({ candidateId: approved.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: approved.bundleDigest, idempotencyKey: `panel:${approved.candidateId}`, subjectId: input.subjectId })
    owner.decideAndPublish({ candidateId: rejected.candidateId, decision: 'rejected', confirm: true, expectedBundleDigest: rejected.bundleDigest, idempotencyKey: `panel:${rejected.candidateId}`, subjectId: input.subjectId })
    const history = owner.decisions()
    expect(history.map(item => [item.decision, item.publication?.version ?? null])).toEqual(expect.arrayContaining([['approved', 1], ['rejected', null]]))
    expect(owner.pending()).toEqual([])
  })
  it('shows the reviewer the rendered bundle, the baseline it changes, and where it came from', () => {
    const { owner, input } = fixture()
    const candidate = owner.stageCandidate(input)
    const published = owner.decideAndPublish({ candidateId: candidate.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: candidate.bundleDigest, idempotencyKey: `panel:${candidate.candidateId}`, subjectId: input.subjectId })
    owner.stageCandidate({ ...input, expectedDigest: published.publication!.bundleDigest, entry: { content: 'Updated procedure.', files: { 'scripts/run.sh': 'echo hi' } }, idempotencyKey: 'candidate-two' })
    const pending = owner.pending().find(item => item.skillId === 'test-skill')!
    expect(pending.bundle.map(file => file.name).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(pending.baselineBundle?.map(file => file.name)).toEqual(['SKILL.md'])
    expect(pending.ticketId).toBe('ticket-one')
    expect(pending.subjectId).toBe('subject-one')
    expect(pending.evidenceRefs[0]).toMatchObject({ sessionId: 's1', eventId: 'primary-e1' })
  })
  it('names the previous publication as the rollback target', () => {
    const { owner, input } = fixture()
    const first = owner.stageCandidate(input)
    const published = owner.decideAndPublish({ candidateId: first.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: first.bundleDigest, idempotencyKey: `panel:${first.candidateId}`, subjectId: input.subjectId })
    const second = owner.stageCandidate({ ...input, expectedDigest: published.publication!.bundleDigest, entry: { content: 'Updated procedure.' }, idempotencyKey: 'candidate-two' })
    owner.decideAndPublish({ candidateId: second.candidateId, decision: 'approved', confirm: true, expectedBundleDigest: second.bundleDigest, idempotencyKey: `panel:${second.candidateId}`, subjectId: input.subjectId })
    expect(owner.previousPublication('test-skill')?.publicationId).toBe(published.publication!.publicationId)
  })
})

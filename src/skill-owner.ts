/** Immutable skill assets. Only this owner can promote runner-validated candidates. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isHarnessOwnedBundle, referencedFilePaths, renderSkillMarkdown, validateBundleFiles } from './skills.ts'

export interface SkillAsset { content: string; description?: string; files?: Record<string, string> }
export interface SkillCandidateInput {
  skillId: string; entry: SkillAsset; expectedDigest: string | null; subjectId: string; ticketId: string
  evidenceRefs: unknown[]; idempotencyKey: string
  rollbackOf?: string
}
export interface OwnerCandidate extends SkillCandidateInput {
  candidateId: string; bundleDigest: string; baselineDigest: string | null; status: 'staged'
}
export interface OwnerPublication {
  skillId: string; publicationId: string; version: number; bundleDigest: string; baselineDigest: string | null
  candidateId: string; receiptId: string; idempotencyKey: string
  rollbackOf?: string
}
export interface ValidationCase { id: string; command: string[] }
export interface ValidationSuite {
  policyVersion: string; image: string; platform: 'linux'; timeoutMs: number
  mandatory: ValidationCase[]; holdout: ValidationCase[]
}
export interface ValidationReceipt {
  candidateId: string; receiptId?: string; status: 'passed' | 'blocked' | 'rejected'; reason?: string
  bundleDigest: string; baselineDigest: string | null; testSuiteDigest: string; runnerEnvironmentDigest: string
  policyVersion: string
  signature?: string
}
export type TicketAuthorizer = (request: { ticketId: string; subjectId: string; skillId: string; scope: 'skill:publish'; candidateId: string; bundleDigest: string; entryDigest: string; expectedDigest: string | null; evidenceRefs: unknown[] }) => Promise<boolean>
export interface IsolatedResult { score: number; completed: boolean }
/** This capability is supplied only by deployment code, never by candidate/IPC request bodies. */
export interface IsolatedRunner {
  environmentDigest(suite: ValidationSuite): Promise<string>
  run(suite: ValidationSuite, test: ValidationCase, bundleDir: string): Promise<IsolatedResult>
}
export function assetDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'SKILL_OWNER_BLOCKED' }) }
function json<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T }
function atomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temp, path)
}
function immutable(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o400 })
}
function safeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('Invalid skill id') }
function fileId(value: string): string { if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('Invalid owner reference'); return value }
function assertAsset(asset: SkillAsset): void {
  if (!asset || typeof asset.content !== 'string' || !asset.content.trim()) fail('Skill body is empty')
  if (asset.description !== undefined && typeof asset.description !== 'string') fail('Invalid description')
  if (Buffer.byteLength(asset.content) > 1024 * 1024) fail('Skill body exceeds limit')
  const error = validateBundleFiles(asset.files ?? {}); if (error) fail(error)
  for (const file of referencedFilePaths(asset.content)) if (!(file in (asset.files ?? {}))) fail(`Referenced bundle resource is missing: ${file}`)
}
function bundleFiles(skillId: string, entry: SkillAsset): Record<string, string> {
  return { 'SKILL.md': renderSkillMarkdown({ id: skillId, kind: 'skill', version: 1, updatedAt: '', ...entry }), ...entry.files }
}
function writeBundle(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  chmodSync(dir, 0o755)
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name); mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body, { flag: 'wx', mode: 0o444 }); chmodSync(path, 0o444)
  }
  const traverse = (path: string): void => {
    chmodSync(path, 0o755)
    for (const name of readdirSync(path)) if (lstatSync(join(path, name)).isDirectory()) traverse(join(path, name))
  }
  traverse(dir)
}
function readBundle(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path), key = prefix ? `${prefix}/${name}` : name
    if (stat.isSymbolicLink()) fail('Owner bundle contains a symbolic link')
    if (stat.isDirectory()) Object.assign(result, readBundle(path, key))
    else if (stat.isFile()) result[key] = readFileSync(path, 'utf8')
    else fail('Owner bundle contains an unsupported file')
  }
  return result
}
async function command(args: string[], timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = '', size = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated runner timed out')) }, timeout)
    child.stdout.on('data', data => { size += data.length; if (size > 1024 * 1024) { child.kill(); reject(new Error('Runner output limit exceeded')) } else output += String(data) })
    child.stderr.on('data', data => { if (error.length < 4096) error += String(data) })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolvePromise(output); else reject(new Error(`Isolated runner failed (${code}): ${error}`)) })
  })
}
/** No host execution fallback. An unavailable daemon/image/platform is blocked. */
export class OciSkillRunner implements IsolatedRunner {
  async environmentDigest(suite: ValidationSuite): Promise<string> {
    if (suite.platform !== 'linux' || !/@sha256:[a-f0-9]{64}$/.test(suite.image)) fail('A digest-pinned Linux OCI image is required')
    const image = await command(['image', 'inspect', suite.image, '--format', '{{.Id}} {{.Os}} {{.Architecture}}'], 10_000)
    if (!image.includes(' linux ')) fail('Matching isolated runner is unavailable')
    return assetDigest({ image: image.trim(), isolation: 'oci-readonly-nonet-nocaps-v1' })
  }
  async run(suite: ValidationSuite, test: ValidationCase, bundleDir: string): Promise<IsolatedResult> {
    const name = `dsh-skill-${randomUUID()}`
    try {
      const output = await command(['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1', '--user=65534:65534',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/output:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,source=${resolve(bundleDir)},target=/skill,readonly`, '--workdir=/output', suite.image, ...test.command], suite.timeoutMs)
      const result = JSON.parse(output.trim()) as IsolatedResult
      if (result.completed !== true || typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score < 0 || result.score > 1) fail('Runner result is incomplete or invalid')
      return { completed: true, score: result.score }
    } finally { await command(['rm', '-f', name], 5_000).catch(() => {}) }
  }
}

/** State is outside all skill discovery roots. Bundle checks bind every read to its frozen digest. */
export class SkillOwner {
  private readonly runner: IsolatedRunner
  private readonly signingKey = randomBytes(32)
  private invalidate: () => void = () => {}
  constructor(readonly root: string, private readonly authorize: TicketAuthorizer, options: { runner?: IsolatedRunner; skillsDir?: string } = {}) {
    this.runner = options.runner ?? new OciSkillRunner(); this.skillsDir = options.skillsDir
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  private readonly skillsDir: string | undefined
  private database(): { live: Record<string, OwnerPublication>; publications: Record<string, OwnerPublication>; keys: Record<string, string> } {
    const p = join(this.root, 'owner-state.json'); return existsSync(p) ? json(p) : { live: {}, publications: {}, keys: {} }
  }
  private current(): Record<string, OwnerPublication> { return this.database().live }
  currentDigest(skillId: string): string | null { return this.current()[skillId]?.bundleDigest ?? null }
  /** Adopt only byte-identical bundles bearing the existing author's full marker.
   * This preserves active legacy assets; it never upgrades or validates their content.
   */
  migrateLegacy(entries: readonly (SkillAsset & { id: string })[]): string[] {
    if (!this.skillsDir) return []
    return this.locked(() => {
      const db = this.database(), migrated: string[] = []
      for (const entry of entries) {
        if (db.live[entry.id] || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) continue
        const dir = join(this.skillsDir!, entry.id), path = join(dir, 'SKILL.md')
        if (!existsSync(path) || lstatSync(dir).isSymbolicLink() || !isHarnessOwnedBundle(readFileSync(path, 'utf8'))) continue
        try {
          assertAsset(entry)
          const files = readBundle(dir), bundleDigest = assetDigest(files)
          if (bundleDigest !== assetDigest(bundleFiles(entry.id, entry))) continue
          const asset: SkillAsset = { content: entry.content, ...(entry.description === undefined ? {} : { description: entry.description }), ...(entry.files === undefined ? {} : { files: entry.files }) }
          const candidate: OwnerCandidate = { skillId: entry.id, entry: asset, expectedDigest: null, subjectId: 'legacy-owner-migration', ticketId: 'legacy-owner-migration', evidenceRefs: [{ kind: 'legacy-owned-bundle', bundleDigest }], idempotencyKey: `migration:${entry.id}`, candidateId: randomUUID(), bundleDigest, baselineDigest: null, status: 'staged' }
          const candidateDir = join(this.root, 'candidates', candidate.candidateId)
          writeBundle(join(candidateDir, 'bundle'), files); immutable(join(candidateDir, 'candidate.json'), candidate)
          const versionDir = join(this.root, 'versions', bundleDigest)
          if (!existsSync(versionDir)) writeBundle(versionDir, files)
          const publication: OwnerPublication = { skillId: entry.id, publicationId: randomUUID(), version: 1, bundleDigest, baselineDigest: null, candidateId: candidate.candidateId, receiptId: 'legacy-retained-not-validated', idempotencyKey: candidate.idempotencyKey }
          db.live[entry.id] = publication; db.publications[publication.publicationId] = publication
          migrated.push(entry.id)
        } catch { /* A malformed, changed, or user-owned bundle stays entirely untouched. */ }
      }
      if (migrated.length) { atomic(join(this.root, 'owner-state.json'), db); this.invalidate() }
      return migrated
    })
  }
  matchesLive(skillId: string, entry: SkillAsset): boolean { return this.currentDigest(skillId) === assetDigest(bundleFiles(skillId, entry)) }
  private sign(receipt: ValidationReceipt): string {
    const { signature: _, ...body } = receipt
    return createHmac('sha256', this.signingKey).update(assetDigest(body)).digest('hex')
  }
  private locked<T>(run: () => T): T {
    const lock = join(this.root, 'write.lock')
    try { mkdirSync(lock) } catch { fail('Owner is busy; retry after inspecting status') }
    try { return run() } finally { rmSync(lock, { recursive: true }) }
  }
  private candidate(id: string): OwnerCandidate {
    const candidate = json<OwnerCandidate>(join(this.root, 'candidates', fileId(id), 'candidate.json'))
    assertAsset(candidate.entry)
    if (candidate.candidateId !== id || assetDigest(bundleFiles(candidate.skillId, candidate.entry)) !== candidate.bundleDigest) fail('Candidate metadata digest mismatch')
    if (assetDigest(readBundle(this.bundleDir(candidate.candidateId))) !== candidate.bundleDigest) fail('Candidate bundle digest mismatch')
    return candidate
  }
  bundleDir(candidateId: string): string { return join(this.root, 'candidates', fileId(candidateId), 'bundle') }
  stageCandidate(input: SkillCandidateInput): OwnerCandidate {
    safeId(input.skillId); assertAsset(input.entry)
    if (!input.subjectId || !input.ticketId || !input.idempotencyKey || !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) fail('Candidate requires subject, ticket, idempotency and original evidence references')
    if (input.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedDigest)) fail('Explicit baseline digest or null is required')
    return this.locked(() => {
      const key = assetDigest(input.idempotencyKey), index = join(this.root, 'stage-keys', `${key}.json`)
      if (existsSync(index)) {
        const prior = this.candidate(json<{ candidateId: string }>(index).candidateId)
        if (assetDigest(input) !== assetDigest(Object.fromEntries(Object.entries(prior).filter(([k]) => !['candidateId', 'bundleDigest', 'baselineDigest', 'status'].includes(k))))) fail('Idempotency key reused for different candidate')
        return prior
      }
      const live = this.current()[input.skillId]
      if ((live?.bundleDigest ?? null) !== input.expectedDigest) fail('Skill baseline conflict')
      if (!live && this.skillsDir && existsSync(join(this.skillsDir, input.skillId))) fail('Existing filesystem skill must be migrated by its owner before modification')
      const files = bundleFiles(input.skillId, input.entry)
      if (input.rollbackOf) {
        const prior = this.database().publications[fileId(input.rollbackOf)]
        if (!prior || prior.skillId !== input.skillId || prior.bundleDigest !== assetDigest(files)) fail('Rollback must exactly restore an immutable owner publication')
      }
      const candidate: OwnerCandidate = { ...structuredClone(input), candidateId: randomUUID(), bundleDigest: assetDigest(files), baselineDigest: input.expectedDigest, status: 'staged' }
      const dir = join(this.root, 'candidates', candidate.candidateId)
      writeBundle(join(dir, 'bundle'), files); immutable(join(dir, 'candidate.json'), candidate)
      immutable(index, { candidateId: candidate.candidateId }); return candidate
    })
  }
  /** Rollback is another candidate, never a direct pointer edit or a validation bypass. */
  stageRollback(input: Omit<SkillCandidateInput, 'entry'> & { rollbackOf: string }): OwnerCandidate {
    const prior = this.database().publications[fileId(input.rollbackOf)]
    if (!prior || prior.skillId !== input.skillId) fail('Rollback publication not found for this skill')
    const source = this.candidate(prior.candidateId)
    return this.stageCandidate({ ...input, entry: structuredClone(source.entry) })
  }
  private suite(): ValidationSuite {
    const suite = json<ValidationSuite>(join(this.root, 'validation-suite.json'))
    if (!suite.policyVersion || !Number.isFinite(suite.timeoutMs) || suite.timeoutMs < 1 || !suite.mandatory?.length || !suite.holdout?.length) fail('Independent mandatory and frozen holdout cases are required')
    const ids = new Set<string>()
    for (const row of [...suite.mandatory, ...suite.holdout]) {
      if (!row.id || ids.has(row.id) || !row.command?.length || row.command.some(x => typeof x !== 'string')) fail('Malformed or duplicate validation case')
      ids.add(row.id)
    }
    return suite
  }
  async validateCandidate(candidateId: string): Promise<ValidationReceipt> {
    const candidate = this.candidate(candidateId)
    let suiteDigest = '', environment = '', policy = ''
    try {
      const suite = this.suite(); suiteDigest = assetDigest(suite); policy = suite.policyVersion
      // Freeze the owner-controlled suite before execution. Candidate authors never supply cases or expected results.
      const frozen = join(this.root, 'suites', `${suiteDigest}.json`)
      if (!existsSync(frozen)) immutable(frozen, suite)
      environment = await this.runner.environmentDigest(suite)
      const current = this.current()[candidate.skillId]
      if ((current?.bundleDigest ?? null) !== candidate.baselineDigest) fail('Baseline changed before validation')
      const baselineDir = current ? join(this.root, 'versions', current.bundleDigest) : join(this.root, 'empty-baseline')
      if (!current) { mkdirSync(baselineDir, { recursive: true, mode: 0o755 }); chmodSync(baselineDir, 0o755) }
      if (current && assetDigest(readBundle(baselineDir)) !== current.bundleDigest) fail('Baseline bundle digest mismatch')
      const run = async (test: ValidationCase, dir: string) => {
        const result = await this.runner.run(suite, test, dir)
        if (result.completed !== true || !Number.isFinite(result.score) || result.score < 0 || result.score > 1) fail('Runner result is incomplete or invalid')
        return result
      }
      for (const test of suite.mandatory) {
        const result = await run(test, this.bundleDir(candidateId))
        if (!result.completed || result.score !== 1) return this.validation(candidate, 'rejected', suiteDigest, environment, policy, `Mandatory case failed: ${test.id}`)
      }
      for (const test of suite.holdout) {
        const before = await run(test, baselineDir)
        const after = await run(test, this.bundleDir(candidateId))
        if (!before.completed || !after.completed || !Number.isFinite(before.score) || !Number.isFinite(after.score)) fail('Holdout result is inconclusive')
        if (after.score < before.score) return this.validation(candidate, 'rejected', suiteDigest, environment, policy, `Holdout regression: ${test.id}`)
      }
      this.candidate(candidateId)
      return this.validation(candidate, 'passed', suiteDigest, environment, policy)
    } catch (error) {
      return this.validation(candidate, 'blocked', suiteDigest, environment, policy, error instanceof Error ? error.message : String(error))
    }
  }
  private validation(candidate: OwnerCandidate, status: ValidationReceipt['status'], testSuiteDigest: string, runnerEnvironmentDigest: string, policyVersion: string, reason?: string): ValidationReceipt {
    const receipt: ValidationReceipt = { candidateId: candidate.candidateId, receiptId: randomUUID(), status, bundleDigest: candidate.bundleDigest, baselineDigest: candidate.baselineDigest, testSuiteDigest, runnerEnvironmentDigest, policyVersion, ...(reason ? { reason } : {}) }
    receipt.signature = this.sign(receipt)
    immutable(join(this.root, 'validations', `${receipt.receiptId}.json`), receipt); return receipt
  }
  async publishCandidate(input: { candidateId: string; receiptId: string; idempotencyKey: string; ticketId: string; subjectId: string }): Promise<OwnerPublication> {
    const candidate = this.candidate(input.candidateId)
    if (candidate.subjectId !== input.subjectId || candidate.ticketId !== input.ticketId || !input.idempotencyKey) fail('Publication identity mismatch')
    if (!await this.authorize({ ticketId: input.ticketId, subjectId: input.subjectId, skillId: candidate.skillId, scope: 'skill:publish', candidateId: candidate.candidateId, bundleDigest: candidate.bundleDigest, entryDigest: assetDigest(candidate.entry), expectedDigest: candidate.expectedDigest, evidenceRefs: structuredClone(candidate.evidenceRefs) })) fail('Ticket is not currently authorized for this asset')
    return this.locked(() => {
      const database = this.database(), key = assetDigest(input.idempotencyKey)
      const priorId = database.keys[key]
      if (priorId) {
        const prior = database.publications[priorId]!
        if (prior.candidateId !== input.candidateId || prior.receiptId !== input.receiptId) fail('Publication idempotency conflict')
        return prior
      }
      const receipt = json<ValidationReceipt>(join(this.root, 'validations', `${fileId(input.receiptId)}.json`))
      if (receipt.signature !== this.sign(receipt) || receipt.status !== 'passed' || receipt.candidateId !== candidate.candidateId || receipt.bundleDigest !== candidate.bundleDigest || receipt.baselineDigest !== candidate.baselineDigest || !receipt.runnerEnvironmentDigest || receipt.testSuiteDigest !== assetDigest(this.suite())) fail('Trusted validation receipt does not match current policy and candidate; revalidate after owner restart')
      this.candidate(candidate.candidateId)
      const live = database.live, previous = live[candidate.skillId]
      if ((previous?.bundleDigest ?? null) !== candidate.baselineDigest) fail('Skill baseline conflict')
      if (this.skillsDir && existsSync(join(this.skillsDir, candidate.skillId, 'SKILL.md')) && !isHarnessOwnedBundle(readFileSync(join(this.skillsDir, candidate.skillId, 'SKILL.md'), 'utf8'))) fail('A user-owned skill now occupies this name')
      const versionDir = join(this.root, 'versions', candidate.bundleDigest)
      if (!existsSync(versionDir)) writeBundle(versionDir, readBundle(this.bundleDir(candidate.candidateId)))
      if (assetDigest(readBundle(versionDir)) !== candidate.bundleDigest) fail('Immutable version digest mismatch')
      const publication: OwnerPublication = { skillId: candidate.skillId, publicationId: randomUUID(), version: (previous?.version ?? 0) + 1, bundleDigest: candidate.bundleDigest, baselineDigest: candidate.baselineDigest, candidateId: candidate.candidateId, receiptId: input.receiptId, idempotencyKey: input.idempotencyKey, ...(candidate.rollbackOf ? { rollbackOf: candidate.rollbackOf } : {}) }
      // Receipt, idempotency result and live pointer commit in one atomic database replacement.
      database.publications[publication.publicationId] = publication
      database.keys[key] = publication.publicationId; live[candidate.skillId] = publication
      atomic(join(this.root, 'owner-state.json'), database)
      this.invalidate(); return publication
    })
  }
  status(query: { candidateId?: string; publicationId?: string; idempotencyKey?: string }): unknown {
    if (query.candidateId) return this.candidate(query.candidateId)
    if (query.publicationId) return this.database().publications[fileId(query.publicationId)] ?? null
    if (query.idempotencyKey) { const db = this.database(); return db.publications[db.keys[assetDigest(query.idempotencyKey)] ?? ''] ?? null }
    return Object.values(this.current())
  }
  /** Locators pin the body and all relative resources to the same immutable version. */
  provider(control: { invalidate(): void }) {
    this.invalidate = () => control.invalidate()
    return {
      name: 'harness-owner',
      list: async () => Object.values(this.current()).map(publication => {
        const candidate = this.candidate(publication.candidateId), dir = join(this.root, 'versions', publication.bundleDigest)
        return { name: publication.skillId, description: candidate.entry.description ?? '', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'harness-owner', resourceBase: { kind: 'directory' as const, path: dir }, path: join(dir, 'SKILL.md'), rank: 390, locator: publication }
      }),
      get: async (item: { locator: unknown }) => {
        const publication = item.locator as OwnerPublication, candidate = this.candidate(publication.candidateId), dir = join(this.root, 'versions', publication.bundleDigest)
        if (assetDigest(readBundle(dir)) !== publication.bundleDigest) fail('Immutable skill version was modified')
        return { name: publication.skillId, description: candidate.entry.description ?? '', content: candidate.entry.content, invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'harness-owner', resourceBase: { kind: 'directory' as const, path: dir }, path: join(dir, 'SKILL.md') }
      },
    }
  }
}

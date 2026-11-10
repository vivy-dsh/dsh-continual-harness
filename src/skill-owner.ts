/** Immutable skill assets. A human approves a staged candidate; only this owner can make one live. */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isHarnessOwnedBundle, referencedFilePaths, renderSkillMarkdown, validateBundleFiles } from './skills.ts'

export interface SkillAsset { content: string; description?: string; files?: Record<string, string> }
export interface SkillCandidateInput {
  skillId: string; entry: SkillAsset; expectedDigest: string | null; subjectId: string; ticketId: string
  evidenceRefs: unknown[]; idempotencyKey: string
  rollbackOf?: string
}
export interface OwnerCandidate extends SkillCandidateInput {
  candidateId: string; bundleDigest: string; baselineDigest: string | null; status: 'staged'; stagedAt: string
}
/** The only promotion authority: one recorded human decision per candidate. */
export type DecisionKind = 'approved' | 'rejected'
export interface OwnerDecision {
  candidateId: string; decision: DecisionKind; bundleDigest: string; decidedAt: string; actor: 'panel'
}
export interface OwnerPublication {
  skillId: string; publicationId: string; version: number; bundleDigest: string; baselineDigest: string | null
  candidateId: string; decisionDigest: string; idempotencyKey: string
  rollbackOf?: string
}
/** One staged candidate as a human reviewer sees it: the body is the review material. */
export interface PendingCandidate {
  candidateId: string; skillId: string; bundleDigest: string; baselineDigest: string | null
  description: string; files: string[]; content: string; stagedAt: string
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

/** State is outside all skill discovery roots. Bundle checks bind every read to its frozen digest. */
export class SkillOwner {
  private readonly skillsDir: string | undefined
  constructor(readonly root: string, options: { skillsDir?: string } = {}) {
    this.skillsDir = options.skillsDir
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
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
          const candidate: OwnerCandidate = { skillId: entry.id, entry: asset, expectedDigest: null, subjectId: 'legacy-owner-migration', ticketId: 'legacy-owner-migration', evidenceRefs: [{ kind: 'legacy-owned-bundle', bundleDigest }], idempotencyKey: `migration:${entry.id}`, candidateId: randomUUID(), bundleDigest, baselineDigest: null, status: 'staged', stagedAt: new Date(0).toISOString() }
          const candidateDir = join(this.root, 'candidates', candidate.candidateId)
          writeBundle(join(candidateDir, 'bundle'), files); immutable(join(candidateDir, 'candidate.json'), candidate)
          const versionDir = join(this.root, 'versions', bundleDigest)
          if (!existsSync(versionDir)) writeBundle(versionDir, files)
          const publication: OwnerPublication = { skillId: entry.id, publicationId: randomUUID(), version: 1, bundleDigest, baselineDigest: null, candidateId: candidate.candidateId, decisionDigest: 'legacy-adopted', idempotencyKey: candidate.idempotencyKey }
          db.live[entry.id] = publication; db.publications[publication.publicationId] = publication
          migrated.push(entry.id)
        } catch { /* A malformed, changed, or user-owned bundle stays entirely untouched. */ }
      }
      if (migrated.length) { atomic(join(this.root, 'owner-state.json'), db); this.invalidate() }
      return migrated
    })
  }
  matchesLive(skillId: string, entry: SkillAsset): boolean { return this.currentDigest(skillId) === assetDigest(bundleFiles(skillId, entry)) }
  private invalidate: () => void = () => {}
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
  private decisionFile(candidateId: string): string { return join(this.root, 'decisions', `${fileId(candidateId)}.json`) }
  /** The recorded human decision, or null while the candidate still waits for review. */
  decision(candidateId: string): OwnerDecision | null {
    const path = this.decisionFile(candidateId)
    return existsSync(path) ? json<OwnerDecision>(path) : null
  }
  /**
   * Record one human review outcome. `confirm: true` and the reviewed bundle
   * digest are both required, so a click that never saw this bundle cannot
   * approve it. A second, different decision is refused instead of overwritten.
   */
  decide(input: { candidateId: string; decision: DecisionKind; confirm: boolean; expectedBundleDigest: string }): OwnerDecision {
    if (input.decision !== 'approved' && input.decision !== 'rejected') fail('Decision must be approved or rejected')
    if (input.confirm !== true) fail('An explicit human confirmation is required')
    return this.locked(() => {
      const candidate = this.candidate(input.candidateId)
      if (input.expectedBundleDigest !== candidate.bundleDigest) fail('Reviewed digest does not match the staged candidate')
      const existing = this.decision(candidate.candidateId)
      if (existing) {
        if (existing.decision !== input.decision) fail('Candidate already decided; a new candidate is required')
        return existing
      }
      const decision: OwnerDecision = { candidateId: candidate.candidateId, decision: input.decision, bundleDigest: candidate.bundleDigest, decidedAt: new Date().toISOString(), actor: 'panel' }
      immutable(this.decisionFile(candidate.candidateId), decision)
      return decision
    })
  }
  /** Staged candidates with no decision yet: exactly what a reviewer still has to look at. */
  pending(): PendingCandidate[] {
    const directory = join(this.root, 'candidates')
    if (!existsSync(directory)) return []
    const result: PendingCandidate[] = []
    for (const name of readdirSync(directory)) {
      if (lstatSync(join(directory, name)).isSymbolicLink()) continue
      let candidate: OwnerCandidate
      try { candidate = this.candidate(name) } catch { continue }
      if (this.decision(candidate.candidateId)) continue
      result.push({
        candidateId: candidate.candidateId, skillId: candidate.skillId, bundleDigest: candidate.bundleDigest,
        baselineDigest: candidate.baselineDigest, description: candidate.entry.description ?? '',
        files: Object.keys(candidate.entry.files ?? {}), content: candidate.entry.content, stagedAt: candidate.stagedAt,
      })
    }
    return result.sort((a, b) => a.stagedAt.localeCompare(b.stagedAt))
  }
  stageCandidate(input: SkillCandidateInput): OwnerCandidate {
    safeId(input.skillId); assertAsset(input.entry)
    if (!input.subjectId || !input.ticketId || !input.idempotencyKey || !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) fail('Candidate requires subject, ticket, idempotency and original evidence references')
    if (input.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedDigest)) fail('Explicit baseline digest or null is required')
    return this.locked(() => {
      const key = assetDigest(input.idempotencyKey), index = join(this.root, 'stage-keys', `${key}.json`)
      if (existsSync(index)) {
        const prior = this.candidate(json<{ candidateId: string }>(index).candidateId)
        if (assetDigest(input) !== assetDigest(Object.fromEntries(Object.entries(prior).filter(([k]) => !['candidateId', 'bundleDigest', 'baselineDigest', 'status', 'stagedAt'].includes(k))))) fail('Idempotency key reused for different candidate')
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
      const candidate: OwnerCandidate = { ...structuredClone(input), candidateId: randomUUID(), bundleDigest: assetDigest(files), baselineDigest: input.expectedDigest, status: 'staged', stagedAt: new Date().toISOString() }
      const dir = join(this.root, 'candidates', candidate.candidateId)
      writeBundle(join(dir, 'bundle'), files); immutable(join(dir, 'candidate.json'), candidate)
      immutable(index, { candidateId: candidate.candidateId }); return candidate
    })
  }
  /** Rollback is another candidate and the same human decision, never a direct pointer edit. */
  stageRollback(input: Omit<SkillCandidateInput, 'entry'> & { rollbackOf: string }): OwnerCandidate {
    const prior = this.database().publications[fileId(input.rollbackOf)]
    if (!prior || prior.skillId !== input.skillId) fail('Rollback publication not found for this skill')
    const source = this.candidate(prior.candidateId)
    return this.stageCandidate({ ...input, entry: structuredClone(source.entry) })
  }
  /**
   * Commit an approved candidate. Publication authority is the recorded human
   * decision bound to this exact bundle digest, plus the baseline CAS check;
   * there is no validation runner and no Ticket requirement on this path.
   */
  publishCandidate(input: { candidateId: string; idempotencyKey: string; subjectId: string }): OwnerPublication {
    const candidate = this.candidate(input.candidateId)
    if (candidate.subjectId !== input.subjectId || !input.idempotencyKey) fail('Publication identity mismatch')
    const decision = this.decision(candidate.candidateId)
    if (!decision || decision.decision !== 'approved') fail('A recorded human approval is required before publication')
    const decisionDigest = assetDigest(decision)
    if (decision.bundleDigest !== candidate.bundleDigest) fail('Approved digest does not match this candidate')
    return this.locked(() => {
      const database = this.database(), key = assetDigest(input.idempotencyKey)
      const priorId = database.keys[key]
      if (priorId) {
        const prior = database.publications[priorId]!
        if (prior.candidateId !== input.candidateId || prior.decisionDigest !== decisionDigest) fail('Publication idempotency conflict')
        return prior
      }
      this.candidate(candidate.candidateId)
      if (Object.values(database.publications).some(item => item.decisionDigest === decisionDigest)) fail('This approval was already used for another publication')
      const live = database.live, previous = live[candidate.skillId]
      if ((previous?.bundleDigest ?? null) !== candidate.baselineDigest) fail('Skill baseline conflict')
      if (this.skillsDir && existsSync(join(this.skillsDir, candidate.skillId, 'SKILL.md')) && !isHarnessOwnedBundle(readFileSync(join(this.skillsDir, candidate.skillId, 'SKILL.md'), 'utf8'))) fail('A user-owned skill now occupies this name')
      const versionDir = join(this.root, 'versions', candidate.bundleDigest)
      if (!existsSync(versionDir)) writeBundle(versionDir, readBundle(this.bundleDir(candidate.candidateId)))
      if (assetDigest(readBundle(versionDir)) !== candidate.bundleDigest) fail('Immutable version digest mismatch')
      const publication: OwnerPublication = { skillId: candidate.skillId, publicationId: randomUUID(), version: (previous?.version ?? 0) + 1, bundleDigest: candidate.bundleDigest, baselineDigest: candidate.baselineDigest, candidateId: candidate.candidateId, decisionDigest, idempotencyKey: input.idempotencyKey, ...(candidate.rollbackOf ? { rollbackOf: candidate.rollbackOf } : {}) }
      // Decision reference, idempotency result and live pointer commit in one atomic database replacement.
      database.publications[publication.publicationId] = publication
      database.keys[key] = publication.publicationId; live[candidate.skillId] = publication
      atomic(join(this.root, 'owner-state.json'), database)
      this.invalidate(); return publication
    })
  }
  status(query: { candidateId?: string; publicationId?: string; idempotencyKey?: string }): unknown {
    if (query.candidateId) {
      const candidate = this.candidate(query.candidateId)
      return { ...candidate, decision: this.decision(candidate.candidateId) }
    }
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

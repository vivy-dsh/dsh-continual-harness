/**
 * Hand cross-domain refinement candidates to the component that owns them.
 *
 * The harness never writes prompts, memories or subagent specs — its owner gate
 * refuses those edits. It does not drop them either: every refused create/update
 * becomes one Evidence row plus one Proposal candidate inside dsh-evolution,
 * handed over the loopback component channel. The candidate body stays here;
 * only its digest travels, so Evolution never becomes a second copy of an asset.
 *
 * Evolution requires a Superagent Ticket on every Proposal, so a candidate that
 * arrives without one waits in `owner_candidates.jsonl` until a later call
 * brings a ticket. Nothing is ever silently discarded, and an unreachable
 * Evolution defers rather than fails.
 * @module dsh-continual-harness
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { callComponent } from 'dsh-continual-harness/internal-ipc'
import type { RefineCoordinator, RefineExecutionResult, RefineRequest } from './coordinator-types.ts'
import type { AppliedRefinementEdit, RefinementResult } from './types.ts'

/** The Evolution vocabulary for one harness kind, mirroring `CANDIDATE_OWNERS`. */
export interface OwnerCandidate {
  candidateKind: string
  ownerKind: string
}

const OWNER_CANDIDATES: Record<string, OwnerCandidate> = {
  prompt: { candidateKind: 'behaviour_prompt', ownerKind: 'prompt_owner' },
  memory: { candidateKind: 'active_memory', ownerKind: 'actmem' },
  subagent: { candidateKind: 'subagent', ownerKind: 'agent_registry' },
}

/** The kinds this harness must hand over; every other kind it may still write. */
export function ownerCandidateOf(kind: string): OwnerCandidate | undefined {
  return Object.prototype.hasOwnProperty.call(OWNER_CANDIDATES, kind) ? OWNER_CANDIDATES[kind] : undefined
}

/** The candidate body is hashed and dropped; only this digest is stored. */
export function ownerCandidateDigest(summary: string): string {
  return createHash('sha256').update(String(summary), 'utf8').digest('hex')
}

/** Stable identity of one candidate: re-delivering the same edit adds no row. */
export function ownerCandidateDedupeKey(input: { refinementId: string; kind: string; editId: string }): string {
  return `harness:${input.refinementId}:${input.kind}:${input.editId}`
}

/** Append-only ledger of candidates no call could deliver yet. */
export const PENDING_CANDIDATES_FILE_NAME = 'owner_candidates.jsonl'

export function pendingCandidatesPath(harnessRoot: string): string {
  return join(harnessRoot, PENDING_CANDIDATES_FILE_NAME)
}

/** How many candidates a forwarding pass delivered, deferred and rejected. */
export interface OwnerCandidateReport {
  forwarded: number
  deferred: number
  failed: number
}

interface PendingCandidate {
  refinementId: string
  kind: string
  editId: string
  summary: string
  scope: string
  refs: Record<string, unknown>
  ticketId: string | null
}

/** The component call, injectable so a test can route it at the real endpoint. */
type ComponentCall = (input: { home: string; name: string; path: string; body?: unknown }) => Promise<any>

/** The edits of a committed refinement that belong to another component. */
export function ownerCandidatesOf(refinement: RefinementResult | undefined): AppliedRefinementEdit[] {
  const edits = Array.isArray(refinement?.appliedEdits) ? refinement.appliedEdits : []
  return edits.filter(edit => edit.action !== 'delete' && ownerCandidateOf(String(edit.kind)) !== undefined)
}

function readPending(harnessRoot: string): PendingCandidate[] {
  const file = pendingCandidatesPath(harnessRoot)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as PendingCandidate)
}

function writePending(harnessRoot: string, entries: PendingCandidate[]): void {
  const file = pendingCandidatesPath(harnessRoot)
  if (entries.length === 0) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * Deliver one candidate: Evidence first, then the Proposal that cites it.
 * A missing or closed Evolution has no error code and is deferred; a domain
 * rejection would fail again on retry, so it counts as failed.
 */
async function deliver(home: string, entry: PendingCandidate, ticketId: string, call: ComponentCall): Promise<'forwarded' | 'deferred' | 'failed'> {
  const candidate = ownerCandidateOf(entry.kind)
  if (!candidate) return 'failed'
  try {
    const evidence = await call({
      home,
      name: 'evolution',
      path: '/evidence',
      body: {
        source: 'dsh_session',
        summary: entry.summary,
        refs: { ...entry.refs, refinementId: entry.refinementId },
        ticketId,
        dedupeKey: ownerCandidateDedupeKey({ refinementId: entry.refinementId, kind: entry.kind, editId: entry.editId }),
      },
    }) as { id?: string; record?: { id?: string } } | undefined
    const evidenceId = evidence?.record?.id ?? evidence?.id
    if (!evidenceId) return 'failed'
    await call({
      home,
      name: 'evolution',
      path: '/proposal',
      body: {
        ticketId,
        candidateKind: candidate.candidateKind,
        ownerKind: candidate.ownerKind,
        assetScope: entry.scope,
        summary: entry.summary,
        candidateDigest: ownerCandidateDigest(entry.summary),
        evidenceIds: [evidenceId],
      },
    })
    return 'forwarded'
  } catch (error) {
    return (error as { code?: string } | undefined)?.code === undefined ? 'deferred' : 'failed'
  }
}

/**
 * Drain the pending ledger, then hand over this refinement's candidates.
 * A ticketId on this call also releases entries that arrived without one; an
 * entry that still has no ticket stays put.
 */
export async function forwardAppliedOwnerCandidates(input: {
  home: string
  harnessRoot: string
  refinement: RefinementResult
  ticketId?: string
  refs?: Record<string, unknown>
  call?: ComponentCall
}): Promise<OwnerCandidateReport> {
  const call = input.call ?? (callComponent as ComponentCall)
  const report: OwnerCandidateReport = { forwarded: 0, deferred: 0, failed: 0 }
  const remaining: PendingCandidate[] = []

  for (const entry of readPending(input.harnessRoot)) {
    const ticketId = input.ticketId ?? entry.ticketId ?? undefined
    if (!ticketId) {
      remaining.push(entry)
      continue
    }
    const outcome = await deliver(input.home, entry, ticketId, call)
    if (outcome === 'forwarded') report.forwarded += 1
    else if (outcome === 'failed') report.failed += 1
    else {
      remaining.push(entry)
      report.deferred += 1
    }
  }

  for (const edit of ownerCandidatesOf(input.refinement)) {
    const entry: PendingCandidate = {
      refinementId: input.refinement.id,
      kind: String(edit.kind),
      editId: String(edit.id),
      summary: String(input.refinement.summary ?? ''),
      scope: String(input.refinement.scope ?? 'local'),
      refs: input.refs ?? {},
      ticketId: input.ticketId ?? null,
    }
    if (!input.ticketId) {
      remaining.push(entry)
      report.deferred += 1
      continue
    }
    const outcome = await deliver(input.home, entry, input.ticketId, call)
    if (outcome === 'forwarded') report.forwarded += 1
    else if (outcome === 'failed') report.failed += 1
    else {
      remaining.push(entry)
      report.deferred += 1
    }
  }

  writePending(input.harnessRoot, remaining)
  return report
}

/** Deliver only the entries that already carry their own ticket. */
export async function retryPendingOwnerCandidates(input: {
  home: string
  harnessRoot: string
  call?: ComponentCall
}): Promise<OwnerCandidateReport> {
  const call = input.call ?? (callComponent as ComponentCall)
  const report: OwnerCandidateReport = { forwarded: 0, deferred: 0, failed: 0 }
  const remaining: PendingCandidate[] = []

  for (const entry of readPending(input.harnessRoot)) {
    if (!entry.ticketId) {
      remaining.push(entry)
      continue
    }
    const outcome = await deliver(input.home, entry, entry.ticketId, call)
    if (outcome === 'forwarded') report.forwarded += 1
    else if (outcome === 'failed') report.failed += 1
    else {
      remaining.push(entry)
      report.deferred += 1
    }
  }

  writePending(input.harnessRoot, remaining)
  return report
}

/** What one candidate hand-off needs from its host: deliver, and drain on load. */
export interface OwnerCandidateHandoff {
  forward(input: { refinement: RefinementResult; ticketId?: string; refs: Record<string, unknown> }): Promise<OwnerCandidateReport>
  retryPending(): Promise<OwnerCandidateReport>
}

/**
 * Wrap the coordinator so a committed refinement hands its cross-domain edits
 * to their owners. The hand-off never gates the refinement: a deferred or
 * unreachable Evolution leaves the candidate in the ledger and the execution
 * result untouched apart from the report attached to it.
 */
export function decorateWithOwnerCandidates(inner: RefineCoordinator, handoff: OwnerCandidateHandoff): RefineCoordinator {
  // The plugin load is the one moment a stranded candidate is known to be
  // worth retrying: the ledger drains once, and a still-offline Evolution just
  // keeps the entry for the next call.
  void handoff.retryPending().catch(() => undefined)
  return {
    async execute(request: RefineRequest): Promise<RefineExecutionResult> {
      const execution = await inner.execute(request)
      if (request.mode !== 'plan') return execution
      const refinement = execution.refinement
      if (execution.commitStatus === 'not-committed' || refinement === undefined) return execution
      if (ownerCandidatesOf(refinement).length === 0) return execution
      const ticketId = 'ticketId' in request ? request.ticketId : undefined
      const report = await handoff.forward({
        refinement,
        ...(ticketId === undefined ? {} : { ticketId }),
        refs: { sessionKey: request.agent.session.id },
      })
      return { ...execution, ownerCandidates: report }
    },
  }
}

/**
 * E4-S7 pure halves: the kind→owner map, the candidate digest and dedupe key,
 * which recorded edits become candidates, and the coordinator decoration that
 * hands them over once a refinement commits.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { OWNED_REFINEMENT_KINDS } from '../src/domain.ts'
import {
  decorateWithOwnerCandidates,
  ownerCandidateDedupeKey,
  ownerCandidateDigest,
  ownerCandidateOf,
  ownerCandidatesOf,
} from '../src/owner-candidates.ts'
import type { OwnerCandidateReport } from '../src/owner-candidates.ts'
import type { RefineCoordinator, RefineRequest } from '../src/coordinator-types.ts'
import type { AppliedRefinementEdit, RefinementResult } from '../src/types.ts'

function edit(kind: AppliedRefinementEdit['kind'], id: string, extra: Partial<AppliedRefinementEdit> = {}): AppliedRefinementEdit {
  return { action: 'create', kind, id, applied: false, blastRadius: 'project', after: 'body', ...extra }
}

function result(edits: AppliedRefinementEdit[], overrides: Partial<RefinementResult> = {}): RefinementResult {
  return { id: 'refine_1700000000000', summary: 'a cross-domain plan', committedAt: '2026-11-04T00:00:00.000Z', scope: 'local', appliedEdits: edits, ...overrides }
}

/** A stub request: the decorator reads only the mode, the ticket and the session id. */
function planRequest(ticketId?: string): RefineRequest {
  const agent = { session: { id: 'sess-1' } } as unknown as Agent
  return { mode: 'plan', agent, scope: 'local', source: 'tool', ...(ticketId === undefined ? {} : { ticketId }) }
}

const ZERO: OwnerCandidateReport = { forwarded: 0, deferred: 0, failed: 0 }

describe('ownerCandidateOf', () => {
  it('maps every owned kind to the owner Evolution enforces', () => {
    const expected = {
      prompt: { candidateKind: 'behaviour_prompt', ownerKind: 'prompt_owner' },
      memory: { candidateKind: 'active_memory', ownerKind: 'actmem' },
      subagent: { candidateKind: 'subagent', ownerKind: 'agent_registry' },
    }
    for (const kind of OWNED_REFINEMENT_KINDS) {
      expect(ownerCandidateOf(kind)).toEqual(expected[kind])
    }
  })

  it('leaves the kinds the harness writes itself without an owner candidate', () => {
    expect(ownerCandidateOf('skill')).toBeUndefined()
  })
})

describe('candidate keys', () => {
  it('names one candidate by refinement, kind and edit id', () => {
    expect(ownerCandidateDedupeKey({ refinementId: 'refine_1', kind: 'prompt', editId: 'plan-style' }))
      .toBe('harness:refine_1:prompt:plan-style')
  })

  it('digests the candidate summary into a stable 64-hex value', () => {
    const digest = ownerCandidateDigest('a cross-domain plan')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(ownerCandidateDigest('a cross-domain plan')).toBe(digest)
    expect(ownerCandidateDigest('another plan')).not.toBe(digest)
  })

  it('selects only owned-kind, non-delete edits of a committed refinement', () => {
    const committed = result([
      edit('memory', 'm1'),
      edit('prompt', 'p1'),
      edit('skill', 's1'),
      edit('subagent', 'a1', { action: 'update' }),
      edit('memory', 'legacy', { action: 'delete' }),
    ])
    expect(ownerCandidatesOf(committed).map(item => `${item.kind}:${item.id}`)).toEqual(['memory:m1', 'prompt:p1', 'subagent:a1'])
    expect(ownerCandidatesOf(undefined)).toEqual([])
  })
})

describe('decorateWithOwnerCandidates', () => {
  const committed = {
    commitStatus: 'committed' as const,
    approval: 'not-required' as const,
    appliedCount: 1,
    rejectedCount: 1,
    refinement: result([edit('prompt', 'p1')]),
  }

  it('hands the committed refinement over once, with the request ticket and session', async () => {
    const forward = vi.fn(async () => ({ forwarded: 1, deferred: 0, failed: 0 }))
    const inner: RefineCoordinator = { execute: vi.fn(async () => committed) }
    const decorated = decorateWithOwnerCandidates(inner, { forward, retryPending: async () => ZERO })
    const execution = await decorated.execute(planRequest('T-5'))
    expect(execution.ownerCandidates).toEqual({ forwarded: 1, deferred: 0, failed: 0 })
    expect(forward).toHaveBeenCalledWith({ refinement: committed.refinement, ticketId: 'T-5', refs: { sessionKey: 'sess-1' } })
  })

  it('leaves a rollback alone: replaying recorded history is not a new candidate', async () => {
    const forward = vi.fn(async () => ({ forwarded: 1, deferred: 0, failed: 0 }))
    const inner: RefineCoordinator = { execute: vi.fn(async () => committed) }
    const decorated = decorateWithOwnerCandidates(inner, { forward, retryPending: async () => ZERO })
    const request: RefineRequest = { mode: 'rollback', agent: planRequest().agent, scope: 'local', source: 'tool', rollbackId: 'refine_x' }
    const execution = await decorated.execute(request)
    expect(execution.ownerCandidates).toBeUndefined()
    expect(forward).not.toHaveBeenCalled()
  })

  it('never fails the refinement because the hand-off only deferred', async () => {
    const forward = vi.fn(async () => ({ forwarded: 0, deferred: 1, failed: 0 }))
    const inner: RefineCoordinator = { execute: vi.fn(async () => committed) }
    const decorated = decorateWithOwnerCandidates(inner, { forward, retryPending: async () => ZERO })
    await expect(decorated.execute(planRequest())).resolves.toMatchObject({ commitStatus: 'committed' })
  })

  it('does not hand over a refinement that never committed', async () => {
    const forward = vi.fn(async () => ZERO)
    const inner: RefineCoordinator = { execute: vi.fn(async () => ({ commitStatus: 'not-committed' as const, approval: 'not-required' as const, appliedCount: 0, rejectedCount: 0 })) }
    const decorated = decorateWithOwnerCandidates(inner, { forward, retryPending: async () => ZERO })
    const execution = await decorated.execute(planRequest('T-5'))
    expect(execution.ownerCandidates).toBeUndefined()
    expect(forward).not.toHaveBeenCalled()
  })
})

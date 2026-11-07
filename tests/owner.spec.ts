import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OWNED_REFINEMENT_KINDS, REFINEMENT_OWNERS } from '../src/domain.ts'
import { applyRefinementProposal, freshState, rollbackProposal } from '../src/refine.ts'
import { formatHarnessStateForPromptStructured, overviewForPrompt } from '../src/render.ts'
import type { HarnessState, RefinementEdit, RefinementKind } from '../src/types.ts'

const owned = [...OWNED_REFINEMENT_KINDS]

/**
 * Apply edits to `state` with the owner gate armed, supplying the commit
 * options `applyRefinementProposal` requires (id/scope/baselineState).
 */
function apply(
  state: HarnessState,
  edits: RefinementEdit[],
  extra: { rollbackOf?: string } = {},
) {
  return applyRefinementProposal(
    state,
    { id: 'refine_owner', summary: 'owner gate', edits },
    { id: 'refine_owner', scope: 'local', baselineState: state, ownedKinds: owned, ...extra },
  )
}

function sourceOf(file: string): string {
  return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
}

describe('owner boundaries', () => {
  for (const kind of owned) {
    it(`rejects direct ${kind} creation`, () => {
      const { result } = apply(freshState(), [{
        action: 'create', kind, id: `demo-${kind}`, blastRadius: 'project', content: 'body', description: 'demo',
      }])
      expect(result.appliedEdits[0]!.applied).toBe(false)
      expect(result.appliedEdits[0]!.error).toContain(REFINEMENT_OWNERS[kind])
      expect(result.appliedEdits[0]!.error).toContain('proposal flow')
    })

    it(`rejects direct ${kind} updates`, () => {
      const seeded = applyRefinementProposal(freshState(), {
        id: 'seed', summary: 'seed', edits: [{ action: 'create', kind, id: `demo-${kind}`, blastRadius: 'project', content: 'v1' }],
      }, { id: 'seed', scope: 'local', baselineState: freshState() })
      const { result } = apply(seeded.state, [{
        action: 'update', kind, id: `demo-${kind}`, blastRadius: 'project', content: 'v2', reason: 'direct edit',
      }])
      expect(result.appliedEdits[0]!.applied).toBe(false)
      expect(result.appliedEdits[0]!.error).toContain(REFINEMENT_OWNERS[kind])
    })
  }

  it('still accepts skill creation', () => {
    const { result } = apply(freshState(), [{
      action: 'create', kind: 'skill', id: 'demo-skill', blastRadius: 'project', content: 'body', description: 'demo',
    }])
    expect(result.appliedEdits[0]!.applied).toBe(true)
  })

  it('still accepts deleting an owned legacy entry', () => {
    const seeded = applyRefinementProposal(freshState(), {
      id: 'seed', summary: 'seed', edits: [{ action: 'create', kind: 'memory', id: 'legacy', blastRadius: 'project', content: 'old' }],
    }, { id: 'seed', scope: 'local', baselineState: freshState() })
    const { result } = apply(seeded.state, [{ action: 'delete', kind: 'memory', id: 'legacy', reason: 'cleanup' }])
    expect(result.appliedEdits[0]!.applied).toBe(true)
  })

  it('still accepts rollback replay of an owned kind', () => {
    const seeded = applyRefinementProposal(freshState(), {
      id: 'seed', summary: 'seed', edits: [{ action: 'create', kind: 'memory', id: 'm-rollback', blastRadius: 'project', content: 'v1' }],
    }, { id: 'seed', scope: 'local', baselineState: freshState() })
    const edited = applyRefinementProposal(seeded.state, {
      id: 'edit', summary: 'edit', edits: [{ action: 'update', kind: 'memory', id: 'm-rollback', blastRadius: 'project', content: 'v2', reason: 'learned more' }],
    }, { id: 'edit', scope: 'local', baselineState: seeded.state })
    const rollback = apply(edited.state, rollbackProposal(edited.result).edits, { rollbackOf: 'edit' })
    expect(rollback.result.appliedEdits[0]!.applied).toBe(true)
    expect(rollback.state.entries.memory['m-rollback']?.content).toBe('v1')
  })

  it('prompt projection omits owned kinds', () => {
    const seeded = applyRefinementProposal(freshState(), {
      id: 'seed', summary: 'seed', edits: [
        { action: 'create', kind: 'memory', id: 'm1', blastRadius: 'project', content: 'x' },
        { action: 'create', kind: 'prompt', id: 'p1', blastRadius: 'project', content: 'x' },
        { action: 'create', kind: 'subagent', id: 's1', blastRadius: 'project', content: 'x' },
        { action: 'create', kind: 'skill', id: 'k1', blastRadius: 'project', content: 'x', description: 'kept' },
      ],
    }, { id: 'seed', scope: 'local', baselineState: freshState() })
    const sections = (text: string) => text.split('\n').filter(line => line.startsWith('## ')).map(line => line.split(' ')[1])

    const text = formatHarnessStateForPromptStructured(seeded.state, '', {
      sessionId: 's',
      isLocal: () => false,
      kinds: ['skill' as RefinementKind],
    }).overview
    expect(text).not.toContain('## memory')
    expect(text).not.toContain('## prompt')
    expect(text).not.toContain('## subagent')
    expect(sections(text)).toContain('skill')

    const routing = overviewForPrompt(seeded.state, ['skill'])
    expect(routing).not.toContain('## memory')
    expect(routing).not.toContain('## prompt')
    expect(routing).not.toContain('## subagent')
    expect(routing).toContain('## skill')
  })

  it('default projections still render every kind', () => {
    const state = freshState()
    const routing = overviewForPrompt(state)
    for (const kind of ['prompt', 'memory', 'skill', 'subagent']) expect(routing).toContain(`## ${kind}`)
    const text = formatHarnessStateForPromptStructured(state, '', { sessionId: 's', isLocal: () => false }).overview
    for (const kind of ['prompt', 'memory', 'skill', 'subagent']) expect(text).toContain(`## ${kind}`)
  })

  it('wire passes owned and injectable kinds', () => {
    expect(sourceOf('index.ts')).toContain('ownedKinds')
    expect(sourceOf('driver.ts')).toContain('injectableKinds')
    expect(sourceOf('coordinator.ts')).toContain('injectableKinds')
    expect(sourceOf('store.ts')).toContain('injectableKinds')
    expect(sourceOf('tool.ts')).toMatch(/ActMem/)
    expect(sourceOf('tool.ts')).toMatch(/skill/)
  })
})

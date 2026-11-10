import { callComponent } from 'dsh-continual-harness/internal-ipc'
import type { RefineCoordinator } from './coordinator-types.ts'

/** Refinement has one production entry: an ordinary manual Input owned by Evolution. */
export function createManualDreamCoordinator(home: string | undefined, transport: typeof callComponent = callComponent): RefineCoordinator {
  return {
    async execute(request) {
      const empty = { commitStatus: 'not-committed' as const, approval: 'not-required' as const, appliedCount: 0, rejectedCount: 0 }
      if (!home) return { ...empty, failedAt: 'validation', error: { code: 'invalid-request', message: 'An absolute DSH_HOME and Evolution runtime are required' } }
      if (request.mode === 'rollback' || request.source === 'automatic') return { ...empty, failedAt: 'validation', error: { code: 'invalid-request', message: 'Use an ordinary manual Dream request for validated asset changes' } }
      if (request.signal?.aborted) return { ...empty, failedAt: 'validation', error: { code: 'aborted', message: 'Refinement request aborted' } }
      try {
        const result = await transport({ home, name: 'evolution', path: '/dream/request', body: { mode: 'manual', sessionId: String(request.agent.session.id), crossSession: request.crossSession === true, ...(request.instructions ? { instructions: request.instructions } : {}) } })
        return { ...empty, dreamRequest: result }
      } catch (error) { return { ...empty, failedAt: 'validation', error: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } } }
    },
  }
}

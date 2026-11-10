import { describe, expect, it, vi } from 'vitest'
import { createManualDreamCoordinator } from '../src/dream-adapter.ts'
import { executionSummary } from '../src/coordinator.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { callComponent } from '../../_shared/ipc.mjs'

const agent = { session: { id: 'real-session-id' } } as unknown as Agent
describe('manual Dream production adapter', () => {
  it('submits the current session as an ordinary manual Input and renders the queued request', async () => {
    const transport = vi.fn(async () => ({ id: 'request-1', status: 'submitted', inputId: 'input-1' }))
    const coordinator = createManualDreamCoordinator('C:/installation', transport as typeof callComponent)
    const result = await coordinator.execute({ mode: 'plan', source: 'command', scope: 'global', agent, instructions: 'preserve error recovery' })
    expect(transport).toHaveBeenCalledWith({ home: 'C:/installation', name: 'evolution', path: '/dream/request', body: { mode: 'manual', sessionId: 'real-session-id', crossSession: false, instructions: 'preserve error recovery' } })
    expect(result.commitStatus).toBe('not-committed')
    expect(result.appliedCount).toBe(0)
    expect(executionSummary(result)).toContain('Input: input-1')
  })
  it('uses cross-session evidence only through explicit opt-in and renders deterministic skips', async () => {
    const transport = vi.fn(async () => ({ skipped: true, reason: 'no new primary evidence' }))
    const result = await createManualDreamCoordinator('C:/installation', transport as typeof callComponent).execute({ mode: 'plan', source: 'tool', scope: 'local', agent, crossSession: true })
    expect(transport.mock.calls[0]?.[0].body.crossSession).toBe(true)
    expect(executionSummary(result)).toBe('Dream request skipped: no new primary evidence')
  })
  it('refuses the legacy automatic driver and rollback without touching the control plane', async () => {
    const transport = vi.fn(), coordinator = createManualDreamCoordinator('C:/installation', transport as typeof callComponent)
    const result = await coordinator.execute({ mode: 'rollback', source: 'tool', scope: 'global', agent, rollbackId: 'old-id' })
    expect(result.error?.code).toBe('invalid-request')
    expect(transport).not.toHaveBeenCalled()
  })
})

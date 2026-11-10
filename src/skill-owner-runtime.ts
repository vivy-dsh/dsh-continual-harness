import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { callComponent, registerComponentInternal } from 'dsh-continual-harness/internal-ipc'
import type { ComponentInternalContext } from 'dsh-continual-harness/internal-ipc'
import { assetDigest, SkillOwner } from './skill-owner.ts'
import type { SkillCandidateInput } from './skill-owner.ts'
import { registerSkillOwnerPanel } from './panel.ts'

/**
 * Production capability wiring. Staging stays on the component channel (it is
 * provenance-checked against the live Dream Ticket); promotion is served only by
 * the human panel, so no IPC caller can approve a candidate.
 */
export function createRuntimeSkillOwner(ctx: Context, home: string, skillsDir: string): SkillOwner {
  const owner = new SkillOwner(join(home, 'harness', 'skill-owner'), { skillsDir })
  const authorize = async (request: { ticketId: string; subjectId: string; skillId: string }, scope: string) => {
    const input = request as SkillCandidateInput
    const result = await callComponent({ home, name: 'evolution', path: '/dream/authorize', body: { ticketId: input.ticketId, subjectId: input.subjectId, skillId: input.skillId, entryDigest: assetDigest(input.entry), expectedDigest: input.expectedDigest, evidenceRefs: input.evidenceRefs, scope } })
    if (result?.authorized !== true) throw Object.assign(new Error('Live Superagent Ticket authorization is required'), { code: 'SKILL_TICKET_REQUIRED' })
  }
  ctx.inject(['skills'], inner => {
    const registry = inner.get('skills') as { registerProvider(factory: (control: { invalidate(): void }) => ReturnType<SkillOwner['provider']>): void }
    registry.registerProvider(control => owner.provider(control))
  })
  // Review needs both the web server and the host session check. Without them
  // the panel does not mount at all, so approval can never fall back to no auth.
  ctx.inject(['webServer', 'connection'], inner => {
    inner.effect(() => registerSkillOwnerPanel(inner as unknown as Context, owner))
  })
  ctx.inject(['webServer'], inner => {
    inner.effect(() => registerComponentInternal(inner as unknown as ComponentInternalContext, { home, name: 'harness', handle: async ({ method, path, body }: { method: string; path: string; body: Record<string, unknown> }) => {
      if (method !== 'POST') throw Object.assign(new Error('Owner operations require POST'), { code: 'SKILL_METHOD' })
      if (path === '/candidates') {
        const input = body as unknown as SkillCandidateInput
        await authorize(input, 'skill:stage'); return owner.stageCandidate(input)
      }
      if (path === '/status') return owner.status((body ?? {}) as Parameters<SkillOwner['status']>[0])
      throw Object.assign(new Error('Unknown SkillOwner operation'), { code: 'SKILL_ROUTE' })
    } }))
  })
  return owner
}

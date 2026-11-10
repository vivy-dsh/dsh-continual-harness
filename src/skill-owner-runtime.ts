import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { callComponent, registerComponentInternal } from 'dsh-continual-harness/internal-ipc'
import type { ComponentInternalContext } from 'dsh-continual-harness/internal-ipc'
import { assetDigest, SkillOwner } from './skill-owner.ts'
import type { SkillCandidateInput } from './skill-owner.ts'

/** Production capability wiring. IPC callers cannot replace the runner or authorizer. */
export function createRuntimeSkillOwner(ctx: Context, home: string, skillsDir: string): SkillOwner {
  const owner = new SkillOwner(join(home, 'harness', 'skill-owner'), async request => {
    try {
      const result = await callComponent({ home, name: 'evolution', path: '/dream/authorize', body: request })
      return result?.authorized === true
    } catch { return false }
  }, { skillsDir })
  const authorize = async (request: { ticketId: string; subjectId: string; skillId: string }, scope: string) => {
    const input = request as SkillCandidateInput
    const result = await callComponent({ home, name: 'evolution', path: '/dream/authorize', body: { ticketId: input.ticketId, subjectId: input.subjectId, skillId: input.skillId, entryDigest: assetDigest(input.entry), expectedDigest: input.expectedDigest, evidenceRefs: input.evidenceRefs, scope } })
    if (result?.authorized !== true) throw Object.assign(new Error('Live Superagent Ticket authorization is required'), { code: 'SKILL_TICKET_REQUIRED' })
  }
  ctx.inject(['skills'], inner => {
    const registry = inner.get('skills') as { registerProvider(factory: (control: { invalidate(): void }) => ReturnType<SkillOwner['provider']>): void }
    registry.registerProvider(control => owner.provider(control))
  })
  ctx.inject(['webServer'], inner => {
    inner.effect(() => registerComponentInternal(inner as unknown as ComponentInternalContext, { home, name: 'harness', handle: async ({ method, path, body }: { method: string; path: string; body: Record<string, unknown> }) => {
      if (method !== 'POST') throw Object.assign(new Error('Owner operations require POST'), { code: 'SKILL_METHOD' })
      if (path === '/candidates') {
        const input = body as unknown as SkillCandidateInput
        await authorize(input, 'skill:stage'); return owner.stageCandidate(input)
      }
      if (path === '/validate') {
        const candidate = owner.status({ candidateId: String(body.candidateId) }) as SkillCandidateInput
        await authorize(candidate, 'skill:validate'); return owner.validateCandidate(String(body.candidateId))
      }
      if (path === '/publish') return owner.publishCandidate(body as unknown as Parameters<SkillOwner['publishCandidate']>[0])
      if (path === '/status') return owner.status(body)
      throw Object.assign(new Error('Unknown SkillOwner operation'), { code: 'SKILL_ROUTE' })
    } }))
  })
  return owner
}

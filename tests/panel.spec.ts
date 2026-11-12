import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_PREFIX, registerSkillOwnerPanel } from '../src/panel.ts'
import { SkillOwner } from '../src/skill-owner.ts'
import type { SkillCandidateInput } from '../src/skill-owner.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }) })

const INPUT: SkillCandidateInput = {
  skillId: 'reviewed-skill', entry: { content: 'Run the reviewed procedure.', description: 'Use when testing review.' },
  expectedDigest: null, subjectId: 'subject-one', ticketId: 'ticket-one',
  evidenceRefs: [{ sessionId: 's1', eventId: 'primary-e1' }], idempotencyKey: 'candidate-one',
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

function fixture(options: { connection?: boolean; reject?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-panel-')); dirs.push(root)
  const owner = new SkillOwner(root)
  const candidate = owner.stageCandidate(INPUT)
  let handler: Handler | undefined
  const ctx = {
    get: (key: string) => {
      if (key === 'webServer') return { register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } }
      if (key === 'connection') return options.connection === false ? undefined : { requestRejection: () => options.reject }
      return undefined
    },
  } as unknown as Context
  registerSkillOwnerPanel(ctx, owner)

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    if (handler === undefined) throw new Error('panel handler was not registered')
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    Object.assign(req, {
      url: `${PANEL_PREFIX}${path}`, method,
      headers: {
        host: '127.0.0.1:3082',
        ...(method === 'POST' && body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    })
    let status: number | undefined, value = ''
    const res = { writeHead(code: number) { status = code }, end(text: string) { value = text } } as unknown as ServerResponse
    await handler(req, res)
    return { status, body: JSON.parse(value) as Record<string, any> }
  }
  return { owner, candidate, call }
}

const ORIGIN = { origin: 'http://127.0.0.1:3082' }

describe('skill review panel', () => {
  it('lists the staged body a reviewer has to read and hides it once decided', async () => {
    const { owner, candidate, call } = fixture()
    const before = await call('GET', '/pending')
    expect(before.status).toBe(200)
    expect(before.body.pending).toEqual([expect.objectContaining({ candidateId: candidate.candidateId, skillId: 'reviewed-skill', content: INPUT.entry.content, description: 'Use when testing review.' })])
    expect(before.body.live).toEqual([])
    owner.decide({ candidateId: candidate.candidateId, decision: 'rejected', confirm: true, expectedBundleDigest: candidate.bundleDigest })
    expect((await call('GET', '/pending')).body.pending).toEqual([])
  })

  it('refuses approval unless the signed-in panel sends one explicit same-origin confirmation', async () => {
    const { owner, candidate, call } = fixture()
    const body = { candidateId: candidate.candidateId, decision: 'approved', expectedBundleDigest: candidate.bundleDigest, confirm: true }
    expect((await call('POST', '/decide', body)).status).toBe(403)
    expect((await fixture({ connection: false }).call('POST', '/decide', body, ORIGIN)).status).toBe(503)
    expect((await fixture({ reject: 401 }).call('POST', '/decide', body, ORIGIN)).status).toBe(401)
    expect((await call('POST', '/decide', body, { origin: 'http://foreign.example' })).status).toBe(403)
    expect((await call('POST', '/decide', { ...body, confirm: false }, ORIGIN)).status).toBe(400)
    expect((await call('POST', '/decide', body, { ...ORIGIN, host: '10.0.0.5:3082' })).status).toBe(403)
    expect(owner.pending()).toHaveLength(1)
    expect(owner.status({})).toEqual([])
  })

  it('records the decision and publishes exactly once for an approved candidate', async () => {
    const { owner, candidate, call } = fixture()
    const body = { candidateId: candidate.candidateId, decision: 'approved', expectedBundleDigest: candidate.bundleDigest, confirm: true }
    const approved = await call('POST', '/decide', body, ORIGIN)
    expect(approved.status).toBe(200)
    expect(approved.body.decision).toMatchObject({ candidateId: candidate.candidateId, decision: 'approved', bundleDigest: candidate.bundleDigest, actor: 'panel' })
    expect(approved.body.publication).toMatchObject({ skillId: 'reviewed-skill', version: 1 })
    expect(owner.pending()).toEqual([])
    expect(owner.status({})).toEqual([expect.objectContaining({ skillId: 'reviewed-skill', version: 1 })])
    // The same click cannot publish a second version, and the decision cannot flip.
    const again = await call('POST', '/decide', body, ORIGIN)
    expect(again.status).toBe(200)
    expect(again.body.publication.version).toBe(1)
    expect((await call('POST', '/decide', { ...body, decision: 'rejected' }, ORIGIN)).status).toBe(422)
  })

  it('rejects a confirmation that names a bundle the reviewer never saw', async () => {
    const { owner, candidate, call } = fixture()
    const reply = await call('POST', '/decide', { candidateId: candidate.candidateId, decision: 'approved', expectedBundleDigest: 'b'.repeat(64), confirm: true }, ORIGIN)
    expect(reply.status).toBe(422)
    expect(reply.body.error).toContain('Reviewed digest does not match')
    expect(owner.pending()).toHaveLength(1)
    expect(owner.decision(candidate.candidateId)).toBeNull()
  })

  it('rejects non-JSON writes and unknown paths without touching state', async () => {
    const { owner, candidate, call } = fixture()
    const plain = await call('POST', '/decide', 'not json', { ...ORIGIN, 'content-type': 'text/plain' })
    expect(plain.status).toBe(415)
    expect((await call('POST', '/decide', '{oops', ORIGIN)).status).toBe(400)
    expect((await call('POST', '/other', { candidateId: candidate.candidateId }, ORIGIN)).status).toBe(404)
    expect(owner.pending()).toHaveLength(1)
  })

  it('keeps decided candidates visible and keeps a failed publication in the review queue', async () => {
    const { owner, candidate, call } = fixture()
    // Staged against "no live version"; approving the first candidate makes this one stale.
    const stale = owner.stageCandidate({ ...INPUT, entry: { content: 'Stale procedure.' }, idempotencyKey: 'candidate-two' })
    const body = { candidateId: candidate.candidateId, decision: 'approved', expectedBundleDigest: candidate.bundleDigest, confirm: true }
    expect((await call('POST', '/decide', body, ORIGIN)).status).toBe(200)
    expect((await call('POST', '/decide', { ...body, decision: 'rejected' }, ORIGIN)).status).toBe(422)
    const settled = await call('GET', '/pending')
    expect(settled.body.pending.map((item: { candidateId: string }) => item.candidateId)).toEqual([stale.candidateId])
    expect(settled.body.decided[0]).toMatchObject({ candidateId: candidate.candidateId, decision: 'approved', publication: { version: 1 } })

    // Approving the stale candidate must not strand it: no decision, still pending.
    const refused = await call('POST', '/decide', { candidateId: stale.candidateId, decision: 'approved', expectedBundleDigest: stale.bundleDigest, confirm: true }, ORIGIN)
    expect(refused.status).toBe(422)
    expect((await call('GET', '/pending')).body.pending).toEqual([expect.objectContaining({ candidateId: stale.candidateId, bundle: [expect.objectContaining({ name: 'SKILL.md' })] })])
  })

  it('turns a rollback click into another candidate, never a direct publication', async () => {
    const { owner, candidate, call } = fixture()
    const body = { candidateId: candidate.candidateId, decision: 'approved', expectedBundleDigest: candidate.bundleDigest, confirm: true }
    await call('POST', '/decide', body, ORIGIN)
    const first = (owner.status({}) as { bundleDigest: string }[])[0]!
    const second = owner.stageCandidate({ ...INPUT, expectedDigest: first.bundleDigest, entry: { content: 'Second procedure.' }, idempotencyKey: 'candidate-two' })
    await call('POST', '/decide', { candidateId: second.candidateId, decision: 'approved', expectedBundleDigest: second.bundleDigest, confirm: true }, ORIGIN)
    expect((owner.status({}) as { version: number }[])[0]!.version).toBe(2)

    const reply = await call('POST', '/rollback', { skillId: 'reviewed-skill', confirm: true }, ORIGIN)
    expect(reply.status).toBe(200)
    expect(reply.body.candidate).toMatchObject({ skillId: 'reviewed-skill', rollbackOf: expect.any(String) })
    expect((owner.status({}) as { version: number }[])[0]!.version).toBe(2)
    expect((await call('GET', '/pending')).body.pending.map((item: { candidateId: string }) => item.candidateId)).toContain(reply.body.candidate.candidateId)
    // No previous version, no rollback candidate.
    expect((await call('POST', '/rollback', { skillId: 'other-skill', confirm: true }, ORIGIN)).status).toBe(422)
  })
})

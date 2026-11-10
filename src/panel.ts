/**
 * Loopback HTTP API for human skill review.
 *
 * Staged skill candidates are promoted here and nowhere else. Every request is
 * same-origin, loopback-only and must pass the host session rejection hook, so a
 * component token read from disk is not enough to approve an asset: the caller
 * must be the signed-in panel.
 * @module dsh-continual-harness
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { DecisionKind, SkillOwner } from './skill-owner.ts'

/** Route prefix served by the DSH web server. */
export const PANEL_PREFIX = '/dsh-continual-harness/api'

/** Minimal shape of the host web server capability. */
interface PanelWebServer {
  register(route: {
    readonly kind: 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => unknown
  }): () => void
}

/** Minimal shape of the host connection capability. */
interface PanelConnection { requestRejection(req: IncomingMessage): unknown }

const BODY_LIMIT = 64 * 1024

function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function failure(res: ServerResponse, status: number, code: string, error: string, hint: string): void {
  send(res, status, { ok: false, code, error, hint })
}

function allowedHost(host: string | undefined): boolean {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(String(host ?? '').toLowerCase())
}

function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers.origin === undefined) return true
  try { return new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase() } catch { return false }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > BODY_LIMIT) throw Object.assign(new Error('request body is too large'), { code: 'BODY_TOO_LARGE' })
    chunks.push(Buffer.from(chunk))
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw Object.assign(new Error('request body is not valid JSON'), { code: 'INVALID_JSON' }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('request body must be a JSON object'), { code: 'INVALID_JSON' })
  return parsed as Record<string, unknown>
}

/**
 * Register the review API. Returns the host's route disposer.
 * @param ctx - child context providing `webServer` and `connection`.
 * @param owner - the skill owner whose staged candidates are reviewed here.
 */
export function registerSkillOwnerPanel(ctx: Context, owner: SkillOwner): () => void {
  const webServer = ctx.get('webServer') as PanelWebServer | undefined
  if (webServer === undefined) return () => {}

  return webServer.register({
    kind: 'prefix',
    path: PANEL_PREFIX,
    handler: async (req, res) => {
      if (!allowedHost(req.headers.host)) return failure(res, 403, 'HOST_REJECTED', '只接受本机访问', '使用本地 DSH 面板打开进化页面')
      if (req.method !== 'GET' && !sameOrigin(req)) return failure(res, 403, 'ORIGIN_REJECTED', '跨站请求被拒绝', '在 DSH 面板内重试')

      const connection = ctx.get('connection') as PanelConnection | undefined
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        return failure(res, 503, 'AUTH_UNAVAILABLE', '会话验证不可用', '检查 DSH 连接服务是否已组合')
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined && rejection !== null && rejection !== false) {
        return failure(res, typeof rejection === 'number' ? rejection : 403, 'AUTH_REJECTED', '会话未通过验证', '重新打开本地面板链接')
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (url.pathname === `${PANEL_PREFIX}/pending` && req.method === 'GET') {
          return send(res, 200, { ok: true, pending: owner.pending(), live: owner.status({}) })
        }
        if (url.pathname === `${PANEL_PREFIX}/decide` && req.method === 'POST') {
          if (req.headers.origin === undefined) return failure(res, 403, 'HUMAN_REVIEW_REQUIRED', '请从已登录的面板确认候选', '打开进化面板的技能候选页审阅')
          if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
            return failure(res, 415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
          }
          const body = await readBody(req)
          const candidateId = typeof body.candidateId === 'string' ? body.candidateId : ''
          const decision = body.decision
          if (!candidateId || (decision !== 'approved' && decision !== 'rejected') || body.confirm !== true || typeof body.expectedBundleDigest !== 'string') {
            return failure(res, 400, 'INVALID_REQUEST', '需要候选 ID、明确的决定、审阅摘要与确认标记', '重新审阅候选内容后确认')
          }
          const decided = owner.decide({ candidateId, decision: decision as DecisionKind, confirm: true, expectedBundleDigest: body.expectedBundleDigest })
          if (decided.decision !== 'approved') return send(res, 200, { ok: true, decision: decided, publication: null })
          const candidate = owner.status({ candidateId }) as { subjectId: string }
          const publication = owner.publishCandidate({ candidateId, idempotencyKey: `panel:${candidateId}`, subjectId: candidate.subjectId })
          return send(res, 200, { ok: true, decision: decided, publication })
        }
        return failure(res, 404, 'NOT_FOUND', '未知接口', '刷新页面后重试')
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'PANEL_ERROR')
        if (code === 'BODY_TOO_LARGE') return failure(res, 413, code, '请求体过大', '缩小内容后重试')
        if (code === 'INVALID_JSON') return failure(res, 400, code, '请求体不是合法 JSON', '刷新页面后重试')
        return failure(res, 422, code, error instanceof Error ? error.message : String(error), '检查候选状态后重试')
      }
    },
  })
}

// Alias + shape-mapping layer that lets the unmodified Paperclip UI talk to
// TaskCenter's Cloudflare Worker backend.
//
// Paperclip UI calls endpoints like `/api/auth/get-session` and expects an
// `AuthSession` object. TaskCenter exposes `/api/session/me` with a richer
// shape. This module owns every translation so the UI tree stays untouched.

import { Hono } from 'hono'
import type { EnvBindings, RequestContext } from '../lib/context'
import { readSessionToken, resolveSessionContext } from '../lib/server-auth'

export const paperclipAliasesRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

// ---------- Auth -----------------------------------------------------------

// Paperclip calls `/api/auth/get-session` and expects either 401 or the
// AuthSession shape `{ session: { id, userId }, user: { id, email, name, image } }`.
paperclipAliasesRoute.get('/auth/get-session', async (c) => {
  const token = readSessionToken(c)
  if (!token) return c.json({ error: 'unauthenticated' }, 401)
  const identity = await resolveSessionContext(c.env, token)
  if (!identity) return c.json({ error: 'unauthenticated' }, 401)

  return c.json({
    session: {
      id: identity.sessionId,
      userId: identity.userId,
    },
    user: {
      id: identity.userId,
      email: identity.userEmail ?? null,
      name: identity.userName ?? null,
      image: null,
    },
  })
})

// Paperclip posts to `/api/auth/sign-in/email` and `/sign-up/email`.
// TaskCenter's routes are `/api/auth/sign-in` and `/sign-up`. Forward bodies
// verbatim and return the response unchanged.
async function forwardAuthPost(c: Parameters<Parameters<typeof paperclipAliasesRoute.post>[1]>[0], target: string) {
  const body = await c.req.text()
  const url = new URL(c.req.url)
  const forwardUrl = `${url.origin}/api/auth/${target}`
  const resp = await fetch(forwardUrl, {
    method: 'POST',
    headers: {
      'Content-Type': c.req.header('content-type') ?? 'application/json',
      Cookie: c.req.header('cookie') ?? '',
    },
    body,
  })
  const payload = await resp.text()
  return new Response(payload, {
    status: resp.status,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
      ...(resp.headers.get('Set-Cookie') ? { 'Set-Cookie': resp.headers.get('Set-Cookie')! } : {}),
    },
  })
}

paperclipAliasesRoute.post('/auth/sign-in/email', (c) => forwardAuthPost(c, 'sign-in'))
paperclipAliasesRoute.post('/auth/sign-up/email', (c) => forwardAuthPost(c, 'sign-up'))

// Paperclip reads `/api/auth/profile` and PATCHes it. Map from the session
// we already have; updates are accepted but no-op for now (TaskCenter has no
// profile edit endpoint yet — Phase 3+ will add one).
paperclipAliasesRoute.get('/auth/profile', async (c) => {
  const token = readSessionToken(c)
  if (!token) return c.json({ error: 'unauthenticated' }, 401)
  const identity = await resolveSessionContext(c.env, token)
  if (!identity) return c.json({ error: 'unauthenticated' }, 401)
  return c.json({
    id: identity.userId,
    email: identity.userEmail ?? null,
    name: identity.userName ?? null,
    image: null,
  })
})

paperclipAliasesRoute.patch('/auth/profile', async (c) => {
  const token = readSessionToken(c)
  if (!token) return c.json({ error: 'unauthenticated' }, 401)
  const identity = await resolveSessionContext(c.env, token)
  if (!identity) return c.json({ error: 'unauthenticated' }, 401)
  const body = await c.req.json().catch(() => ({})) as { name?: string; image?: string | null }

  if (typeof body.name === 'string' && body.name.trim().length > 0) {
    await c.env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`)
      .bind(body.name.trim(), identity.userId)
      .run()
  }

  return c.json({
    id: identity.userId,
    email: identity.userEmail ?? null,
    name: typeof body.name === 'string' ? body.name.trim() : identity.userName ?? null,
    image: body.image ?? null,
  })
})

// ---------- Company-scoped pass-throughs ----------------------------------

// Paperclip hits company-scoped skills/projects; TaskCenter stores those at
// the tenant level, so we forward with a query-param.
paperclipAliasesRoute.get('/companies/:companyId/skills', async (c) => {
  const url = new URL(c.req.url)
  const forward = `${url.origin}/api/skills`
  const resp = await fetch(forward, {
    headers: { Cookie: c.req.header('cookie') ?? '' },
  })
  const body = await resp.json().catch(() => ({ skills: [] })) as { skills?: unknown[] } | unknown[]
  const list = Array.isArray(body) ? body : (body.skills ?? [])
  return c.json(list, resp.status as 200)
})

paperclipAliasesRoute.get('/companies/:companyId/projects', async (c) => {
  const companyId = c.req.param('companyId')
  const url = new URL(c.req.url)
  const forward = `${url.origin}/api/projects?companyId=${encodeURIComponent(companyId)}`
  const resp = await fetch(forward, {
    headers: { Cookie: c.req.header('cookie') ?? '' },
  })
  const body = await resp.json().catch(() => ({ projects: [] })) as { projects?: unknown[] } | unknown[]
  const list = Array.isArray(body) ? body : (body.projects ?? [])
  return c.json(list, resp.status as 200)
})

// ---------- Feature stubs (not yet implemented in TaskCenter) -------------

paperclipAliasesRoute.get('/companies/:companyId/heartbeat-runs', (c) => c.json({ runs: [] }))
paperclipAliasesRoute.get('/companies/:companyId/join-requests', (c) => c.json({ requests: [] }))

// No-op WebSocket so Paperclip's LiveUpdatesProvider stops reconnecting.
// Real streaming wires up to the existing Assistant/Company DOs in a later
// phase.
paperclipAliasesRoute.get('/companies/:companyId/events/ws', (c) => {
  const upgrade = c.req.header('upgrade')
  if (upgrade !== 'websocket') return c.text('expected websocket', 400)
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()
  return new Response(null, { status: 101, webSocket: client })
})

import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { getUsageSnapshot } from '../lib/usage'
import { getWorkspaceCapabilities } from '../lib/capabilities'
import { clearSessionCookie } from '../lib/server-auth'
import { buildWorkspaceSearchExcerpt, scoreWorkspaceCandidate, tokenizeWorkspaceQuery } from '../lib/workspace-search'
import { recordSecurityEvent } from '../lib/security-events'

export const sessionRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const workspaceSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const memberRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
})

function isWorkspaceAdmin(role: RequestContext['role']) {
  return role === 'owner' || role === 'admin'
}

sessionRoute.get('/me', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const userName = c.get('userName')
  const requestRole = c.get('role')
  const currentSessionId = c.get('sessionId')

  const membership = await c.env.DB.prepare(
    `SELECT m.role, u.email, u.name, t.name AS tenant_name
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.tenant_id = ? AND m.user_id = ?
     LIMIT 1`
  )
    .bind(tenantId, userId)
    .first<{ role: string; email: string | null; name: string | null; tenant_name: string }>()

  const projectCountRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM projects WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .first<{ count: number }>()

  const usage = await getUsageSnapshot(c.env, tenantId, userId)
  const capabilities = await getWorkspaceCapabilities(c.env, { tenantId })

  return c.json({
    user: {
      id: userId,
      email: membership?.email ?? userEmail,
      name: membership?.name ?? userName,
      role: membership?.role ?? requestRole,
    },
    tenant: {
      id: tenantId,
      name: membership?.tenant_name ?? 'Default Workspace',
    },
    stats: {
      projects: projectCountRow?.count ?? 0,
    },
    usage,
    capabilities,
    currentSessionId,
  })
})

sessionRoute.get('/workspace-members', async (c) => {
  const tenantId = c.get('tenantId')

  const rows = await c.env.DB.prepare(
    `SELECT
       u.id,
       u.email,
       u.name,
       m.role,
       m.created_at,
       COUNT(DISTINCT pma.project_id) AS project_count,
       COUNT(DISTINCT CASE WHEN s.expires_at > ? THEN s.id END) AS active_session_count,
       MAX(CASE WHEN s.expires_at > ? THEN s.last_seen_at END) AS last_seen_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
     LEFT JOIN project_member_assignments pma ON pma.tenant_id = m.tenant_id AND pma.member_id = m.user_id
     LEFT JOIN auth_sessions s ON s.tenant_id = m.tenant_id AND s.user_id = m.user_id
     WHERE m.tenant_id = ?
     GROUP BY u.id, u.email, u.name, m.role, m.created_at
     ORDER BY COALESCE(u.name, u.email, u.id) COLLATE NOCASE ASC`
  )
    .bind(Date.now(), Date.now(), tenantId)
    .all<{
      id: string
      email: string | null
      name: string | null
      role: string
      created_at: number
      project_count: number
      active_session_count: number
      last_seen_at: number | null
    }>()

  return c.json({
    members: rows.results.map((member) => ({
      id: member.id,
      email: member.email,
      name: member.name || member.email || member.id,
      role: member.role,
      createdAt: member.created_at,
      projectCount: member.project_count || 0,
      activeSessionCount: member.active_session_count || 0,
      lastSeenAt: member.last_seen_at,
    })),
  })
})

sessionRoute.put('/workspace-members/:memberId/role', zValidator('json', memberRoleSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserId = c.get('userId')
  const currentRole = c.get('role')
  if (!isWorkspaceAdmin(currentRole)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const memberId = c.req.param('memberId')
  const payload = c.req.valid('json')

  const membership = await c.env.DB.prepare(
    `SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1`
  )
    .bind(tenantId, memberId)
    .first<{ role: 'owner' | 'admin' | 'member' | 'viewer' } | null>()

  if (!membership) {
    return c.json({ error: 'Member not found' }, 404)
  }

  if (membership.role === 'owner') {
    return c.json({ error: 'Owner role cannot be changed' }, 400)
  }

  await c.env.DB.prepare(
    `UPDATE memberships SET role = ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?`
  )
    .bind(payload.role, Date.now(), tenantId, memberId)
    .run()

  await recordSecurityEvent(c.env, {
    tenantId,
    userId: memberId,
    eventType: 'membership.role_changed',
    description: `Workspace role changed to ${payload.role}.`,
    request: c.req.raw,
    metadata: {
      actorUserId: currentUserId,
      previousRole: membership.role,
      nextRole: payload.role,
    },
  })

  return c.json({ ok: true })
})

sessionRoute.get('/search', zValidator('query', workspaceSearchSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const { q, limit } = c.req.valid('query')
  const tokens = tokenizeWorkspaceQuery(q)

  const [projects, items, proposals, messages, debugSessions, repoReviews, members] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.id, p.name, p.description, psi.content, psi.updated_at
       FROM projects p
       LEFT JOIN project_search_index psi ON psi.tenant_id = p.tenant_id AND psi.project_id = p.id
       WHERE p.tenant_id = ?
       ORDER BY p.updated_at DESC
       LIMIT 80`
    )
      .bind(tenantId)
      .all<{ id: string; name: string; description: string | null; content: string | null; updated_at: number | null }>(),
    c.env.DB.prepare(
      `SELECT i.id, i.project_id, p.name AS project_name, i.kind, i.title, i.description, i.status, i.updated_at
       FROM items i
       JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
       WHERE i.tenant_id = ?
       ORDER BY i.updated_at DESC
       LIMIT 250`
    )
      .bind(tenantId)
      .all<{ id: string; project_id: string; project_name: string; kind: string; title: string; description: string | null; status: string; updated_at: number }>(),
    c.env.DB.prepare(
      `SELECT pr.id, pr.project_id, p.name AS project_name, pr.title, pr.summary, pr.status, pr.updated_at
       FROM proposals pr
       JOIN projects p ON p.id = pr.project_id AND p.tenant_id = pr.tenant_id
       WHERE pr.tenant_id = ?
       ORDER BY pr.updated_at DESC
       LIMIT 120`
    )
      .bind(tenantId)
      .all<{ id: string; project_id: string; project_name: string; title: string; summary: string | null; status: string; updated_at: number }>(),
    c.env.DB.prepare(
      `SELECT am.id, am.project_id, p.name AS project_name, am.role, am.content, am.created_at
       FROM agent_messages am
       JOIN projects p ON p.id = am.project_id AND p.tenant_id = am.tenant_id
       WHERE am.tenant_id = ?
       ORDER BY am.created_at DESC
       LIMIT 120`
    )
      .bind(tenantId)
      .all<{ id: string; project_id: string; project_name: string; role: string; content: string; created_at: number }>(),
    c.env.DB.prepare(
      `SELECT ds.id, ds.project_id, p.name AS project_name, ds.mode, ds.summary, ds.diagnosis, ds.status, ds.updated_at
       FROM debug_sessions ds
       JOIN projects p ON p.id = ds.project_id AND p.tenant_id = ds.tenant_id
       WHERE ds.tenant_id = ?
       ORDER BY ds.updated_at DESC
       LIMIT 80`
    )
      .bind(tenantId)
      .all<{ id: string; project_id: string; project_name: string; mode: string; summary: string; diagnosis: string | null; status: string; updated_at: number }>(),
    c.env.DB.prepare(
      `SELECT rr.id, rr.project_id, p.name AS project_name, rr.repo_full_name, rr.review_mode, rr.summary, rr.status, rr.updated_at
       FROM repo_review_sessions rr
       JOIN projects p ON p.id = rr.project_id AND p.tenant_id = rr.tenant_id
       WHERE rr.tenant_id = ?
       ORDER BY rr.updated_at DESC
       LIMIT 80`
    )
      .bind(tenantId)
      .all<{ id: string; project_id: string; project_name: string; repo_full_name: string | null; review_mode: string; summary: string | null; status: string; updated_at: number }>(),
    c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
       WHERE m.tenant_id = ?
       ORDER BY COALESCE(u.name, u.email, u.id) COLLATE NOCASE ASC
       LIMIT 120`
    )
      .bind(tenantId)
      .all<{ id: string; name: string | null; email: string | null; role: string }>(),
  ])

  const results = [
    ...projects.results.map((project) => {
      const text = [project.name, project.description || '', project.content || ''].join(' ')
      return {
        type: 'project',
        id: project.id,
        projectId: project.id,
        title: project.name,
        subtitle: 'Project',
        status: null,
        score: scoreWorkspaceCandidate({ text, recencyBoost: 4 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(project.description || project.content || project.name, tokens),
      }
    }),
    ...items.results.map((item) => {
      const text = [item.title, item.description || '', item.kind, item.status, item.project_name].join(' ')
      return {
        type: 'item',
        id: item.id,
        projectId: item.project_id,
        title: item.title,
        subtitle: `${item.project_name} · ${item.kind}`,
        status: item.status,
        score: scoreWorkspaceCandidate({ text, recencyBoost: 3 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(item.description || `${item.kind} in ${item.project_name}`, tokens),
      }
    }),
    ...proposals.results.map((proposal) => {
      const text = [proposal.title, proposal.summary || '', proposal.status, proposal.project_name].join(' ')
      return {
        type: 'proposal',
        id: proposal.id,
        projectId: proposal.project_id,
        title: proposal.title,
        subtitle: `${proposal.project_name} · Proposal`,
        status: proposal.status,
        score: scoreWorkspaceCandidate({ text, recencyBoost: proposal.status === 'applied' ? 2 : 3 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(proposal.summary || proposal.title, tokens),
      }
    }),
    ...messages.results.map((message) => {
      const text = [message.content, message.project_name, message.role].join(' ')
      return {
        type: 'message',
        id: message.id,
        projectId: message.project_id,
        title: `${message.project_name} conversation`,
        subtitle: `${message.role} message`,
        status: null,
        score: scoreWorkspaceCandidate({ text, recencyBoost: 1 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(message.content, tokens),
      }
    }),
    ...debugSessions.results.map((session) => {
      const text = [session.summary, session.diagnosis || '', session.mode, session.project_name].join(' ')
      return {
        type: 'debug_session',
        id: session.id,
        projectId: session.project_id,
        title: session.summary,
        subtitle: `${session.project_name} · Debug session`,
        status: session.status,
        score: scoreWorkspaceCandidate({ text, recencyBoost: 4 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(session.diagnosis || session.summary, tokens),
      }
    }),
    ...repoReviews.results.map((review) => {
      const text = [review.summary || '', review.repo_full_name || '', review.review_mode, review.project_name].join(' ')
      return {
        type: 'repo_review',
        id: review.id,
        projectId: review.project_id,
        title: review.summary || review.repo_full_name || 'Repo review session',
        subtitle: `${review.project_name} · Repo review`,
        status: review.status,
        score: scoreWorkspaceCandidate({ text, recencyBoost: 4 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(review.repo_full_name || review.summary || review.review_mode, tokens),
      }
    }),
    ...members.results.map((member) => {
      const text = [member.name || '', member.email || '', member.role].join(' ')
      return {
        type: 'member',
        id: member.id,
        projectId: null,
        title: member.name || member.email || member.id,
        subtitle: `${member.role} · Workspace member`,
        status: null,
        score: scoreWorkspaceCandidate({ text, recencyBoost: 2 }, tokens),
        excerpt: buildWorkspaceSearchExcerpt(member.email || member.role, tokens),
      }
    }),
  ]
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return c.json({
    query: q,
    results,
  })
})

sessionRoute.get('/security/sessions', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const currentSessionId = c.get('sessionId')

  const sessions = await c.env.DB.prepare(
    `SELECT id, created_at, last_seen_at, expires_at
     FROM auth_sessions
     WHERE tenant_id = ? AND user_id = ?
     ORDER BY last_seen_at DESC`
  )
    .bind(tenantId, userId)
    .all<{ id: string; created_at: number; last_seen_at: number; expires_at: number }>()

  const events = await c.env.DB.prepare(
    `SELECT session_id, ip_address, user_agent, created_at
     FROM security_events
     WHERE tenant_id = ? AND user_id = ? AND event_type = 'session.created'
     ORDER BY created_at DESC
     LIMIT 200`
  )
    .bind(tenantId, userId)
    .all<{ session_id: string | null; ip_address: string | null; user_agent: string | null; created_at: number }>()

  const eventBySession = new Map<string, { ipAddress: string | null; userAgent: string | null; createdAt: number }>()
  for (const event of events.results) {
    if (!event.session_id || eventBySession.has(event.session_id)) continue
    eventBySession.set(event.session_id, {
      ipAddress: event.ip_address,
      userAgent: event.user_agent,
      createdAt: event.created_at,
    })
  }

  return c.json({
    sessions: sessions.results.map((session) => {
      const event = eventBySession.get(session.id)
      return {
        id: session.id,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        expiresAt: session.expires_at,
        current: session.id === currentSessionId,
        ipAddress: event?.ipAddress || null,
        userAgent: event?.userAgent || null,
      }
    }),
  })
})

sessionRoute.delete('/security/sessions/:sessionId', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const currentSessionId = c.get('sessionId')
  const sessionId = c.req.param('sessionId')

  const existing = await c.env.DB.prepare(
    `SELECT id FROM auth_sessions WHERE tenant_id = ? AND user_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, userId, sessionId)
    .first<{ id: string } | null>()

  if (!existing) {
    return c.json({ error: 'Session not found' }, 404)
  }

  await c.env.DB.prepare(`DELETE FROM auth_sessions WHERE tenant_id = ? AND user_id = ? AND id = ?`)
    .bind(tenantId, userId, sessionId)
    .run()

  await recordSecurityEvent(c.env, {
    tenantId,
    userId,
    sessionId,
    eventType: 'session.revoked',
    description: sessionId === currentSessionId ? 'Current session revoked.' : 'Another active session was revoked.',
    request: c.req.raw,
  })

  if (sessionId === currentSessionId) {
    clearSessionCookie(c, c.env)
  }

  return c.json({ ok: true, signedOutCurrentSession: sessionId === currentSessionId })
})

sessionRoute.get('/security/events', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')

  const events = await c.env.DB.prepare(
    `SELECT id, session_id, event_type, description, ip_address, user_agent, metadata_json, created_at
     FROM security_events
     WHERE tenant_id = ? AND user_id = ?
     ORDER BY created_at DESC
     LIMIT 80`
  )
    .bind(tenantId, userId)
    .all<{
      id: string
      session_id: string | null
      event_type: string
      description: string
      ip_address: string | null
      user_agent: string | null
      metadata_json: string | null
      created_at: number
    }>()

  return c.json({
    events: events.results.map((event) => ({
      id: event.id,
      sessionId: event.session_id,
      eventType: event.event_type,
      description: event.description,
      ipAddress: event.ip_address,
      userAgent: event.user_agent,
      metadata: event.metadata_json ? JSON.parse(event.metadata_json) : null,
      createdAt: event.created_at,
    })),
  })
})

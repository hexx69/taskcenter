import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import {
  approveCompanyApproval,
  createCompanyWithDefaultWorkstream,
  createCompanyWorkstream,
  ensureCompanyExists,
  exportCompanySnapshot,
  getCompanyDashboard,
  getCompanyCosts,
  importCompanySnapshot,
  listCompanies,
  listCompanyActivity,
  listCompanyAgents,
  listCompanyApprovals,
  listCompanyGoals,
  listCompanyIssues,
  listCompanyInstructionBundles,
  listCompanyRoutines,
  listCompanyWorkstreams,
  rejectCompanyApproval,
  updateCompany,
} from '../lib/companies'
import { listAssistantThreads } from '../lib/assistant'
import { openCompanyRuntimeLiveStream } from '../lib/control-plane-live'

export const companiesRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  githubRepoFullName: z.string().min(1).optional(),
})

const createWorkstreamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

const importCompanySchema = z.object({
  name: z.string().min(1).optional(),
  snapshot: z.record(z.unknown()),
})

const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  brandColor: z.string().nullable().optional(),
})

companiesRoute.get('/', async (c) => {
  const result = await listCompanies(c.env, c.get('tenantId'))
  return c.json(result)
})

companiesRoute.post('/', zValidator('json', createCompanySchema), async (c) => {
  const payload = c.req.valid('json')
  const created = await createCompanyWithDefaultWorkstream(c.env, {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
    name: payload.name,
    description: payload.description,
    githubRepoFullName: payload.githubRepoFullName,
  })

  return c.json(
    {
      companyId: created.companyId,
      defaultProjectId: created.projectId,
      defaultWorkstreamId: created.workstreamId,
    },
    201
  )
})

companiesRoute.get('/:companyId', async (c) => {
  const result = await getCompanyDashboard(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!result) return c.json({ error: 'company_not_found' }, 404)
  return c.json(result)
})

companiesRoute.get('/:companyId/dashboard', async (c) => {
  const result = await getCompanyDashboard(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!result) return c.json({ error: 'company_not_found' }, 404)
  return c.json(result)
})

companiesRoute.patch('/:companyId', zValidator('json', updateCompanySchema), async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)

  const payload = c.req.valid('json')
  const updated = await updateCompany(c.env, {
    tenantId: c.get('tenantId'),
    companyId: company.id,
    name: payload.name,
    description: payload.description,
    brandColor: payload.brandColor,
  })

  if (!updated) return c.json({ error: 'company_not_found' }, 404)
  return c.json({
    id: updated.id,
    name: updated.name,
    description: updated.description,
    status: updated.status,
    issuePrefix: updated.issue_prefix,
    brandColor: updated.brand_color,
    canonicalProjectId: updated.canonical_project_id,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  })
})

companiesRoute.get('/:companyId/workstreams', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyWorkstreams(c.env, c.get('tenantId'), company.id))
})

companiesRoute.post('/:companyId/workstreams', zValidator('json', createWorkstreamSchema), async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)

  const payload = c.req.valid('json')
  const created = await createCompanyWorkstream(c.env, {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
    companyId: company.id,
    name: payload.name,
    description: payload.description,
  })

  return c.json(created, 201)
})

companiesRoute.get('/:companyId/threads', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)

  const result = await listAssistantThreads(
    c.env,
    {
      tenantId: c.get('tenantId'),
      userId: c.get('userId'),
      userEmail: c.get('userEmail'),
      userName: c.get('userName'),
      role: c.get('role'),
    },
    { companyId: company.id }
  )
  return c.json(result)
})

companiesRoute.get('/:companyId/instructions', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyInstructionBundles(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/inbox', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)

  const [threads, pendingActions, sessions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, visibility, status, updated_at
       FROM assistant_threads
       WHERE tenant_id = ? AND company_id = ?
       ORDER BY updated_at DESC
       LIMIT 8`
    )
      .bind(c.get('tenantId'), company.id)
      .all<{ id: string; title: string; visibility: string; status: string; updated_at: number }>(),
    c.env.DB.prepare(
      `SELECT id, title, kind, status, updated_at
       FROM assistant_pending_actions
       WHERE tenant_id = ? AND company_id = ? AND status = 'pending'
       ORDER BY updated_at DESC
       LIMIT 8`
    )
      .bind(c.get('tenantId'), company.id)
      .all<{ id: string; title: string; kind: string; status: string; updated_at: number }>(),
    c.env.DB.prepare(
      `SELECT id, title, mode, status, transport, updated_at
       FROM execution_sessions
       WHERE tenant_id = ? AND company_id = ?
       ORDER BY updated_at DESC
       LIMIT 8`
    )
      .bind(c.get('tenantId'), company.id)
      .all<{ id: string; title: string; mode: string; status: string; transport: string; updated_at: number }>(),
  ])

  return c.json({
    threads: threads.results.map((row) => ({
      id: row.id,
      title: row.title,
      visibility: row.visibility,
      status: row.status,
      updatedAt: row.updated_at,
    })),
    pendingActions: pendingActions.results.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      updatedAt: row.updated_at,
    })),
    executionSessions: sessions.results.map((row) => ({
      id: row.id,
      title: row.title,
      mode: row.mode,
      status: row.status,
      transport: row.transport,
      updatedAt: row.updated_at,
    })),
  })
})

companiesRoute.get('/:companyId/issues', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyIssues(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/goals', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyGoals(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/agents', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyAgents(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/routines', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyRoutines(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/routines/:routineId/runs', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  const routineId = c.req.param('routineId')
  const result = await c.env.DB.prepare(
    `SELECT id, company_id, project_id, category, severity, message, metadata_json, created_at
     FROM company_activity
     WHERE tenant_id = ? AND company_id = ? AND category = 'routine_fired'
       AND json_extract(metadata_json, '$.routineId') = ?
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(c.get('tenantId'), company.id, routineId)
    .all<{
      id: string
      company_id: string
      project_id: string | null
      category: string
      severity: string
      message: string
      metadata_json: string | null
      created_at: number
    }>()
  return c.json({
    runs: result.results.map((row) => {
      let metadata: Record<string, unknown> | null = null
      if (row.metadata_json) {
        try {
          metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
        } catch {
          metadata = null
        }
      }
      return {
        id: row.id,
        companyId: row.company_id,
        projectId: row.project_id,
        category: row.category,
        severity: row.severity,
        message: row.message,
        metadata,
        createdAt: row.created_at,
      }
    }),
  })
})

companiesRoute.get('/:companyId/approvals', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyApprovals(c.env, c.get('tenantId'), company.id))
})

companiesRoute.post('/:companyId/approvals/:approvalId/approve', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { companyId, approvalId } = c.req.param()
  try {
    const result = await approveCompanyApproval(c.env, { tenantId, actorId: userId, companyId, approvalId })
    return c.json(result)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'failed' }, 400)
  }
})

companiesRoute.post('/:companyId/approvals/:approvalId/reject', zValidator('json', z.object({ reason: z.string().optional() })), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { companyId, approvalId } = c.req.param()
  const { reason } = c.req.valid('json')
  try {
    const result = await rejectCompanyApproval(c.env, { tenantId, actorId: userId, companyId, approvalId, reason })
    return c.json(result)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'failed' }, 400)
  }
})

companiesRoute.post(
  '/:companyId/approvals/:approvalId',
  zValidator('json', z.object({ decision: z.enum(['approved', 'rejected']) })),
  async (c) => {
    const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
    if (!company) return c.json({ error: 'company_not_found' }, 404)

    const now = Date.now()
    const decision = c.req.valid('json').decision
    const approvalId = c.req.param('approvalId')
    const updated = await c.env.DB.prepare(
      `UPDATE company_approvals
       SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
       WHERE tenant_id = ? AND company_id = ? AND id = ?`
    )
      .bind(decision, c.get('userId'), now, now, c.get('tenantId'), company.id, approvalId)
      .run()

    if (!updated.success) {
      return c.json({ error: 'approval_update_failed' }, 500)
    }

    if (decision === 'approved') {
      const approval = await c.env.DB.prepare(
        `SELECT payload_json
         FROM company_approvals
         WHERE tenant_id = ? AND company_id = ? AND id = ?
         LIMIT 1`
      )
        .bind(c.get('tenantId'), company.id, approvalId)
        .first<{ payload_json: string | null } | null>()

      let payload: Record<string, unknown> | null = null
      if (approval?.payload_json) {
        try {
          payload = JSON.parse(approval.payload_json) as Record<string, unknown>
        } catch {
          payload = null
        }
      }

      const roleKey = typeof payload?.roleKey === 'string' ? payload.roleKey : null
      const title = typeof payload?.title === 'string' ? payload.title : null
      if (roleKey && title) {
        const existing = await c.env.DB.prepare(
          `SELECT id
           FROM company_agents
           WHERE tenant_id = ? AND company_id = ? AND role_key = ? AND title = ?
           LIMIT 1`
        )
          .bind(c.get('tenantId'), company.id, roleKey, title)
          .first<{ id: string } | null>()

        if (!existing) {
          await c.env.DB.prepare(
            `INSERT INTO company_agents (
              id, tenant_id, company_id, user_id, role_key, title, description, wakeup_policy_json, runtime_policy_json, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              `cagt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
              c.get('tenantId'),
              company.id,
              roleKey,
              title,
              typeof payload?.description === 'string' ? payload.description : null,
              JSON.stringify((payload?.wakeupPolicy as Record<string, unknown> | null) || null),
              JSON.stringify((payload?.runtimePolicy as Record<string, unknown> | null) || null),
              c.get('userId'),
              now,
              now
            )
            .run()
        }
      }
    }

    return c.json({ ok: true, decision, decidedAt: now })
  }
)

companiesRoute.get('/:companyId/activity', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await listCompanyActivity(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/stream', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return openCompanyRuntimeLiveStream(c.env, company.id)
})

// Stubs for Paperclip features TaskCenter does not implement yet.
// Returning empty 200 responses prevents noisy 404s in the console.
companiesRoute.get('/:companyId/heartbeat-runs', (c) => c.json({ runs: [] }))
// Minimal no-op WebSocket that accepts the client and never pushes events.
// Stops Paperclip's LiveUpdatesProvider from hammering the console.
companiesRoute.get('/:companyId/events/ws', (c) => {
  const upgrade = c.req.header('upgrade')
  if (upgrade !== 'websocket') return c.text('expected websocket', 400)
  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()
  return new Response(null, { status: 101, webSocket: client })
})
companiesRoute.get('/:companyId/join-requests', (c) => c.json({ requests: [] }))
companiesRoute.get('/:companyId/projects', async (c) => {
  const companyId = c.req.param('companyId')
  const tenantId = c.get('tenantId')
  const res = await c.env.DB.prepare(
    `SELECT id, name, description, company_id FROM projects WHERE tenant_id = ? AND company_id = ? ORDER BY updated_at DESC`
  ).bind(tenantId, companyId).all()
  return c.json({ projects: res.results })
})

companiesRoute.get('/:companyId/costs', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json({ error: 'company_not_found' }, 404)
  return c.json(await getCompanyCosts(c.env, c.get('tenantId'), company.id))
})

companiesRoute.get('/:companyId/export', async (c) => {
  const snapshot = await exportCompanySnapshot(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!snapshot) return c.json({ error: 'company_not_found' }, 404)
  return c.json(snapshot)
})

companiesRoute.post('/import', zValidator('json', importCompanySchema), async (c) => {
  const payload = c.req.valid('json')
  const created = await importCompanySnapshot(c.env, {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
    name: payload.name,
    snapshot: payload.snapshot,
  })

  return c.json(
    {
      companyId: created.companyId,
      defaultProjectId: created.projectId,
      defaultWorkstreamId: created.workstreamId,
    },
    201
  )
})

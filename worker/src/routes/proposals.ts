import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { upsertAppMemoryEntry } from '../lib/app-memory'
import { upsertProjectSearchIndex } from '../db/project-index'
import { newId } from '../lib/ids'
import { refreshProjectMemoryDocs } from '../lib/project-memory'
import { ensureProjectExists } from '../lib/projects'

const proposalActionSchema = z.object({
  type: z.enum(['task.upsert', 'task.assign', 'epic.upsert', 'member.assign', 'repo.run']),
  payload: z.record(z.unknown()),
})

const createProposalSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  source: z.enum(['agent', 'manual', 'integration']).default('manual'),
  impactLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  actions: z.array(proposalActionSchema).min(1),
  diff: z.record(z.unknown()).optional(),
})

export const proposalsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

export function canModerateRole(role: RequestContext['role']) {
  return role === 'owner' || role === 'admin'
}

async function withTransaction<T>(env: EnvBindings, work: () => Promise<T>) {
  await env.DB.prepare('BEGIN IMMEDIATE TRANSACTION').run()
  try {
    const result = await work()
    await env.DB.prepare('COMMIT').run()
    return result
  } catch (error) {
    await env.DB.prepare('ROLLBACK').run().catch(() => {})
    throw error
  }
}

export async function applyProposalActions(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    projectId: string
    actions: Array<
      | {
          type: 'task.upsert'
          payload: { id?: string; title: string; status: string; assignees?: string[]; tags?: string[] }
        }
      | {
          type: 'task.assign'
          payload: { taskId: string; assigneeId: string }
        }
      | {
          type: 'epic.upsert'
          payload: { id?: string; title: string; objective?: string }
        }
      | {
          type: 'member.assign'
          payload: { memberId: string }
        }
      | {
          type: 'repo.run'
          payload: {
            repoFullName: string
            branch?: string
            files?: Array<{ path: string; content: string }>
            prTitle?: string
            prBody?: string
            commitMessage?: string
          }
        }
    >
  }
) {
  const now = Date.now()
  for (const action of input.actions) {
    if (action.type === 'task.upsert') {
      const itemId = action.payload.id || newId('item')
      const assigneeId = action.payload.assignees?.[0] ?? null
      if (action.payload.id) {
        const existing = await env.DB.prepare(
          `SELECT id FROM items WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1`
        )
          .bind(input.tenantId, input.projectId, action.payload.id)
          .first<{ id: string } | null>()

        if (existing) {
          await env.DB.prepare(
            `UPDATE items
             SET title = ?, status = ?, assignee_id = ?, updated_at = ?
             WHERE tenant_id = ? AND project_id = ? AND id = ?`
          )
            .bind(
              action.payload.title,
              action.payload.status,
              assigneeId,
              now,
              input.tenantId,
              input.projectId,
              action.payload.id
            )
            .run()

          await upsertAppMemoryEntry(env, {
            tenantId: input.tenantId,
            projectId: input.projectId,
            sourceApp: 'taskcenter',
            sourceType: 'item',
            sourceKey: action.payload.id,
            title: action.payload.title,
            content: [`status:${action.payload.status}`, `assignee:${assigneeId ?? 'unassigned'}`].join('\n'),
            summary: `Task updated to ${action.payload.status}`,
            metadata: { status: action.payload.status, assigneeId },
          })
          continue
        }
      }

      const sortRow = await env.DB.prepare(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
         FROM items
         WHERE tenant_id = ? AND project_id = ? AND parent_id IS NULL`
      )
        .bind(input.tenantId, input.projectId)
        .first<{ next_sort: number } | null>()

      await env.DB.prepare(
        `INSERT INTO items (
          id, tenant_id, project_id, parent_id, kind, title, description, status, sort_order,
          created_by, assignee_id, approver_id, execution_mode, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'task', ?, NULL, ?, ?, ?, ?, NULL, 'auto', ?, ?)`
      )
        .bind(
          itemId,
          input.tenantId,
          input.projectId,
          action.payload.title,
          action.payload.status,
          sortRow?.next_sort ?? 1,
          input.userId,
          assigneeId,
          now,
          now
        )
        .run()

      await upsertAppMemoryEntry(env, {
        tenantId: input.tenantId,
        projectId: input.projectId,
        sourceApp: 'taskcenter',
        sourceType: 'item',
        sourceKey: itemId,
        title: action.payload.title,
        content: [`status:${action.payload.status}`, `assignee:${assigneeId ?? 'unassigned'}`].join('\n'),
        summary: `Task created in ${action.payload.status}`,
        metadata: { status: action.payload.status, assigneeId },
      })
      continue
    }

    if (action.type === 'task.assign') {
      const existing = await env.DB.prepare(
        `SELECT id, project_id, title, status
         FROM items
         WHERE tenant_id = ? AND project_id = ? AND id = ?
         LIMIT 1`
      )
        .bind(input.tenantId, input.projectId, action.payload.taskId)
        .first<{ id: string; project_id: string; title: string; status: string } | null>()

      if (!existing) {
        throw new Error(`Task ${action.payload.taskId} was not found in project ${input.projectId}.`)
      }

      await env.DB.prepare(
        `UPDATE items
         SET assignee_id = ?, updated_at = ?
         WHERE tenant_id = ? AND project_id = ? AND id = ?`
      )
        .bind(action.payload.assigneeId, now, input.tenantId, input.projectId, action.payload.taskId)
        .run()

      await upsertAppMemoryEntry(env, {
        tenantId: input.tenantId,
        projectId: input.projectId,
        sourceApp: 'taskcenter',
        sourceType: 'item',
        sourceKey: action.payload.taskId,
        title: existing.title,
        content: [`status:${existing.status}`, `assignee:${action.payload.assigneeId}`].join('\n'),
        summary: 'Task reassigned',
        metadata: { status: existing.status, assigneeId: action.payload.assigneeId },
      })
      continue
    }

    if (action.type === 'epic.upsert') {
      const epicId = action.payload.id || newId('item')
      const existing = action.payload.id
        ? await env.DB.prepare(
            `SELECT id FROM items
             WHERE tenant_id = ? AND project_id = ? AND id = ? AND kind = 'epic'
             LIMIT 1`
          )
            .bind(input.tenantId, input.projectId, action.payload.id)
            .first<{ id: string } | null>()
        : null

      if (existing) {
        await env.DB.prepare(
          `UPDATE items
           SET title = ?, description = ?, updated_at = ?
           WHERE tenant_id = ? AND project_id = ? AND id = ?`
        )
          .bind(
            action.payload.title,
            action.payload.objective ?? null,
            now,
            input.tenantId,
            input.projectId,
            existing.id
          )
          .run()

        await upsertAppMemoryEntry(env, {
          tenantId: input.tenantId,
          projectId: input.projectId,
          sourceApp: 'taskcenter',
          sourceType: 'item',
          sourceKey: existing.id,
          title: action.payload.title,
          content: ['kind:epic', action.payload.objective ?? '', 'status:planned'].filter(Boolean).join('\n'),
          summary: action.payload.objective ?? 'Epic updated',
          metadata: { kind: 'epic', status: 'planned' },
        })
      } else {
        const sortRow = await env.DB.prepare(
          `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
           FROM items
           WHERE tenant_id = ? AND project_id = ? AND parent_id IS NULL`
        )
          .bind(input.tenantId, input.projectId)
          .first<{ next_sort: number } | null>()

        await env.DB.prepare(
          `INSERT INTO items (
            id, tenant_id, project_id, parent_id, kind, title, description, status, sort_order,
            created_by, approver_id, execution_mode, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, 'epic', ?, ?, 'planned', ?, ?, NULL, 'auto', ?, ?)`
        )
          .bind(
            epicId,
            input.tenantId,
            input.projectId,
            action.payload.title,
            action.payload.objective ?? null,
            sortRow?.next_sort ?? 1,
            input.userId,
            now,
            now
          )
          .run()

        await upsertAppMemoryEntry(env, {
          tenantId: input.tenantId,
          projectId: input.projectId,
          sourceApp: 'taskcenter',
          sourceType: 'item',
          sourceKey: epicId,
          title: action.payload.title,
          content: ['kind:epic', action.payload.objective ?? '', 'status:planned'].filter(Boolean).join('\n'),
          summary: action.payload.objective ?? 'Epic created',
          metadata: { kind: 'epic', status: 'planned' },
        })
      }
      continue
    }

    if (action.type === 'member.assign') {
      await env.DB.prepare(
        `INSERT INTO project_member_assignments (
          id, tenant_id, project_id, member_id, assigned_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, project_id, member_id)
        DO UPDATE SET assigned_by = excluded.assigned_by, updated_at = excluded.updated_at`
      )
        .bind(newId('passign'), input.tenantId, input.projectId, action.payload.memberId, input.userId, now, now)
        .run()
      continue
    }

    if (action.type === 'repo.run') {
      // repo.run: GitHub branch + files + PR — requires integration token
      // Best-effort: if no token is available, skip silently
      const link = await env.DB.prepare(
        `SELECT pgl.repo_full_name, sc.access_token
         FROM project_github_links pgl
         LEFT JOIN service_connections sc ON sc.id = pgl.connection_id AND sc.tenant_id = pgl.tenant_id
         WHERE pgl.tenant_id = ? AND pgl.project_id = ?
         LIMIT 1`
      )
        .bind(input.tenantId, input.projectId)
        .first<{ repo_full_name: string | null; access_token: string | null } | null>()
        .catch(() => null)

      const rawRepo = (action.payload.repoFullName as string | null | undefined) || link?.repo_full_name
      if (!rawRepo || !link?.access_token) continue
      const repoName: string = rawRepo

      try {
        const { decryptStoredSecret } = await import('../lib/secrets')
        const { createGitHubBranch, createOrUpdateGitHubFile, createGitHubPullRequest, getDefaultBranch, getRefSha } = await import('../lib/github')
        const maybeToken = await decryptStoredSecret(env, link.access_token)
        if (!maybeToken) continue
        const token: string = maybeToken
        const defaultBranch = await getDefaultBranch(token, repoName)
        const sha = await getRefSha(token, repoName, defaultBranch)
        const branchName = action.payload.branch as string ?? `northstar/repo-run-${now}`
        await createGitHubBranch(token, repoName, branchName, sha)

        const files = (action.payload.files as Array<{ path: string; content: string }> | undefined) ?? []
        for (const file of files) {
          await createOrUpdateGitHubFile(
            token,
            repoName,
            file.path,
            file.content,
            action.payload.commitMessage as string ?? `chore: northstar update ${file.path}`,
            branchName
          )
        }

        if (files.length > 0) {
          const pr = await createGitHubPullRequest(token, repoName, {
            title: action.payload.prTitle as string ?? `Northstar: ${branchName}`,
            body: action.payload.prBody as string ?? 'Created by Northstar agent.',
            head: branchName,
            base: defaultBranch,
          })

          await upsertAppMemoryEntry(env, {
            tenantId: input.tenantId,
            projectId: input.projectId,
            sourceApp: 'github',
            sourceType: 'pull_request',
            sourceKey: String(pr.number),
            title: pr.html_url,
            content: `PR #${pr.number}: ${pr.html_url}`,
            summary: action.payload.prTitle as string ?? branchName,
            metadata: { prNumber: pr.number, prUrl: pr.html_url, branch: branchName },
          })
        }
      } catch {
        // best-effort: continue with other actions
      }
      continue
    }
  }

  // Fan out to company stream listeners.
  try {
    const companyRow = await env.DB.prepare(
      `SELECT company_id FROM projects WHERE tenant_id = ? AND id = ? LIMIT 1`
    )
      .bind(input.tenantId, input.projectId)
      .first<{ company_id: string | null } | null>()
    if (companyRow?.company_id) {
      const { publishCompanyEvent } = await import('../lib/control-plane-live')
      await publishCompanyEvent(env, companyRow.company_id, {
        kind: 'proposal.applied',
        projectId: input.projectId,
        actionCount: input.actions.length,
      })
    }
  } catch {
    // ignore publish failures
  }
}

proposalsRoute.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.query('projectId')
  const status = c.req.query('status')

  const filters: string[] = ['tenant_id = ?']
  const params: Array<string> = [tenantId]

  if (projectId) {
    filters.push('project_id = ?')
    params.push(projectId)
  }

  if (status) {
    filters.push('status = ?')
    params.push(status)
  }

  const result = await c.env.DB.prepare(
    `SELECT id, project_id, source, title, summary, status, impact_level, actions_json, diff_json,
            requested_by, approved_by, approved_at, rejected_by, rejected_at, applied_by, applied_at,
            created_at, updated_at
     FROM proposals
     WHERE ${filters.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 100`
  )
    .bind(...params)
    .all()

  return c.json({ proposals: result.results })
})

proposalsRoute.post(
  '/',
  zValidator('json', createProposalSchema),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const payload = c.req.valid('json')
    const project = await ensureProjectExists(c.env, tenantId, payload.projectId)
    if (!project) {
      return c.json({ error: 'project_not_found' }, 404)
    }
    const now = Date.now()
    const proposalId = newId('proposal')

    await c.env.DB.prepare(
      `INSERT INTO proposals (
        id, tenant_id, project_id, source, title, summary, status, impact_level, actions_json, diff_json,
        requested_by, approved_by, approved_at, rejected_by, rejected_at, applied_by, applied_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    )
      .bind(
        proposalId,
        tenantId,
        payload.projectId,
        payload.source,
        payload.title,
        payload.summary ?? null,
        'draft',
        payload.impactLevel,
        JSON.stringify(payload.actions),
        payload.diff ? JSON.stringify(payload.diff) : null,
        userId,
        now,
        now
      )
      .run()

    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId: payload.projectId,
      sourceApp: 'taskcenter',
      sourceType: 'proposal',
      sourceKey: proposalId,
      title: payload.title,
      content: [payload.summary ?? '', JSON.stringify(payload.actions), JSON.stringify(payload.diff || {})].filter(Boolean).join('\n'),
      summary: `draft proposal (${payload.impactLevel})`,
      metadata: { status: 'draft', impactLevel: payload.impactLevel, source: payload.source },
    }).catch(() => {})

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId: payload.projectId,
    }).catch(() => {})

    return c.json({ id: proposalId }, 201)
  }
)

proposalsRoute.post('/:proposalId/approve', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')

  if (!canModerateRole(role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const proposalId = c.req.param('proposalId')
  const now = Date.now()

  await c.env.DB.prepare(
    `UPDATE proposals
     SET status = 'approved', approved_by = ?, approved_at = ?, rejected_by = NULL, rejected_at = NULL, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(userId, now, now, proposalId, tenantId)
    .run()

  const approved = await c.env.DB.prepare(
    `SELECT project_id, title, summary, impact_level, actions_json
     FROM proposals WHERE id = ? AND tenant_id = ? LIMIT 1`
  )
    .bind(proposalId, tenantId)
    .first<{ project_id: string; title: string; summary: string | null; impact_level: string; actions_json: string } | null>()

  if (approved) {
    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId: approved.project_id,
      sourceApp: 'taskcenter',
      sourceType: 'proposal',
      sourceKey: proposalId,
      title: approved.title,
      content: [approved.summary ?? '', approved.actions_json].filter(Boolean).join('\n'),
      summary: `approved proposal (${approved.impact_level})`,
      metadata: { status: 'approved' },
    }).catch(() => {})

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId: approved.project_id,
    }).catch(() => {})
  }

  return c.json({ ok: true })
})

proposalsRoute.post('/:proposalId/reject', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')

  if (!canModerateRole(role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const proposalId = c.req.param('proposalId')
  const now = Date.now()

  await c.env.DB.prepare(
    `UPDATE proposals
     SET status = 'rejected', rejected_by = ?, rejected_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(userId, now, now, proposalId, tenantId)
    .run()

  const rejected = await c.env.DB.prepare(
    `SELECT project_id, title, summary, impact_level, actions_json
     FROM proposals WHERE id = ? AND tenant_id = ? LIMIT 1`
  )
    .bind(proposalId, tenantId)
    .first<{ project_id: string; title: string; summary: string | null; impact_level: string; actions_json: string } | null>()

  if (rejected) {
    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId: rejected.project_id,
      sourceApp: 'taskcenter',
      sourceType: 'proposal',
      sourceKey: proposalId,
      title: rejected.title,
      content: [rejected.summary ?? '', rejected.actions_json].filter(Boolean).join('\n'),
      summary: `rejected proposal (${rejected.impact_level})`,
      metadata: { status: 'rejected' },
    }).catch(() => {})

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId: rejected.project_id,
    }).catch(() => {})
  }

  return c.json({ ok: true })
})

proposalsRoute.post('/:proposalId/apply', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')

  if (!canModerateRole(role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const proposalId = c.req.param('proposalId')
  const now = Date.now()

  const proposal = await c.env.DB.prepare(
    `SELECT id, title, status, project_id, actions_json FROM proposals WHERE id = ? AND tenant_id = ? LIMIT 1`
  )
    .bind(proposalId, tenantId)
    .first<{ id: string; title: string; status: string; project_id: string; actions_json: string }>()

  if (!proposal) {
    return c.json({ error: 'not_found' }, 404)
  }

  if (proposal.status !== 'approved' && proposal.status !== 'draft') {
    return c.json({ error: 'invalid_status' }, 409)
  }

  const project = await ensureProjectExists(c.env, tenantId, proposal.project_id)
  if (!project) {
    return c.json({ error: 'project_not_found' }, 404)
  }

  const actions = JSON.parse(proposal.actions_json || '[]') as Array<
    | {
        type: 'task.upsert'
        payload: { id?: string; title: string; status: string; assignees?: string[]; tags?: string[] }
      }
    | {
        type: 'task.assign'
        payload: { taskId: string; assigneeId: string }
      }
    | {
        type: 'epic.upsert'
        payload: { id?: string; title: string; objective?: string }
      }
    | {
        type: 'member.assign'
        payload: { memberId: string }
      }
  >

  await withTransaction(c.env, async () => {
    await applyProposalActions(c.env, {
      tenantId,
      userId,
      projectId: proposal.project_id,
      actions,
    })

    await upsertProjectSearchIndex(c.env, {
      tenantId,
      projectId: proposal.project_id,
    })

    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId: proposal.project_id,
      sourceApp: 'taskcenter',
      sourceType: 'proposal',
      sourceKey: proposalId,
      title: proposal.title,
      content: proposal.actions_json,
      summary: 'applied proposal',
      metadata: { status: 'applied' },
    })

    await c.env.DB.prepare(
      `UPDATE proposals
       SET status = 'applied', applied_by = ?, applied_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
      .bind(userId, now, now, proposalId, tenantId)
      .run()

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId: proposal.project_id,
    })
  })

  return c.json({ ok: true })
})

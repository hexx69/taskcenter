import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { newId } from '../lib/ids'
import type { EnvBindings, RequestContext } from '../lib/context'
import { upsertProjectSearchIndex } from '../db/project-index'
import { deleteAppMemoryEntry, upsertAppMemoryEntry } from '../lib/app-memory'
import { ensureProjectExists } from '../lib/projects'
import { generateTenantAiText } from '../agents/orchestrator'
import { refreshProjectMemoryDocs } from '../lib/project-memory'
import { getCompanyForProject, recordCompanyActivity } from '../lib/companies'

const kinds = ['epic', 'story', 'story_point', 'feature', 'task'] as const
const creatableStatuses = ['planned', 'todo', 'in_progress', 'review', 'done'] as const

export const itemsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const issueLikeKinds = new Set(['task', 'feature', 'story', 'story_point'])

function parseJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim())
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // keep trying candidate variants
    }
  }

  return null
}

async function fetchIssueBase(
  env: EnvBindings,
  tenantId: string,
  itemId: string
) {
  return env.DB.prepare(
    `SELECT i.id, i.project_id, i.parent_id, i.title, i.issue_key, i.kind
     FROM items i
     WHERE i.tenant_id = ? AND i.id = ?
     LIMIT 1`
  ).bind(tenantId, itemId).first<{
    id: string
    project_id: string
    parent_id: string | null
    title: string
    issue_key: string | null
    kind: string
  } | null>()
}

async function allocateIssueKey(
  env: EnvBindings,
  input: { tenantId: string; projectId: string }
) {
  const company = await getCompanyForProject(env, input.tenantId, input.projectId)
  const prefix = company?.issue_prefix || 'ISS'

  const keys = await env.DB.prepare(
    `SELECT i.issue_key
     FROM items i
     JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
     WHERE i.tenant_id = ? AND p.company_id = ? AND i.issue_key IS NOT NULL AND i.issue_key != ''`
  )
    .bind(input.tenantId, company?.id || '')
    .all<{ issue_key: string | null }>()

  const max = keys.results.reduce((highest, row) => {
    const match = row.issue_key?.match(/-(\d+)$/)
    const value = match ? Number.parseInt(match[1] || '0', 10) : 0
    return Number.isFinite(value) && value > highest ? value : highest
  }, 0)

  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

async function createIssueSystemComment(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId: string
    itemId: string
    companyId?: string | null
    body: string
    sourceType?: 'human' | 'agent' | 'system'
    authorUserId?: string | null
    authorName?: string | null
    authorEmail?: string | null
    metadata?: Record<string, unknown> | null
  }
) {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO issue_comments (
      id, tenant_id, company_id, project_id, item_id, author_user_id, author_name, author_email, source_type, body, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('icmt'),
      input.tenantId,
      input.companyId ?? null,
      input.projectId,
      input.itemId,
      input.authorUserId ?? null,
      input.authorName ?? null,
      input.authorEmail ?? null,
      input.sourceType ?? 'system',
      input.body,
      JSON.stringify(input.metadata || {}),
      now,
      now
    )
    .run()
}

async function maybeEnhanceManualItem(
  env: EnvBindings,
  context: { tenantId: string; userId: string; userEmail: string | null },
  input: {
    projectId: string
    projectName: string
    kind: (typeof kinds)[number]
    title: string
    description?: string | null
    status: (typeof creatableStatuses)[number]
    executionMode: 'manual' | 'auto'
  }
) {
  const shouldEnhance =
    input.executionMode === 'manual' &&
    (input.kind === 'task' || input.kind === 'feature' || input.kind === 'story_point') &&
    (!input.description || input.description.trim().length < 24)

  if (!shouldEnhance) {
    return {
      title: input.title.trim(),
      description: input.description?.trim() || null,
      aiEnhanced: false,
    }
  }

  const prompt = [
    'Rewrite the new work item into a more execution-ready version and return only valid JSON.',
    'Required shape:',
    '{"title":"string","description":"string"}',
    'Rules:',
    '- Keep the title specific, crisp, and implementation-ready.',
    '- Write the description in plain text, not markdown tables.',
    '- Make the description 3 short sections separated by blank lines.',
    '- Section 1 must start with "Objective:".',
    '- Section 2 must start with "Scope:" and use dash bullets.',
    '- Section 3 must start with "Done criteria:" and use dash bullets.',
    '- Do not invent dates, people, approvals, or completed work.',
    '- Stay grounded in the project context and the user input.',
    `Project: ${input.projectName}`,
    `Item kind: ${input.kind}`,
    `Requested status: ${input.status}`,
    `User title: ${input.title}`,
    `User description: ${input.description?.trim() || 'None provided'}`,
  ].join('\n')

  const result = await generateTenantAiText(env, context, {
    featureKey: 'item.ai_enhance',
    system: 'You are TaskCenter item intake. Turn rough task or issue capture into a sharper title and a concrete execution brief. Return strict JSON only.',
    prompt,
    maxOutputTokens: 420,
    metadata: {
      projectId: input.projectId,
      projectName: input.projectName,
      kind: input.kind,
      phase: 'item-intake-enhancement',
    },
  })

  const parsed = parseJsonObject<{ title?: string; description?: string }>(result.text)
  const nextTitle = parsed?.title?.trim() || input.title.trim()
  const nextDescription = parsed?.description?.trim() || input.description?.trim() || null

  return {
    title: nextTitle,
    description: nextDescription,
    aiEnhanced: Boolean(parsed?.title || parsed?.description),
  }
}

itemsRoute.get(
  '/',
  zValidator(
    'query',
    z.object({
      projectId: z.string().min(1)
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const { projectId } = c.req.valid('query')

    const res = await c.env.DB.prepare(
      `SELECT id, project_id, parent_id, kind, title, description, status, sort_order,
              created_by, assignee_id, approver_id, issue_key, priority, goal_id, execution_mode, created_at, updated_at
       FROM items
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY sort_order ASC, created_at ASC`
    )
      .bind(tenantId, projectId)
      .all()

    return c.json({ items: res.results })
  }
)

itemsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      projectId: z.string().min(1),
      parentId: z.string().nullable().optional(),
      kind: z.enum(kinds),
      title: z.string().min(1),
      description: z.string().optional(),
      assigneeId: z.string().nullable().optional(),
      executionMode: z.enum(['manual', 'auto']).default('manual'),
      status: z.enum(creatableStatuses).default('planned'),
      priority: z.enum(['low', 'medium', 'high']).default('medium'),
      goalId: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const now = Date.now()

    const { projectId, parentId, kind, title, description, assigneeId, executionMode, status, priority, goalId } = c.req.valid('json')
    const project = await ensureProjectExists(c.env, tenantId, projectId)
    if (!project) {
      return c.json({ error: 'project_not_found' }, 404)
    }
    const company = await getCompanyForProject(c.env, tenantId, projectId)

    const enhanced = await maybeEnhanceManualItem(c.env, { tenantId, userId, userEmail }, {
      projectId,
      projectName: project.name,
      kind,
      title,
      description,
      status,
      executionMode,
    }).catch(() => ({
      title: title.trim(),
      description: description?.trim() || null,
      aiEnhanced: false,
    }))

    const id = newId('item')
    const issueKey = issueLikeKinds.has(kind) ? await allocateIssueKey(c.env, { tenantId, projectId }) : null

    const sortRes = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
       FROM items
       WHERE tenant_id = ? AND project_id = ? AND (parent_id IS ? OR parent_id = ?)`
    )
      .bind(tenantId, projectId, parentId ?? null, parentId ?? null)
      .first<{ next_sort: number }>()

    const sortOrder = sortRes?.next_sort ?? 1

    await c.env.DB.prepare(
      `INSERT INTO items (
        id, tenant_id, project_id, parent_id, kind, title, description, status, sort_order,
        created_by, assignee_id, approver_id, issue_key, priority, goal_id, execution_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        projectId,
        parentId ?? null,
        kind,
        enhanced.title,
        enhanced.description,
        status,
        sortOrder,
        userId,
        assigneeId ?? null,
        null,
        issueKey,
        priority,
        goalId ?? null,
        executionMode,
        now,
        now
      )
      .run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId,
        category: 'issue_created',
        message: `Created ${issueKey || 'issue'} ${enhanced.title}.`,
        metadata: { itemId: id, issueKey, goalId: goalId ?? null, priority },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId,
        itemId: id,
        body: `Issue created${goalId ? ' and linked to a goal' : ''}.`,
        metadata: { event: 'issue_created', issueKey, priority, goalId: goalId ?? null },
      }).catch(() => {})
    }

    await upsertProjectSearchIndex(c.env, {
      tenantId,
      projectId,
      extraTexts: [enhanced.title, enhanced.description ?? ''],
    })

    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId,
      sourceApp: 'taskcenter',
      sourceType: 'item',
      sourceKey: id,
      title: enhanced.title,
      content: [kind, enhanced.description ?? '', executionMode].filter(Boolean).join('\n'),
      summary: enhanced.description ?? `${kind} item`,
      metadata: { parentId: parentId ?? null, status, aiEnhanced: enhanced.aiEnhanced },
    }).catch(() => {})

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId,
    }).catch(() => {})

    return c.json(
      {
        id,
        item: {
          id,
          project_id: projectId,
          parent_id: parentId ?? null,
          kind,
          title: enhanced.title,
          description: enhanced.description,
          status,
          sort_order: sortOrder,
          assignee_id: assigneeId ?? null,
          issue_key: issueKey,
          priority,
          goal_id: goalId ?? null,
          created_at: now,
          updated_at: now,
        },
        aiEnhanced: enhanced.aiEnhanced,
      },
      201
    )
  }
)

itemsRoute.patch(
  '/:itemId',
  zValidator(
    'json',
    z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      status: z.string().min(1).optional(),
      assigneeId: z.string().nullable().optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      goalId: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const itemId = c.req.param('itemId')
    const now = Date.now()
    const payload = c.req.valid('json')

    const existing = await c.env.DB.prepare(
      `SELECT id, project_id, title, description, status, assignee_id, issue_key, priority, goal_id
       FROM items
       WHERE tenant_id = ? AND id = ?
       LIMIT 1`
    )
      .bind(tenantId, itemId)
      .first<{
        id: string
        project_id: string
        title: string
        description: string | null
        status: string
        assignee_id: string | null
        issue_key: string | null
        priority: string | null
        goal_id: string | null
      }>()

    if (!existing) {
      return c.json({ error: 'item_not_found' }, 404)
    }

    const nextTitle = payload.title ?? existing.title
    const nextDescription = payload.description === undefined ? existing.description : payload.description
    const nextStatus = payload.status ?? existing.status
    const nextAssigneeId = payload.assigneeId === undefined ? existing.assignee_id : payload.assigneeId
    const nextPriority = payload.priority ?? existing.priority ?? 'medium'
    const nextGoalId = payload.goalId === undefined ? existing.goal_id : payload.goalId
    const company = await getCompanyForProject(c.env, tenantId, existing.project_id)

    await c.env.DB.prepare(
      `UPDATE items
       SET title = ?, description = ?, status = ?, assignee_id = ?, priority = ?, goal_id = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    )
      .bind(nextTitle, nextDescription, nextStatus, nextAssigneeId, nextPriority, nextGoalId, now, tenantId, itemId)
      .run()

    await upsertProjectSearchIndex(c.env, {
      tenantId,
      projectId: existing.project_id,
      extraTexts: [nextTitle, nextDescription ?? ''],
    })

    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId: existing.project_id,
      sourceApp: 'taskcenter',
      sourceType: 'item',
      sourceKey: itemId,
      title: nextTitle,
      content: [nextDescription ?? '', `status:${nextStatus}`, `assignee:${nextAssigneeId ?? 'unassigned'}`].filter(Boolean).join('\n'),
      summary: nextDescription ?? `Item status ${nextStatus}`,
      metadata: { status: nextStatus, assigneeId: nextAssigneeId, priority: nextPriority, goalId: nextGoalId },
    }).catch(() => {})

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: existing.project_id,
        category: 'issue_updated',
        message: `Updated ${existing.issue_key || 'issue'} ${nextTitle}.`,
        metadata: { itemId: itemId, issueKey: existing.issue_key, status: nextStatus, priority: nextPriority, goalId: nextGoalId },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId: existing.project_id,
        itemId,
        body: `Issue updated: status ${nextStatus}, priority ${nextPriority}${nextGoalId ? ', goal linked' : ''}.`,
        metadata: { event: 'issue_updated', issueKey: existing.issue_key, status: nextStatus, priority: nextPriority, goalId: nextGoalId },
      }).catch(() => {})
    }

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId: existing.project_id,
    }).catch(() => {})

    return c.json({ ok: true })
  }
)

itemsRoute.delete('/:itemId', async (c) => {
  const tenantId = c.get('tenantId')
  const itemId = c.req.param('itemId')

  const existing = await c.env.DB.prepare(
    `SELECT id, project_id, kind
     FROM items
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, itemId)
    .first<{ id: string; project_id: string; kind: string }>()

  if (!existing) {
    return c.json({ error: 'item_not_found' }, 404)
  }

  const company = await getCompanyForProject(c.env, tenantId, existing.project_id)

  await c.env.DB.prepare(
    `DELETE FROM items
     WHERE tenant_id = ? AND (id = ? OR parent_id = ?)`
  )
    .bind(tenantId, itemId, itemId)
    .run()
  await c.env.DB.prepare(`DELETE FROM issue_comments WHERE tenant_id = ? AND item_id = ?`).bind(tenantId, itemId).run()
  await c.env.DB.prepare(`DELETE FROM issue_attachment_blobs WHERE tenant_id = ? AND attachment_id IN (SELECT id FROM issue_attachments WHERE tenant_id = ? AND item_id = ?)`).bind(tenantId, tenantId, itemId).run()
  await c.env.DB.prepare(`DELETE FROM issue_attachments WHERE tenant_id = ? AND item_id = ?`).bind(tenantId, itemId).run()
  await c.env.DB.prepare(`DELETE FROM issue_documents WHERE tenant_id = ? AND item_id = ?`).bind(tenantId, itemId).run()
  await c.env.DB.prepare(`DELETE FROM issue_approvals WHERE tenant_id = ? AND item_id = ?`).bind(tenantId, itemId).run()

  await deleteAppMemoryEntry(c.env, {
    tenantId,
    sourceApp: 'taskcenter',
    sourceType: existing.kind,
    sourceKey: itemId,
  }).catch(() => {})
  await deleteAppMemoryEntry(c.env, {
    tenantId,
    sourceApp: 'taskcenter',
    sourceType: 'item',
    sourceKey: itemId,
  }).catch(() => {})

  await upsertProjectSearchIndex(c.env, {
    tenantId,
    projectId: existing.project_id,
    extraTexts: [],
  })

  await refreshProjectMemoryDocs(c.env, {
    tenantId,
    projectId: existing.project_id,
  }).catch(() => {})

  if (company) {
    await recordCompanyActivity(c.env, {
      tenantId,
      companyId: company.id,
      projectId: existing.project_id,
      category: 'issue_deleted',
      message: `Deleted issue ${itemId}.`,
      metadata: { itemId },
    }).catch(() => {})
  }

  return c.json({ ok: true })
})

itemsRoute.get('/:itemId/detail', async (c) => {
  const tenantId = c.get('tenantId')
  const itemId = c.req.param('itemId')

  const item = await c.env.DB.prepare(
    `SELECT i.*, p.name AS project_name, p.company_id, c.name AS company_name, c.issue_prefix, cg.title AS goal_title
     FROM items i
     JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
     LEFT JOIN companies c ON c.id = p.company_id AND c.tenant_id = p.tenant_id
     LEFT JOIN company_goals cg ON cg.id = i.goal_id AND cg.tenant_id = i.tenant_id
     WHERE i.tenant_id = ? AND i.id = ?
     LIMIT 1`
  )
    .bind(tenantId, itemId)
    .first<Record<string, unknown> | null>()

  if (!item) return c.json({ error: 'item_not_found' }, 404)

  const [comments, attachments, documents, approvals, sessions, subissues, parentIssue] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, author_user_id, author_name, author_email, source_type, body, metadata_json, created_at, updated_at
       FROM issue_comments
       WHERE tenant_id = ? AND item_id = ?
       ORDER BY created_at ASC`
    ).bind(tenantId, itemId).all(),
    c.env.DB.prepare(
      `SELECT id, kind, title, url, mime_type, metadata_json, created_at, updated_at
       FROM issue_attachments
       WHERE tenant_id = ? AND item_id = ?
       ORDER BY created_at DESC`
    ).bind(tenantId, itemId).all(),
    c.env.DB.prepare(
      `SELECT id, title, summary, body_markdown, metadata_json, created_at, updated_at
       FROM issue_documents
       WHERE tenant_id = ? AND item_id = ?
       ORDER BY created_at DESC`
    ).bind(tenantId, itemId).all(),
    c.env.DB.prepare(
      `SELECT id, status, title, summary, payload_json, requested_by, decided_by, decided_at, created_at, updated_at
       FROM issue_approvals
       WHERE tenant_id = ? AND item_id = ?
       ORDER BY updated_at DESC`
    ).bind(tenantId, itemId).all(),
    c.env.DB.prepare(
      `SELECT id, mode, provider, transport, status, title, summary, updated_at, started_at, completed_at
       FROM execution_sessions
       WHERE tenant_id = ? AND item_id = ?
       ORDER BY updated_at DESC`
    ).bind(tenantId, itemId).all(),
    c.env.DB.prepare(
      `SELECT id, issue_key, kind, title, status, assignee_id, updated_at
       FROM items
       WHERE tenant_id = ? AND parent_id = ?
       ORDER BY updated_at DESC, created_at DESC`
    ).bind(tenantId, itemId).all(),
    item.parent_id
      ? c.env.DB.prepare(
          `SELECT id, issue_key, kind, title, status, assignee_id, updated_at
           FROM items
           WHERE tenant_id = ? AND id = ?
           LIMIT 1`
        ).bind(tenantId, item.parent_id).first()
      : Promise.resolve(null),
  ])

  const commentActivity = comments.results.map((row) => ({
    id: String(row.id),
    kind: 'comment',
    message: String(row.body || ''),
    actorName: String(row.author_name || row.author_email || row.source_type || 'system'),
    createdAt: Number(row.created_at || 0),
    sourceType: String(row.source_type || 'human'),
    metadata: parseJsonObject<Record<string, unknown>>(String(row.metadata_json || '{}')) || {},
  }))
  const sessionActivity = sessions.results.map((row) => ({
    id: String(row.id),
    kind: 'execution_session',
    message: `${String(row.title || 'Execution session')} is ${String(row.status || 'unknown')}.`,
    actorName: String(row.provider || row.transport || 'runtime'),
    createdAt: Number(row.updated_at || 0),
    sourceType: 'system',
    metadata: { status: row.status, mode: row.mode, transport: row.transport },
  }))
  const approvalActivity = approvals.results.map((row) => ({
    id: String(row.id),
    kind: 'approval',
    message: `${String(row.title || 'Approval')} is ${String(row.status || 'pending')}.`,
    actorName: 'approval',
    createdAt: Number(row.updated_at || 0),
    sourceType: 'system',
    metadata: parseJsonObject<Record<string, unknown>>(String(row.payload_json || '{}')) || {},
  }))

  return c.json({
    issue: {
      id: String(item.id),
      issueKey: item.issue_key || `${item.issue_prefix || 'ISS'}-${String(item.id).slice(-3).toUpperCase()}`,
      projectId: String(item.project_id),
      projectName: item.project_name || null,
      companyId: item.company_id || null,
      companyName: item.company_name || null,
      kind: String(item.kind),
      title: String(item.title),
      description: item.description || null,
      status: String(item.status),
      priority: String(item.priority || 'medium'),
      assigneeId: item.assignee_id || null,
      approverId: item.approver_id || null,
      goalId: item.goal_id || null,
      goalTitle: item.goal_title || null,
      executionMode: String(item.execution_mode),
      createdAt: Number(item.created_at || 0),
      updatedAt: Number(item.updated_at || 0),
    },
    comments: comments.results.map((row) => ({
      id: row.id,
      authorUserId: row.author_user_id,
      authorName: row.author_name,
      authorEmail: row.author_email,
      sourceType: row.source_type,
      body: row.body,
      metadata: parseJsonObject<Record<string, unknown>>(String(row.metadata_json || '{}')) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    attachments: attachments.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      url: row.url,
      mimeType: row.mime_type,
      metadata: parseJsonObject<Record<string, unknown>>(String(row.metadata_json || '{}')) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    documents: documents.results.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      bodyMarkdown: row.body_markdown,
      metadata: parseJsonObject<Record<string, unknown>>(String(row.metadata_json || '{}')) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    approvals: approvals.results.map((row) => ({
      id: row.id,
      status: row.status,
      title: row.title,
      summary: row.summary,
      payload: parseJsonObject<Record<string, unknown>>(String(row.payload_json || '{}')) || {},
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    executionSessions: sessions.results.map((row) => ({
      id: row.id,
      mode: row.mode,
      provider: row.provider,
      transport: row.transport,
      status: row.status,
      title: row.title,
      summary: row.summary,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
    parentIssue: parentIssue
      ? {
          id: String(parentIssue.id),
          issueKey: String(parentIssue.issue_key || ''),
          kind: String(parentIssue.kind || 'task'),
          title: String(parentIssue.title || ''),
          status: String(parentIssue.status || 'todo'),
          assigneeId: parentIssue.assignee_id || null,
          updatedAt: Number(parentIssue.updated_at || 0),
        }
      : null,
    subissues: subissues.results.map((row) => ({
      id: String(row.id),
      issueKey: String(row.issue_key || ''),
      kind: String(row.kind || 'task'),
      title: String(row.title || ''),
      status: String(row.status || 'todo'),
      assigneeId: row.assignee_id || null,
      updatedAt: Number(row.updated_at || 0),
    })),
    activity: [...commentActivity, ...sessionActivity, ...approvalActivity].sort((left, right) => right.createdAt - left.createdAt),
  })
})

itemsRoute.get('/:itemId/comments', async (c) => {
  const tenantId = c.get('tenantId')
  const itemId = c.req.param('itemId')
  const comments = await c.env.DB.prepare(
    `SELECT id, author_user_id, author_name, author_email, source_type, body, metadata_json, created_at, updated_at
     FROM issue_comments
     WHERE tenant_id = ? AND item_id = ?
     ORDER BY created_at ASC`
  ).bind(tenantId, itemId).all()
  return c.json({
    comments: comments.results.map((row) => ({
      id: row.id,
      authorUserId: row.author_user_id,
      authorName: row.author_name,
      authorEmail: row.author_email,
      sourceType: row.source_type,
      body: row.body,
      metadata: parseJsonObject<Record<string, unknown>>(String(row.metadata_json || '{}')) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  })
})

itemsRoute.post(
  '/:itemId/comments',
  zValidator('json', z.object({ body: z.string().min(1), sourceType: z.enum(['human', 'agent', 'system']).optional() })),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userName = c.get('userName')
    const userEmail = c.get('userEmail')
    const itemId = c.req.param('itemId')
    const { body, sourceType } = c.req.valid('json')

    const item = await c.env.DB.prepare(
      `SELECT id, project_id, issue_key
       FROM items
       WHERE tenant_id = ? AND id = ?
       LIMIT 1`
    ).bind(tenantId, itemId).first<{ id: string; project_id: string; issue_key: string | null } | null>()
    if (!item) return c.json({ error: 'item_not_found' }, 404)
    const company = await getCompanyForProject(c.env, tenantId, item.project_id)

    const now = Date.now()
    const id = newId('icmt')
    await c.env.DB.prepare(
      `INSERT INTO issue_comments (
        id, tenant_id, company_id, project_id, item_id, author_user_id, author_name, author_email, source_type, body, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        company?.id ?? null,
        item.project_id,
        itemId,
        userId,
        userName,
        userEmail,
        sourceType || 'human',
        body.trim(),
        JSON.stringify({ issueKey: item.issue_key }),
        now,
        now
      )
      .run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue_comment',
        message: `${userName || userEmail || 'Someone'} commented on ${item.issue_key || 'an issue'}.`,
        metadata: { itemId, issueKey: item.issue_key, commentId: id },
      }).catch(() => {})
    }

    return c.json({
      comment: {
        id,
        authorUserId: userId,
        authorName: userName,
        authorEmail: userEmail,
        sourceType: sourceType || 'human',
        body: body.trim(),
        metadata: { issueKey: item.issue_key },
        createdAt: now,
        updatedAt: now,
      },
    }, 201)
  }
)

itemsRoute.post(
  '/:itemId/attachments',
  zValidator(
    'json',
    z.object({
      title: z.string().min(1),
      kind: z.string().min(1).default('artifact'),
      url: z.string().url().optional().nullable(),
      mimeType: z.string().optional().nullable(),
      metadata: z.record(z.unknown()).optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userName = c.get('userName')
    const userEmail = c.get('userEmail')
    const itemId = c.req.param('itemId')
    const payload = c.req.valid('json')
    const item = await fetchIssueBase(c.env, tenantId, itemId)
    if (!item) return c.json({ error: 'item_not_found' }, 404)
    const company = await getCompanyForProject(c.env, tenantId, item.project_id)
    const now = Date.now()
    const id = newId('iatt')
    await c.env.DB.prepare(
      `INSERT INTO issue_attachments (
        id, tenant_id, company_id, project_id, item_id, kind, title, url, mime_type, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        company?.id ?? null,
        item.project_id,
        itemId,
        payload.kind,
        payload.title.trim(),
        payload.url ?? null,
        payload.mimeType ?? null,
        JSON.stringify(payload.metadata || {}),
        now,
        now
      )
      .run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue_attachment_added',
        message: `${userName || userEmail || 'Someone'} attached "${payload.title.trim()}" to ${item.issue_key || 'an issue'}.`,
        metadata: { itemId, issueKey: item.issue_key, attachmentId: id, kind: payload.kind },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        itemId,
        body: `Added attachment: ${payload.title.trim()}.`,
        metadata: { event: 'issue_attachment_added', attachmentId: id, issueKey: item.issue_key },
      }).catch(() => {})
    }

    return c.json({
      attachment: {
        id,
        kind: payload.kind,
        title: payload.title.trim(),
        url: payload.url ?? null,
        mimeType: payload.mimeType ?? null,
        metadata: payload.metadata || {},
        createdAt: now,
        updatedAt: now,
      },
    }, 201)
  }
)

itemsRoute.post(
  '/:itemId/attachments/upload',
  zValidator(
    'json',
    z.object({
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      base64Data: z.string().min(1),
      title: z.string().optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userName = c.get('userName')
    const userEmail = c.get('userEmail')
    const itemId = c.req.param('itemId')
    const payload = c.req.valid('json')
    const item = await fetchIssueBase(c.env, tenantId, itemId)
    if (!item) return c.json({ error: 'item_not_found' }, 404)
    const company = await getCompanyForProject(c.env, tenantId, item.project_id)
    const now = Date.now()
    const base64Data = payload.base64Data.trim()
    const sizeBytes = Math.floor((base64Data.length * 3) / 4)
    if (sizeBytes > 5 * 1024 * 1024) {
      return c.json({ error: 'attachment_too_large', message: 'Attachments are currently limited to 5 MB.' }, 400)
    }

    const id = newId('iatt')
    await c.env.DB.prepare(
      `INSERT INTO issue_attachments (
        id, tenant_id, company_id, project_id, item_id, kind, title, url, mime_type, metadata_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        company?.id ?? null,
        item.project_id,
        itemId,
        payload.title?.trim() || payload.fileName,
        `/api/items/${encodeURIComponent(itemId)}/attachments/${id}/content`,
        payload.mimeType,
        JSON.stringify({ fileName: payload.fileName, storage: 'inline_db' }),
        userId,
        now,
        now
      )
      .run()
    await c.env.DB.prepare(
      `INSERT INTO issue_attachment_blobs (
        attachment_id, tenant_id, file_name, size_bytes, content_base64, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(id, tenantId, payload.fileName, sizeBytes, base64Data, now)
      .run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue_attachment_uploaded',
        message: `${userName || userEmail || 'Someone'} uploaded "${payload.fileName}" to ${item.issue_key || 'an issue'}.`,
        metadata: { itemId, issueKey: item.issue_key, attachmentId: id, sizeBytes },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        itemId,
        body: `Uploaded file: ${payload.fileName}.`,
        metadata: { event: 'issue_attachment_uploaded', attachmentId: id, issueKey: item.issue_key, fileName: payload.fileName },
      }).catch(() => {})
    }

    return c.json({
      attachment: {
        id,
        kind: 'upload',
        title: payload.title?.trim() || payload.fileName,
        url: `/api/items/${encodeURIComponent(itemId)}/attachments/${id}/content`,
        mimeType: payload.mimeType,
        metadata: { fileName: payload.fileName, storage: 'inline_db', sizeBytes },
        createdAt: now,
        updatedAt: now,
      },
    }, 201)
  }
)

itemsRoute.get('/:itemId/attachments/:attachmentId/content', async (c) => {
  const tenantId = c.get('tenantId')
  const itemId = c.req.param('itemId')
  const attachmentId = c.req.param('attachmentId')
  const attachment = await c.env.DB.prepare(
    `SELECT a.title, a.mime_type, b.file_name, b.content_base64
     FROM issue_attachments a
     JOIN issue_attachment_blobs b ON b.attachment_id = a.id AND b.tenant_id = a.tenant_id
     WHERE a.tenant_id = ? AND a.item_id = ? AND a.id = ?
     LIMIT 1`
  )
    .bind(tenantId, itemId, attachmentId)
    .first<{ title: string; mime_type: string | null; file_name: string; content_base64: string } | null>()
  if (!attachment) return c.json({ error: 'attachment_not_found' }, 404)
  const binary = atob(attachment.content_base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': attachment.mime_type || 'application/octet-stream',
      'content-disposition': `inline; filename="${attachment.file_name || attachment.title}"`,
      'cache-control': 'private, max-age=60',
    },
  })
})

itemsRoute.post(
  '/:itemId/documents',
  zValidator(
    'json',
    z.object({
      title: z.string().min(1),
      summary: z.string().optional().nullable(),
      bodyMarkdown: z.string().optional().nullable(),
      metadata: z.record(z.unknown()).optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userName = c.get('userName')
    const userEmail = c.get('userEmail')
    const itemId = c.req.param('itemId')
    const payload = c.req.valid('json')
    const item = await fetchIssueBase(c.env, tenantId, itemId)
    if (!item) return c.json({ error: 'item_not_found' }, 404)
    const company = await getCompanyForProject(c.env, tenantId, item.project_id)
    const now = Date.now()
    const id = newId('idoc')
    await c.env.DB.prepare(
      `INSERT INTO issue_documents (
        id, tenant_id, company_id, project_id, item_id, title, summary, body_markdown, metadata_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        company?.id ?? null,
        item.project_id,
        itemId,
        payload.title.trim(),
        payload.summary ?? null,
        payload.bodyMarkdown ?? null,
        JSON.stringify(payload.metadata || {}),
        userId,
        now,
        now
      )
      .run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue_document_added',
        message: `${userName || userEmail || 'Someone'} added work product "${payload.title.trim()}" to ${item.issue_key || 'an issue'}.`,
        metadata: { itemId, issueKey: item.issue_key, documentId: id },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        itemId,
        body: `Added work product: ${payload.title.trim()}.`,
        metadata: { event: 'issue_document_added', documentId: id, issueKey: item.issue_key },
      }).catch(() => {})
    }

    return c.json({
      document: {
        id,
        title: payload.title.trim(),
        summary: payload.summary ?? null,
        bodyMarkdown: payload.bodyMarkdown ?? null,
        metadata: payload.metadata || {},
        createdAt: now,
        updatedAt: now,
      },
    }, 201)
  }
)

itemsRoute.post(
  '/:itemId/approvals',
  zValidator(
    'json',
    z.object({
      title: z.string().min(1),
      summary: z.string().optional().nullable(),
      payload: z.record(z.unknown()).optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userName = c.get('userName')
    const userEmail = c.get('userEmail')
    const itemId = c.req.param('itemId')
    const payload = c.req.valid('json')
    const item = await fetchIssueBase(c.env, tenantId, itemId)
    if (!item) return c.json({ error: 'item_not_found' }, 404)
    const company = await getCompanyForProject(c.env, tenantId, item.project_id)
    const now = Date.now()
    const id = newId('iapr')
    await c.env.DB.prepare(
      `INSERT INTO issue_approvals (
        id, tenant_id, company_id, project_id, item_id, status, title, summary, payload_json, requested_by, decided_by, decided_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        company?.id ?? null,
        item.project_id,
        itemId,
        payload.title.trim(),
        payload.summary ?? null,
        JSON.stringify(payload.payload || {}),
        userName || userEmail || 'unknown',
        now,
        now
      )
      .run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue_approval_requested',
        message: `${userName || userEmail || 'Someone'} requested approval "${payload.title.trim()}" on ${item.issue_key || 'an issue'}.`,
        metadata: { itemId, issueKey: item.issue_key, approvalId: id },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        itemId,
        body: `Requested approval: ${payload.title.trim()}.`,
        metadata: { event: 'issue_approval_requested', approvalId: id, issueKey: item.issue_key },
      }).catch(() => {})
    }

    return c.json({
      approval: {
        id,
        status: 'pending',
        title: payload.title.trim(),
        summary: payload.summary ?? null,
        payload: payload.payload || {},
        requestedBy: userName || userEmail || 'unknown',
        decidedBy: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    }, 201)
  }
)

itemsRoute.patch(
  '/:itemId/approvals/:approvalId',
  zValidator('json', z.object({ decision: z.enum(['approved', 'rejected']) })),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userName = c.get('userName')
    const userEmail = c.get('userEmail')
    const itemId = c.req.param('itemId')
    const approvalId = c.req.param('approvalId')
    const { decision } = c.req.valid('json')
    const item = await fetchIssueBase(c.env, tenantId, itemId)
    if (!item) return c.json({ error: 'item_not_found' }, 404)
    const company = await getCompanyForProject(c.env, tenantId, item.project_id)
    const existing = await c.env.DB.prepare(
      `SELECT id, title, status
       FROM issue_approvals
       WHERE tenant_id = ? AND item_id = ? AND id = ?
       LIMIT 1`
    ).bind(tenantId, itemId, approvalId).first<{ id: string; title: string; status: string } | null>()
    if (!existing) return c.json({ error: 'approval_not_found' }, 404)
    const now = Date.now()
    await c.env.DB.prepare(
      `UPDATE issue_approvals
       SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(decision, userId, now, now, tenantId, approvalId).run()

    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue_approval_decided',
        message: `${userName || userEmail || 'Someone'} ${decision} "${existing.title}" on ${item.issue_key || 'an issue'}.`,
        metadata: { itemId, issueKey: item.issue_key, approvalId, decision },
      }).catch(() => {})
      await createIssueSystemComment(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        itemId,
        body: `${existing.title} ${decision}.`,
        metadata: { event: 'issue_approval_decided', approvalId, decision, issueKey: item.issue_key },
      }).catch(() => {})
    }

    return c.json({ ok: true, decision, decidedAt: now })
  }
)


itemsRoute.post(
  '/:itemId/claim',
  zValidator('json', z.object({ agentId: z.string().min(1) })),
  async (c) => {
    const tenantId = c.get('tenantId')
    const { itemId } = c.req.param()
    const { agentId } = c.req.valid('json')

    const item = await c.env.DB.prepare(
      `SELECT id, project_id, assignee_id, assignee_agent_id, title, issue_key
       FROM items WHERE tenant_id = ? AND id = ? LIMIT 1`
    )
      .bind(tenantId, itemId)
      .first<{
        id: string
        project_id: string
        assignee_id: string | null
        assignee_agent_id: string | null
        title: string
        issue_key: string | null
      } | null>()

    if (!item) return c.json({ error: 'not_found' }, 404)

    const now = Date.now()
    await c.env.DB.prepare(
      `UPDATE items SET assignee_agent_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(agentId, now, tenantId, itemId).run()

    const company = await getCompanyForProject(c.env, tenantId, item.project_id)
    if (company) {
      await recordCompanyActivity(c.env, {
        tenantId,
        companyId: company.id,
        projectId: item.project_id,
        category: 'issue',
        severity: 'info',
        message: 'Claimed',
        metadata: { issueId: itemId, agentId },
      }).catch(() => {})
    }

    const updated = await c.env.DB.prepare(
      `SELECT id, project_id, parent_id, kind, title, description, status, sort_order,
              created_by, assignee_id, assignee_agent_id, approver_id, issue_key, priority, goal_id, execution_mode, created_at, updated_at
       FROM items WHERE tenant_id = ? AND id = ? LIMIT 1`
    )
      .bind(tenantId, itemId)
      .first<Record<string, unknown> | null>()

    return c.json({ ok: true, item: updated })
  }
)

itemsRoute.post('/:itemId/release', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { itemId } = c.req.param()

  const item = await c.env.DB.prepare(
    `SELECT id, project_id, assignee_id, title FROM items WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, itemId)
    .first<{ id: string; project_id: string; assignee_id: string | null; title: string } | null>()

  if (!item) return c.json({ error: 'not_found' }, 404)
  if (item.assignee_id !== userId) return c.json({ error: 'not_your_assignment' }, 403)

  const now = Date.now()
  await c.env.DB.prepare(
    `UPDATE items SET assignee_id = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?`
  ).bind(now, tenantId, itemId).run()

  await createIssueSystemComment(c.env, {
    tenantId,
    projectId: item.project_id,
    itemId,
    authorUserId: userId,
    body: `Issue released by ${userId}.`,
    metadata: { event: 'issue_released' },
  }).catch(() => {})

  return c.json({ ok: true, itemId, assigneeId: null })
})

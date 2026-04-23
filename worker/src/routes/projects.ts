import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { newId } from '../lib/ids'
import type { EnvBindings, RequestContext } from '../lib/context'
import { upsertProjectSearchIndex } from '../db/project-index'
import { upsertAppMemoryEntry } from '../lib/app-memory'
import { generateTenantAiText } from '../agents/orchestrator'
import { refreshProjectMemoryDocs } from '../lib/project-memory'
import { recordUsageEvent } from '../lib/usage'
import { createCompanyWithDefaultWorkstream, createCompanyWorkstream, ensureCompanyExists } from '../lib/companies'

export const projectsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

function shouldHideSystemProject(project: { name: string; description?: string | null }) {
  const haystack = `${project.name} ${project.description || ''}`.toLowerCase()
  return (
    haystack.includes('temporary production smoke test') ||
    haystack.includes('prod delete smoke') ||
    haystack.includes('smoke test project')
  )
}

export async function deleteProjectRecords(env: EnvBindings, tenantId: string, projectId: string) {
  const project = await env.DB.prepare(
    `SELECT company_id, is_default_workstream
     FROM projects
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<{ company_id: string | null; is_default_workstream: number | null } | null>()

  const statements = [
    'DELETE FROM company_workstreams WHERE tenant_id = ? AND project_id = ?',
    'UPDATE assistant_threads SET project_id = NULL WHERE tenant_id = ? AND project_id = ?',
    'UPDATE assistant_pending_actions SET project_id = NULL WHERE tenant_id = ? AND project_id = ?',
    'UPDATE execution_sessions SET project_id = NULL WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM agent_action_events WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM agent_messages WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM project_agents WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM agent_runs WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM project_github_links WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM project_member_assignments WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM app_memory_entries WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM project_memory_docs WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM project_search_index WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM proposals WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM planning_contexts WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM items WHERE tenant_id = ? AND project_id = ?',
    'DELETE FROM projects WHERE tenant_id = ? AND id = ?',
  ]

  for (const sql of statements) {
    await env.DB.prepare(sql).bind(tenantId, projectId).run()
  }

  if (project?.company_id && project.is_default_workstream) {
    await env.DB.prepare(
      `UPDATE companies
       SET canonical_project_id = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND canonical_project_id = ?`
    )
      .bind(Date.now(), tenantId, project.company_id, projectId)
      .run()
  }
}

type ResolvedGitHubRepoLink = {
  connectionId: string
  repoFullName: string
  repoOwner: string
  repoName: string
}

async function resolveGitHubRepoLink(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    githubRepoFullName?: string
  }
): Promise<ResolvedGitHubRepoLink | null> {
  const repoFullName = input.githubRepoFullName?.trim()
  if (!repoFullName) return null

  const linkedRepo = await env.DB.prepare(
    `SELECT gr.full_name, gr.owner, gr.name, sc.id AS connection_id
     FROM github_repos gr
     JOIN service_connections sc
       ON sc.id = gr.connection_id
      AND sc.tenant_id = gr.tenant_id
     WHERE gr.tenant_id = ?
       AND sc.user_id = ?
       AND sc.service_type = 'github'
       AND sc.is_active = true
       AND gr.full_name = ?
     ORDER BY sc.updated_at DESC
     LIMIT 1`
  )
    .bind(input.tenantId, input.userId, repoFullName)
    .first<{ full_name: string; owner: string; name: string; connection_id: string } | null>()

  if (!linkedRepo) return null

  return {
    connectionId: linkedRepo.connection_id,
    repoFullName: linkedRepo.full_name,
    repoOwner: linkedRepo.owner,
    repoName: linkedRepo.name,
  }
}

async function upsertProjectGitHubLink(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId: string
    githubRepo: ResolvedGitHubRepoLink | null
    collaborationMode: 'agent_build' | 'collaborative_review'
    reviewOnPush: boolean
  }
) {
  if (!input.githubRepo) return

  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO project_github_links (
       id, tenant_id, project_id, connection_id, repo_full_name, repo_owner, repo_name,
       collaboration_mode, review_on_push, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, project_id)
     DO UPDATE SET
       connection_id = excluded.connection_id,
       repo_full_name = excluded.repo_full_name,
       repo_owner = excluded.repo_owner,
       repo_name = excluded.repo_name,
       collaboration_mode = excluded.collaboration_mode,
       review_on_push = excluded.review_on_push,
       updated_at = excluded.updated_at`
  )
    .bind(
      newId('prjgh'),
      input.tenantId,
      input.projectId,
      input.githubRepo.connectionId,
      input.githubRepo.repoFullName,
      input.githubRepo.repoOwner,
      input.githubRepo.repoName,
      input.collaborationMode,
      input.reviewOnPush ? 1 : 0,
      now,
      now
    )
    .run()
}

function parseStructuredProjectPlan(input: string): {
  epics?: Array<{
    title: string
    description?: string
    stories?: Array<{
      title: string
      description?: string
      tasks?: Array<{ title: string; description?: string; status?: string; assigneeId?: string | null }>
    }>
  }>
} {
  const candidates = [input.trim()]
  const fenced = input.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') {
        return parsed as {
          epics?: Array<{
            title: string
            description?: string
            stories?: Array<{
              title: string
              description?: string
              tasks?: Array<{ title: string; description?: string; status?: string; assigneeId?: string | null }>
            }>
          }>
        }
      }
    } catch {
      continue
    }
  }

  return {}
}

projectsRoute.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const companyId = c.req.query('companyId')

  const baseSelect = `SELECT
       p.id,
       p.company_id,
       p.name,
       p.description,
       p.created_at,
       p.updated_at,
       pgl.repo_full_name AS github_repo_full_name,
       pgl.collaboration_mode AS github_collaboration_mode,
       pgl.review_on_push AS github_review_on_push
     FROM projects p
     LEFT JOIN project_github_links pgl
       ON pgl.tenant_id = p.tenant_id
      AND pgl.project_id = p.id`

  const res = companyId
    ? await c.env.DB.prepare(
        `${baseSelect}
         WHERE p.tenant_id = ? AND p.company_id = ?
         ORDER BY p.updated_at DESC`
      )
        .bind(tenantId, companyId)
        .all()
    : await c.env.DB.prepare(
        `${baseSelect}
         WHERE p.tenant_id = ?
         ORDER BY p.updated_at DESC`
      )
        .bind(tenantId)
        .all()

  return c.json({ projects: res.results.filter((project) => !shouldHideSystemProject({ name: String(project.name || ''), description: (project as { description?: string | null }).description || null })) })
})

projectsRoute.get('/:projectId', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const row = await c.env.DB.prepare(
    `SELECT id, company_id, name, description, created_at, updated_at
     FROM projects WHERE tenant_id = ? AND id = ? LIMIT 1`
  ).bind(tenantId, projectId).first()
  if (!row) return c.json({ error: 'project_not_found' }, 404)
  return c.json(row)
})

projectsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      companyId: z.string().min(1).optional(),
      githubRepoFullName: z.string().min(1).optional(),
    })
  ),
  async (c) => {
    const { name, description, companyId, githubRepoFullName } = c.req.valid('json')
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const now = Date.now()
    const githubRepo = await resolveGitHubRepoLink(c.env, { tenantId, userId, githubRepoFullName })

    if (githubRepoFullName && !githubRepo) {
      return c.json({ error: 'github_repo_not_available', message: 'Connect GitHub and choose one of your synced repositories before creating this project.' }, 400)
    }

    let id: string
    let resolvedCompanyId: string | null = companyId ?? null

    if (companyId) {
      const company = await ensureCompanyExists(c.env, tenantId, companyId)
      if (!company) {
        return c.json({ error: 'company_not_found', message: `Company ${companyId} was not found for this workspace.` }, 404)
      }
      const created = await createCompanyWorkstream(c.env, {
        tenantId,
        userId,
        companyId,
        name,
        description: description ?? null,
      })
      id = created.projectId
    } else {
      const created = await createCompanyWithDefaultWorkstream(c.env, {
        tenantId,
        userId,
        name,
        description: description ?? null,
        githubRepoFullName: githubRepoFullName ?? null,
      })
      id = created.projectId
      resolvedCompanyId = created.companyId
    }

    await upsertProjectSearchIndex(c.env, {
      tenantId,
      projectId: id,
      extraTexts: [name, description ?? '', githubRepo?.repoFullName ?? ''],
    })

    await upsertProjectGitHubLink(c.env, {
      tenantId,
      projectId: id,
      githubRepo,
      collaborationMode: 'agent_build',
      reviewOnPush: false,
    })

    await upsertAppMemoryEntry(c.env, {
      tenantId,
      projectId: id,
      sourceApp: 'taskcenter',
      sourceType: 'project',
      sourceKey: id,
      title: name,
      content: description ?? name,
      summary: description ?? null,
      metadata: { createdBy: userId, githubRepoFullName: githubRepo?.repoFullName ?? null, companyId: resolvedCompanyId },
    }).catch(() => {})

    await refreshProjectMemoryDocs(c.env, {
      tenantId,
      projectId: id,
    }).catch(() => {})

    return c.json({ id, name, description: description ?? null, companyId: resolvedCompanyId }, 201)
  }
)

projectsRoute.post(
  '/ai-create',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      memberIds: z.array(z.string().min(1)).optional(),
      assignmentMode: z.enum(['auto_assign', 'hybrid_review']).optional(),
      intakeAnswers: z.record(z.union([z.string(), z.array(z.string())])).optional(),
      githubRepoFullName: z.string().min(1).optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const now = Date.now()
    const { name, description, memberIds = [], assignmentMode = 'auto_assign', intakeAnswers = {}, githubRepoFullName } = c.req.valid('json')
    const uniqueMemberIds = Array.from(new Set(memberIds.filter(Boolean)))
    const collaborationMode: 'agent_build' | 'collaborative_review' = uniqueMemberIds.length > 0 ? 'collaborative_review' : 'agent_build'
    const reviewOnPush = collaborationMode === 'collaborative_review'

    if (reviewOnPush && !githubRepoFullName) {
      return c.json(
        {
          error: 'github_required_for_collaboration',
          message: 'Collaborative code projects need a linked GitHub repository before agents start reviewing member work.',
        },
        400
      )
    }

    const githubRepo = await resolveGitHubRepoLink(c.env, { tenantId, userId, githubRepoFullName })
    if (githubRepoFullName && !githubRepo) {
      return c.json(
        {
          error: 'github_repo_not_available',
          message: 'Connect GitHub and pick one of your synced repositories from the project setup flow.',
        },
        400
      )
    }

    const projectId = newId('proj')
    await c.env.DB.prepare(
      `INSERT INTO projects (id, tenant_id, name, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(projectId, tenantId, name, description, userId, now, now)
      .run()

    const workspaceMembers = uniqueMemberIds.length
      ? await c.env.DB.prepare(
          `SELECT
             u.id,
             COALESCE(u.name, u.email, u.id) AS name,
             u.email,
             m.role
           FROM memberships m
           JOIN users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
           WHERE m.tenant_id = ?
             AND u.id IN (${uniqueMemberIds.map(() => '?').join(', ')})`
        )
          .bind(tenantId, ...uniqueMemberIds)
          .all<{ id: string; name: string; email: string | null; role: string }>()
      : { results: [] as Array<{ id: string; name: string; email: string | null; role: string }> }

    for (const member of workspaceMembers.results) {
      await c.env.DB.prepare(
        `INSERT INTO project_member_assignments (
          id, tenant_id, project_id, member_id, assigned_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, project_id, member_id)
        DO UPDATE SET assigned_by = excluded.assigned_by, updated_at = excluded.updated_at`
      )
        .bind(newId('passign'), tenantId, projectId, member.id, userId, now, now)
        .run()
    }

    await upsertProjectGitHubLink(c.env, {
      tenantId,
      projectId,
      githubRepo,
      collaborationMode,
      reviewOnPush,
    })

    try {
      const intakeSummary = Object.entries(intakeAnswers)
        .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\n')
      const memberSummary = workspaceMembers.results.length
        ? workspaceMembers.results.map((member) => `- ${member.id}: ${member.name} (${member.role}${member.email ? `, ${member.email}` : ''})`).join('\n')
        : '- No project members were preselected. Leave ownership open when uncertain.'
      const prompt = [
        'Create a compact project structure and return only valid JSON.',
        'Required shape:',
        '{"epics":[{"title":"string","description":"string","stories":[{"title":"string","description":"string","tasks":[{"title":"string","description":"string","status":"todo","assigneeId":"string|null"}]}]}]}',
        'Rules:',
        '- Return 1 or 2 epics only.',
        '- Each epic may contain up to 3 stories.',
        '- Each story may contain up to 4 tasks.',
        '- Titles must be implementation-ready and specific.',
        '- Descriptions must be short, plain, and useful.',
        '- Allowed task statuses: todo, in_progress, review, done. Default to todo.',
        '- Every task must include assigneeId. Use one of the provided member IDs when the owner is clear, otherwise use null.',
        uniqueMemberIds.length === 0
          ? '- No human project members are attached yet. Leave assigneeId as null and assume the agent lane owns the first pass until people are added.'
          : '- Human project members are attached. Prefer assigning clear ownership to them and leave ambiguous work as null.',
        assignmentMode === 'auto_assign'
          ? '- Make a confident first-pass assignment for as many tasks as possible.'
          : '- Only assign when highly confident; otherwise leave assigneeId as null for review.',
        `Project name: ${name}`,
        `Project description: ${description}`,
        `Project intake answers:\n${intakeSummary || '- None provided'}`,
        `Available project members:\n${memberSummary}`,
      ].join('\n')

      const result = await generateTenantAiText(c.env, { tenantId, userId, userEmail }, {
        featureKey: 'project.ai_create',
        system: 'You are TaskCenter project bootstrapper. Convert a project brief into strict JSON for epics, stories, and tasks. Use only the provided member IDs for assignments.',
        prompt,
        maxOutputTokens: 768,
        metadata: { projectId, projectName: name },
      })

      const parsed = parseStructuredProjectPlan(result.text)

      const generatedEpics = parsed.epics || []
      if (generatedEpics.length === 0) {
        await refreshProjectMemoryDocs(c.env, {
          tenantId,
          projectId,
        }).catch(() => {})
        return c.json(
          {
            id: projectId,
            name,
            description,
            aiGenerated: false,
            warning: 'AI did not return a usable project structure. The project shell was created without generated items.',
          },
          201
        )
      }

      let epicSort = 1
      for (const epic of generatedEpics) {
        const epicId = newId('item')
        await c.env.DB.prepare(
          `INSERT INTO items (
            id, tenant_id, project_id, parent_id, kind, title, description, status, sort_order,
            created_by, execution_mode, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, 'epic', ?, ?, 'planned', ?, ?, 'auto', ?, ?)`
        )
          .bind(epicId, tenantId, projectId, epic.title, epic.description ?? null, epicSort++, userId, now, now)
          .run()

        let storySort = 1
        for (const story of epic.stories || []) {
          const storyId = newId('item')
          await c.env.DB.prepare(
            `INSERT INTO items (
              id, tenant_id, project_id, parent_id, kind, title, description, status, sort_order,
              created_by, execution_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'story', ?, ?, 'planned', ?, ?, 'auto', ?, ?)`
          )
            .bind(storyId, tenantId, projectId, epicId, story.title, story.description ?? null, storySort++, userId, now, now)
            .run()

          let taskSort = 1
          for (const task of story.tasks || []) {
            await c.env.DB.prepare(
              `INSERT INTO items (
                id, tenant_id, project_id, parent_id, kind, title, description, status, sort_order,
                created_by, assignee_id, execution_mode, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'task', ?, ?, ?, ?, ?, ?, 'auto', ?, ?)`
            )
              .bind(
                newId('item'),
                tenantId,
                projectId,
                storyId,
                task.title,
                task.description ?? null,
                task.status ?? 'todo',
                taskSort++,
                userId,
                task.assigneeId ?? null,
                now,
                now
              )
              .run()
          }
        }
      }

      await upsertProjectSearchIndex(c.env, {
        tenantId,
        projectId,
        extraTexts: [name, description, githubRepo?.repoFullName ?? ''],
      })

      await upsertAppMemoryEntry(c.env, {
        tenantId,
        projectId,
        sourceApp: 'taskcenter',
        sourceType: 'project',
        sourceKey: projectId,
        title: name,
        content: [description, intakeSummary].filter(Boolean).join('\n'),
        summary: description,
        metadata: {
          createdBy: userId,
          assignmentMode,
          ownershipMode: uniqueMemberIds.length > 0 ? 'collaborative' : 'agent_first',
          memberCount: workspaceMembers.results.length,
          githubRepoFullName: githubRepo?.repoFullName ?? null,
          collaborationMode,
          reviewOnPush,
        },
      }).catch(() => {})

      await refreshProjectMemoryDocs(c.env, {
        tenantId,
        projectId,
      }).catch(() => {})

      return c.json({ id: projectId, name, description, aiGenerated: true }, 201)
    } catch (error) {
      await refreshProjectMemoryDocs(c.env, {
        tenantId,
        projectId,
      }).catch(() => {})
      await recordUsageEvent(c.env, { tenantId, userId }, {
        featureKey: 'project.ai_create',
        status: 'error',
        metadata: { projectId, message: error instanceof Error ? error.message : 'AI project creation failed' },
      }).catch(() => {})
      return c.json(
        {
          id: projectId,
          name,
          description,
          aiGenerated: false,
          warning: error instanceof Error ? error.message : 'AI project creation failed',
        },
        201
      )
    }
  }
)

projectsRoute.delete('/:projectId', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')

  const existing = await c.env.DB.prepare(
    `SELECT id FROM projects WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<{ id: string }>()

  if (!existing) {
    return c.json({ error: 'project_not_found' }, 404)
  }

  await deleteProjectRecords(c.env, tenantId, projectId)

  return c.json({ ok: true })
})

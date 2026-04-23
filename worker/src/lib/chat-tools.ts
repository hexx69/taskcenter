import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { EnvBindings } from './context'
import { buildProjectRagContext } from './project-rag'
import { refreshProjectMemoryDocs } from './project-memory'
import { loadRuntimeToolSession } from './tool-registry'
import { createPendingAction, type AssistantActor } from './assistant'

/**
 * Builds the chat tool set for Northstar. Each mutating tool stages a pending
 * action (proposal-first governance); read-only tools query directly so the
 * assistant can ground answers without surprise side-effects.
 */
export function buildChatTools(params: {
  env: EnvBindings
  actor: AssistantActor
  threadId: string
  projectId?: string | null
  companyId?: string | null
}): ToolSet {
  const { env, actor, threadId, projectId, companyId } = params

  const tools: ToolSet = {
    searchProject: tool({
      description:
        'Retrieve grounded project context: tasks, proposals, planning snapshots, memory layers, and recent messages relevant to a query. Use before making claims about project state.',
      inputSchema: z.object({
        query: z.string().describe('What to search for inside the project.'),
        maxSnippets: z.number().int().min(1).max(12).optional(),
      }),
      execute: async ({ query, maxSnippets }) => {
        if (!projectId) return { ok: false, reason: 'no_project', snippets: [] }
        const result = await buildProjectRagContext(env, {
          tenantId: actor.tenantId,
          projectId,
          query,
          maxSnippets: maxSnippets ?? 6,
        })
        return {
          ok: true,
          counts: result.counts,
          snippets: result.snippets.map((snippet) => ({
            source: snippet.source,
            label: snippet.label,
            excerpt: snippet.excerpt,
          })),
        }
      },
    }),

    listTasks: tool({
      description: 'List tasks (items) on the current project filtered by status.',
      inputSchema: z.object({
        status: z.enum(['todo', 'in_progress', 'review', 'done', 'blocked', 'any']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ status, limit }) => {
        if (!projectId) return { ok: false, reason: 'no_project', tasks: [] }
        const max = limit ?? 20
        const rows =
          status && status !== 'any'
            ? await env.DB.prepare(
                `SELECT id, title, status, assignee_id, priority, updated_at
                 FROM items WHERE tenant_id = ? AND project_id = ? AND status = ?
                 ORDER BY updated_at DESC LIMIT ?`
              )
                .bind(actor.tenantId, projectId, status, max)
                .all<{ id: string; title: string; status: string; assignee_id: string | null; priority: string | null; updated_at: number }>()
            : await env.DB.prepare(
                `SELECT id, title, status, assignee_id, priority, updated_at
                 FROM items WHERE tenant_id = ? AND project_id = ?
                 ORDER BY updated_at DESC LIMIT ?`
              )
                .bind(actor.tenantId, projectId, max)
                .all<{ id: string; title: string; status: string; assignee_id: string | null; priority: string | null; updated_at: number }>()
        return { ok: true, tasks: rows.results ?? [] }
      },
    }),

    getIssue: tool({
      description: 'Fetch a single task/issue with its latest comments for compact context.',
      inputSchema: z.object({ itemId: z.string() }),
      execute: async ({ itemId }) => {
        const item = await env.DB.prepare(
          `SELECT id, title, body, status, assignee_id, priority, project_id, updated_at
           FROM items WHERE tenant_id = ? AND id = ? LIMIT 1`
        )
          .bind(actor.tenantId, itemId)
          .first()
        if (!item) return { ok: false, reason: 'not_found' }
        const comments = await env.DB.prepare(
          `SELECT id, author_id, body, source, created_at FROM issue_comments
           WHERE tenant_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT 10`
        )
          .bind(actor.tenantId, itemId)
          .all()
        return { ok: true, item, comments: comments.results ?? [] }
      },
    }),

    createTask: tool({
      description:
        'Stage a task creation as a pending proposal (human confirms before it lands on the board). Use for issue-first decomposition.',
      inputSchema: z.object({
        title: z.string(),
        status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
        assignees: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        summary: z.string().optional(),
        impactLevel: z.enum(['low', 'medium', 'high']).optional(),
      }),
      execute: async ({ title, status, assignees, tags, summary, impactLevel }) => {
        if (!projectId) return { ok: false, reason: 'no_project' }
        const id = await createPendingAction(env, actor, {
          threadId,
          companyId: companyId ?? null,
          projectId,
          kind: 'proposal_apply',
          title: `Create task: ${title}`,
          summary: summary ?? `Stage new task "${title}" for confirmation.`,
          payload: {
            projectId,
            title: `Create task: ${title}`,
            summary: summary ?? `Stage new task "${title}".`,
            impactLevel: impactLevel ?? 'low',
            actions: [{ type: 'task.upsert', payload: { title, status: status ?? 'todo', assignees, tags } }],
            applyOnConfirm: true,
          },
        })
        return { ok: true, pendingActionId: id }
      },
    }),

    assignTask: tool({
      description: 'Stage an assignment change on an existing task (pending confirmation).',
      inputSchema: z.object({
        taskId: z.string(),
        assigneeId: z.string(),
        summary: z.string().optional(),
      }),
      execute: async ({ taskId, assigneeId, summary }) => {
        if (!projectId) return { ok: false, reason: 'no_project' }
        const id = await createPendingAction(env, actor, {
          threadId,
          companyId: companyId ?? null,
          projectId,
          kind: 'proposal_apply',
          title: `Assign task ${taskId}`,
          summary: summary ?? `Stage assignment of task ${taskId} to ${assigneeId}.`,
          payload: {
            projectId,
            title: `Assign task ${taskId}`,
            summary: summary ?? `Assign task ${taskId} to ${assigneeId}.`,
            impactLevel: 'low',
            actions: [{ type: 'task.assign', payload: { taskId, assigneeId } }],
            applyOnConfirm: true,
          },
        })
        return { ok: true, pendingActionId: id }
      },
    }),

    createEpic: tool({
      description: 'Stage an epic (planning container) for confirmation.',
      inputSchema: z.object({
        title: z.string(),
        objective: z.string().optional(),
        summary: z.string().optional(),
      }),
      execute: async ({ title, objective, summary }) => {
        if (!projectId) return { ok: false, reason: 'no_project' }
        const id = await createPendingAction(env, actor, {
          threadId,
          companyId: companyId ?? null,
          projectId,
          kind: 'proposal_apply',
          title: `Create epic: ${title}`,
          summary: summary ?? `Stage new epic "${title}".`,
          payload: {
            projectId,
            title: `Create epic: ${title}`,
            summary: summary ?? `Stage new epic "${title}".`,
            impactLevel: 'medium',
            actions: [{ type: 'epic.upsert', payload: { title, objective } }],
            applyOnConfirm: true,
          },
        })
        return { ok: true, pendingActionId: id }
      },
    }),

    startExecution: tool({
      description:
        'Stage an execution session (AI-assisted or autonomous) on the current project for confirmation.',
      inputSchema: z.object({
        title: z.string(),
        summary: z.string(),
        mode: z.enum(['implementation', 'review', 'debug', 'planning']).optional(),
        provider: z.enum(['claude_code', 'codex_cli', 'cloud']).optional(),
        transport: z.enum(['bridge_cli', 'cloud']).optional(),
        itemId: z.string().optional(),
      }),
      execute: async ({ title, summary, mode, provider, transport, itemId }) => {
        if (!projectId) return { ok: false, reason: 'no_project' }
        const id = await createPendingAction(env, actor, {
          threadId,
          companyId: companyId ?? null,
          projectId,
          kind: 'execution_start',
          title,
          summary,
          payload: {
            projectId,
            mode: (mode ?? 'implementation') as never,
            provider: (provider ?? 'cloud') as never,
            transport: (transport ?? 'cloud') as never,
            title,
            summary,
            itemId: itemId ?? null,
          },
        })
        return { ok: true, pendingActionId: id }
      },
    }),

    retrieveMemory: tool({
      description:
        'Refresh and return the 4-layer project memory docs (foundation, workflow, active context, delivery).',
      inputSchema: z.object({}),
      execute: async () => {
        if (!projectId) return { ok: false, reason: 'no_project' }
        const docs = await refreshProjectMemoryDocs(env, {
          tenantId: actor.tenantId,
          projectId,
        }).catch((error) => ({ error: error instanceof Error ? error.message : 'refresh_failed' }))
        return { ok: true, docs }
      },
    }),

    checkIntegrations: tool({
      description: 'Report which connectors and runtime tools are currently available to the thread.',
      inputSchema: z.object({}),
      execute: async () => {
        const session = await loadRuntimeToolSession(env, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          projectId: projectId ?? undefined,
        })
        return {
          ok: true,
          summary: session.summaryText,
          connectors: session.selectedConnectorLabels,
        }
      },
    }),
  }

  return tools
}

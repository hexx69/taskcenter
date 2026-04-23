import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import {
  chatWithProjectAgent,
  createAgentRun,
  getAgentRunDetails,
  getProjectAgentMessages,
  logAgentActionEvent,
  listRecentRuns,
} from '../agents/orchestrator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { wakeCompanyAgent } from '../lib/companies'
import { ensureProjectExists } from '../lib/projects'
import { recordRuntimeEvent } from '../lib/runtime-events'

export const agentsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

agentsRoute.post(
  '/:agentId/wake',
  zValidator(
    'json',
    z.object({
      reason: z.string().max(500).optional(),
      targetType: z.string().max(120).optional(),
      targetId: z.string().max(160).optional(),
    })
  ),
  async (c) => {
    const result = await wakeCompanyAgent(c.env, {
      tenantId: c.get('tenantId'),
      userId: c.get('userId'),
      agentId: c.req.param('agentId'),
      ...c.req.valid('json'),
    })
    if (!result) return c.json({ error: 'agent_not_found' }, 404)
    return c.json(result, result.coalesced ? 200 : 202)
  }
)

agentsRoute.post(
  '/runs',
  zValidator(
    'json',
    z.object({
      projectId: z.string().min(1),
      prompt: z.string().min(1),
      requestedTask: z.string().optional(),
      modelConfig: z
        .object({
          provider: z.enum(['gateway', 'gemini', 'openai', 'openrouter', 'anthropic']),
          model: z.string().min(1),
          fallbackProvider: z.enum(['gateway', 'gemini', 'openai', 'openrouter', 'anthropic']).optional(),
          fallbackModel: z.string().optional(),
        })
        .optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const payload = c.req.valid('json')
    const project = await ensureProjectExists(c.env, tenantId, payload.projectId)
    if (!project) {
      return c.json({ error: 'project_not_found', message: `Project ${payload.projectId} was not found for this workspace.` }, 404)
    }

    try {
      const result = await createAgentRun(c.env, { tenantId, userId, userEmail }, payload)
      return c.json(result, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent run failed'
      const status = message.includes('not found for this workspace') ? 404 : 500
      if (status >= 500) {
        await recordRuntimeEvent(c.env, {
          tenantId,
          userId,
          projectId: payload.projectId,
          routeKey: 'agents.runs',
          category: 'agent_run',
          severity: 'error',
          message,
        }).catch(() => {})
      }
      return c.json({ error: status === 404 ? 'project_not_found' : 'agent_run_failed', message }, status)
    }
  }
)

agentsRoute.post(
  '/projects/:projectId/action-events',
  zValidator(
    'json',
    z.object({
      eventType: z.enum(['dry_run', 'applied', 'rejected']),
      actions: z
        .array(
          z.object({
            type: z.enum(['task.upsert', 'task.assign', 'epic.upsert', 'member.assign', 'repo.run']),
            payload: z.record(z.unknown()),
          })
        )
        .min(1),
      projectAgentId: z.string().optional(),
      runId: z.string().optional(),
      sourceMessageId: z.string().optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const projectId = c.req.param('projectId')
    const payload = c.req.valid('json')
    const project = await ensureProjectExists(c.env, tenantId, projectId)
    if (!project) {
      return c.json({ error: 'project_not_found', message: `Project ${projectId} was not found for this workspace.` }, 404)
    }

    await logAgentActionEvent(c.env, { tenantId, userId, userEmail }, { projectId, ...payload })
    return c.json({ ok: true }, 201)
  }
)

agentsRoute.get('/runs/:runId', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const runId = c.req.param('runId')

  const details = await getAgentRunDetails(c.env, { tenantId, userId, userEmail }, runId)
  if (!details) {
    return c.json({ error: 'run_not_found' }, 404)
  }

  return c.json(details)
})

agentsRoute.get('/runs', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const projectId = c.req.query('projectId')
  const agentId = c.req.query('agentId')
  if (agentId) {
    const result = await c.env.DB.prepare(
      `SELECT id, project_id, root_prompt, status, created_at, updated_at
       FROM agent_runs
       WHERE tenant_id = ? AND requested_by = ?
       ORDER BY created_at DESC LIMIT 20`
    )
      .bind(tenantId, agentId)
      .all()
    return c.json({ runs: result.results })
  }
  const runs = await listRecentRuns(c.env, { tenantId, userId, userEmail }, projectId)
  return c.json({ runs })
})

agentsRoute.get('/projects/:projectId/messages', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const projectId = c.req.param('projectId')

  try {
    const result = await getProjectAgentMessages(c.env, { tenantId, userId, userEmail }, projectId)
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load project messages'
    const status = message.includes('not found for this workspace') ? 404 : 500
    if (status >= 500) {
      await recordRuntimeEvent(c.env, {
        tenantId,
        userId,
        projectId,
        routeKey: 'agents.messages',
        category: 'agent_messages',
        severity: 'error',
        message,
      }).catch(() => {})
    }
    return c.json({ error: status === 404 ? 'project_not_found' : 'project_messages_failed', message }, status)
  }
})

agentsRoute.post(
  '/projects/:projectId/chat',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1),
      skillIds: z.array(z.string().min(1)).max(12).optional(),
      context: z
        .object({
          currentPage: z.string().max(120).optional(),
          currentRoute: z.string().max(240).optional(),
          activeView: z.string().max(120).optional(),
          currentUserId: z.string().max(120).optional(),
          currentUserName: z.string().max(240).optional(),
          currentUserEmail: z.string().max(320).optional(),
          projectName: z.string().max(240).optional(),
          projectViewMode: z.enum(['detailed', 'compact']).optional(),
          workspaceName: z.string().max(240).optional(),
          selectedTaskId: z.string().max(120).optional(),
          selectedTaskTitle: z.string().max(240).optional(),
          selectedTaskStatus: z.string().max(120).optional(),
          pendingProposalId: z.string().max(120).optional(),
          selectedConnectorKeys: z.array(z.string().max(160)).max(20).optional(),
          selectedConnectorLabels: z.array(z.string().max(160)).max(20).optional(),
          screenSummary: z.string().max(6000).optional(),
          conversationSummary: z.string().max(6000).optional(),
          toolSummary: z.string().max(6000).optional(),
          activeGoal: z.string().max(1000).optional(),
        })
        .optional(),
      modelConfig: z
        .object({
          provider: z.enum(['gateway', 'gemini', 'openai', 'openrouter', 'anthropic']),
          model: z.string().min(1),
          fallbackProvider: z.enum(['gateway', 'gemini', 'openai', 'openrouter', 'anthropic']).optional(),
          fallbackModel: z.string().optional(),
        })
        .optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const projectId = c.req.param('projectId')
    const { message, modelConfig, skillIds, context } = c.req.valid('json')

    try {
      const result = await chatWithProjectAgent(c.env, { tenantId, userId, userEmail }, { projectId, message, modelConfig, skillIds, context })
      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Project chat failed'
      const status = message.includes('not found for this workspace') ? 404 : message.includes('Usage limit reached') ? 429 : 500
      if (status >= 500) {
        await recordRuntimeEvent(c.env, {
          tenantId,
          userId,
          projectId,
          routeKey: 'agents.chat',
          category: 'agent_chat',
          severity: 'error',
          message,
          metadata: { currentPage: context?.currentPage, currentRoute: context?.currentRoute },
        }).catch(() => {})
      }
      return c.json({ error: status === 404 ? 'project_not_found' : status === 429 ? 'usage_limit_reached' : 'project_chat_failed', message }, status)
    }
  }
)

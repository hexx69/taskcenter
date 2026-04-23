import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { createDebugInvestigation, getDebugSessionDetails, listProjectDebugSessions, retryDebugSessionStep } from '../lib/debug'

export const debugRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

debugRoute.post(
  '/projects/:projectId/investigate',
  zValidator(
    'json',
    z.object({
      mode: z.enum(['bug_repro', 'failing_check', 'push_review', 'billing_drift', 'integration_failure', 'agent_misroute']),
      summary: z.string().min(1).max(4000),
      evidenceSources: z.array(z.string().min(1).max(120)).max(20).optional(),
      linkedProposalId: z.string().min(1).optional(),
      linkedRunId: z.string().min(1).optional(),
      screenContext: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const projectId = c.req.param('projectId')
    const payload = c.req.valid('json')

    try {
      const result = await createDebugInvestigation(c.env, { tenantId, userId, userEmail }, { projectId, ...payload })
      return c.json(result, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create investigation session.'
      const status = message.includes('not found for this workspace') ? 404 : 500
      return c.json({ error: status === 404 ? 'project_not_found' : 'debug_session_create_failed', message }, status)
    }
  }
)

debugRoute.get('/projects/:projectId/sessions', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')

  try {
    const payload = await listProjectDebugSessions(c.env, tenantId, projectId)
    return c.json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load debug sessions.'
    return c.json({ error: 'debug_sessions_list_failed', message }, 500)
  }
})

debugRoute.get('/sessions/:sessionId', async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('sessionId')
  const details = await getDebugSessionDetails(c.env, tenantId, sessionId)
  if (!details) {
    return c.json({ error: 'debug_session_not_found' }, 404)
  }
  return c.json(details)
})

debugRoute.post(
  '/sessions/:sessionId/retry-step',
  zValidator(
    'json',
    z.object({
      stepId: z.string().min(1),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const sessionId = c.req.param('sessionId')
    const { stepId } = c.req.valid('json')

    try {
      const result = await retryDebugSessionStep(c.env, { tenantId, userId, userEmail }, { sessionId, stepId })
      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to retry debug step.'
      const status = message.includes('not found') ? 404 : 500
      return c.json({ error: status === 404 ? 'debug_step_not_found' : 'debug_step_retry_failed', message }, status)
    }
  }
)

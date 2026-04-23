import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { getExecutionSession, launchBridgeExecutionSession, listExecutionSessions, recordExecutionSessionCallback } from '../lib/assistant'
import { openExecutionSessionLiveStream } from '../lib/control-plane-live'

export const executionSessionsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()
export const executionSessionsPublicRoute = new Hono<{ Bindings: EnvBindings }>()

executionSessionsRoute.get('/', async (c) => {
  const companyId = c.req.query('companyId') || undefined
  const projectId = c.req.query('projectId') || undefined
  const threadId = c.req.query('threadId') || undefined
  const result = await listExecutionSessions(
    c.env,
    {
      tenantId: c.get('tenantId'),
      userId: c.get('userId'),
      userEmail: c.get('userEmail'),
      userName: c.get('userName'),
      role: c.get('role'),
    },
    { companyId, projectId, threadId }
  )
  return c.json(result)
})

executionSessionsRoute.get('/:sessionId', async (c) => {
  const result = await getExecutionSession(
    c.env,
    {
      tenantId: c.get('tenantId'),
      userId: c.get('userId'),
      userEmail: c.get('userEmail'),
      userName: c.get('userName'),
      role: c.get('role'),
    },
    c.req.param('sessionId')
  )
  if (!result) {
    return c.json({ error: 'execution_session_not_found' }, 404)
  }
  return c.json(result)
})

executionSessionsRoute.get('/:sessionId/stream', async (c) => {
  return openExecutionSessionLiveStream(c.env, c.req.param('sessionId'))
})

executionSessionsRoute.post('/:sessionId/launch', async (c) => {
  try {
    const result = await launchBridgeExecutionSession(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      c.req.param('sessionId')
    )
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution launch failed.'
    return c.json({ error: 'execution_launch_failed', message }, 400)
  }
})

executionSessionsPublicRoute.post(
  '/:sessionId/callback',
  zValidator(
    'json',
    z.object({
      status: z.enum(['queued', 'running', 'succeeded', 'failed']),
      externalRunId: z.string().optional(),
      message: z.string().optional(),
      logs: z.array(z.string()).optional(),
      result: z.record(z.unknown()).optional(),
      errorMessage: z.string().optional(),
    })
  ),
  async (c) => {
    const callbackSecret = c.req.header('x-taskcenter-execution-secret')
    if (!callbackSecret) {
      return c.json({ error: 'forbidden' }, 403)
    }

    try {
      const result = await recordExecutionSessionCallback(c.env, {
        sessionId: c.req.param('sessionId'),
        callbackSecret,
        ...c.req.valid('json'),
      })
      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Execution callback failed.'
      return c.json({ error: message === 'forbidden' ? 'forbidden' : 'execution_callback_failed', message }, message === 'forbidden' ? 403 : 400)
    }
  }
)

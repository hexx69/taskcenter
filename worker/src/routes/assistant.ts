import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import {
  attachAssistantThreadToProject,
  cancelAssistantPendingAction,
  confirmAssistantPendingAction,
  createAssistantThread,
  getAssistantThread,
  getPublicAssistantThread,
  listAssistantMessages,
  listAssistantThreads,
  listPublicAssistantMessages,
  sendAssistantThreadMessage,
  updateAssistantThread,
} from '../lib/assistant'
import { openAssistantThreadLiveStream } from '../lib/assistant-live'
import { streamTenantAiText } from '../agents/orchestrator'

export const assistantRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()
export const publicAssistantRoute = new Hono<{ Bindings: EnvBindings }>()

const threadBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
  visibility: z.enum(['private', 'shared', 'public']).optional(),
  companyId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  shareWithUserIds: z.array(z.string().min(1)).max(20).optional(),
})

const threadMessageSchema = z.object({
  message: z.string().min(1),
  context: z
    .object({
      currentPage: z.string().max(120).optional(),
      currentRoute: z.string().max(240).optional(),
      activeView: z.string().max(120).optional(),
      companyName: z.string().max(240).optional(),
      currentUserId: z.string().max(120).optional(),
      currentUserName: z.string().max(240).optional(),
      currentUserEmail: z.string().max(320).optional(),
      projectName: z.string().max(240).optional(),
      selectedWorkstreamId: z.string().max(120).optional(),
      selectedWorkstreamName: z.string().max(240).optional(),
      projectViewMode: z.enum(['detailed', 'compact']).optional(),
      workspaceName: z.string().max(240).optional(),
      selectedTaskId: z.string().max(120).optional(),
      selectedTaskTitle: z.string().max(240).optional(),
      selectedTaskStatus: z.string().max(120).optional(),
      selectedConnectorKeys: z.array(z.string().max(160)).max(20).optional(),
      selectedConnectorLabels: z.array(z.string().max(160)).max(20).optional(),
      screenSummary: z.string().max(6000).optional(),
      conversationSummary: z.string().max(6000).optional(),
      toolSummary: z.string().max(6000).optional(),
      activeGoal: z.string().max(1000).optional(),
    })
    .optional(),
})

const attachProjectSchema = z.object({
  projectId: z.string().min(1),
})

assistantRoute.get('/threads', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const userName = c.get('userName')
  const role = c.get('role')
  const companyId = c.req.query('companyId') || undefined
  const projectId = c.req.query('projectId') || undefined
  const result = await listAssistantThreads(c.env, { tenantId, userId, userEmail, userName, role }, { companyId, projectId })
  return c.json(result)
})

assistantRoute.post('/threads', zValidator('json', threadBodySchema), async (c) => {
  const payload = c.req.valid('json')
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const userName = c.get('userName')
  const role = c.get('role')
  const result = await createAssistantThread(c.env, { tenantId, userId, userEmail, userName, role }, payload)
  return c.json(result, 201)
})

assistantRoute.get('/threads/:threadId', async (c) => {
  const result = await getAssistantThread(
    c.env,
    {
      tenantId: c.get('tenantId'),
      userId: c.get('userId'),
      userEmail: c.get('userEmail'),
      userName: c.get('userName'),
      role: c.get('role'),
    },
    c.req.param('threadId')
  )

  if (!result) {
    return c.json({ error: 'thread_not_found' }, 404)
  }
  return c.json(result)
})

assistantRoute.patch('/threads/:threadId', zValidator('json', threadBodySchema.omit({ companyId: true, projectId: true })), async (c) => {
  try {
    const result = await updateAssistantThread(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      c.req.param('threadId'),
      c.req.valid('json')
    )
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'thread_update_failed', message: error instanceof Error ? error.message : 'Thread update failed.' }, 400)
  }
})

assistantRoute.post('/threads/:threadId/attach-project', zValidator('json', attachProjectSchema), async (c) => {
  try {
    const result = await attachAssistantThreadToProject(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      c.req.param('threadId'),
      c.req.valid('json').projectId
    )
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'thread_attach_failed', message: error instanceof Error ? error.message : 'Could not attach thread.' }, 400)
  }
})

assistantRoute.get('/threads/:threadId/messages', async (c) => {
  try {
    const result = await listAssistantMessages(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      c.req.param('threadId')
    )
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'thread_messages_failed', message: error instanceof Error ? error.message : 'Could not load messages.' }, 404)
  }
})

assistantRoute.post('/threads/:threadId/messages', zValidator('json', threadMessageSchema), async (c) => {
  try {
    const result = await sendAssistantThreadMessage(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      {
        threadId: c.req.param('threadId'),
        ...c.req.valid('json'),
      }
    )
    return c.json(result, 201)
  } catch (error) {
    return c.json({ error: 'thread_send_failed', message: error instanceof Error ? error.message : 'Could not send message.' }, 400)
  }
})

assistantRoute.post('/threads/:threadId/messages/stream', zValidator('json', threadMessageSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const threadId = c.req.param('threadId')
  const { message } = c.req.valid('json')

  const thread = await getAssistantThread(c.env, { tenantId, userId, userEmail: c.get('userEmail'), userName: c.get('userName'), role: c.get('role') }, threadId)
  if (!thread) return c.json({ error: 'thread_not_found' }, 404)

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const streamPromise = streamTenantAiText(
    c.env,
    { tenantId, userId },
    {
      featureKey: 'assistant.stream',
      system: 'You are a helpful assistant.',
      prompt: message,
      maxOutputTokens: 2000,
      onChunk: (chunk) => {
        writer.write(encoder.encode(`data: ${JSON.stringify({ delta: chunk })}\n\n`)).catch(() => {})
      },
    }
  ).then(() => {
    writer.write(encoder.encode('data: [DONE]\n\n')).catch(() => {})
  }).catch((error) => {
    writer.write(encoder.encode(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : 'stream_failed' })}\n\n`)).catch(() => {})
  }).finally(() => {
    writer.close().catch(() => {})
  })

  void streamPromise

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  })
})

assistantRoute.get('/threads/:threadId/stream', async (c) => {
  const actor = {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
    userEmail: c.get('userEmail'),
    userName: c.get('userName'),
    role: c.get('role'),
  }
  const threadId = c.req.param('threadId')
  const thread = await getAssistantThread(c.env, actor, threadId)
  if (!thread) {
    return c.json({ error: 'thread_not_found' }, 404)
  }
  return openAssistantThreadLiveStream(c.env, threadId)
})

assistantRoute.post('/threads/:threadId/actions/:actionId/confirm', async (c) => {
  try {
    const result = await confirmAssistantPendingAction(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      {
        threadId: c.req.param('threadId'),
        actionId: c.req.param('actionId'),
      }
    )
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'assistant_action_confirm_failed', message: error instanceof Error ? error.message : 'Could not confirm action.' }, 400)
  }
})

assistantRoute.post('/threads/:threadId/actions/:actionId/cancel', async (c) => {
  try {
    const result = await cancelAssistantPendingAction(
      c.env,
      {
        tenantId: c.get('tenantId'),
        userId: c.get('userId'),
        userEmail: c.get('userEmail'),
        userName: c.get('userName'),
        role: c.get('role'),
      },
      {
        threadId: c.req.param('threadId'),
        actionId: c.req.param('actionId'),
      }
    )
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'assistant_action_cancel_failed', message: error instanceof Error ? error.message : 'Could not cancel action.' }, 400)
  }
})

publicAssistantRoute.get('/threads/:threadId', async (c) => {
  const result = await getPublicAssistantThread(c.env, c.req.param('threadId'))
  if (!result) {
    return c.json({ error: 'thread_not_found' }, 404)
  }
  return c.json(result)
})

publicAssistantRoute.get('/threads/:threadId/messages', async (c) => {
  try {
    const result = await listPublicAssistantMessages(c.env, c.req.param('threadId'))
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'thread_messages_failed', message: error instanceof Error ? error.message : 'Could not load messages.' }, 404)
  }
})

publicAssistantRoute.get('/threads/:threadId/stream', async (c) => {
  const threadId = c.req.param('threadId')
  const thread = await getPublicAssistantThread(c.env, threadId)
  if (!thread) {
    return c.json({ error: 'thread_not_found' }, 404)
  }
  return openAssistantThreadLiveStream(c.env, threadId)
})

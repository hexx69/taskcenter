// /api/northstar/* — per-company CEO agent chat.
//
// Thin layer. All persistence + LLM streaming is in lib/northstar-ceo.ts.
// These endpoints only handle HTTP framing (SSE) and auth context lookup.

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import type { AssistantActor } from '../lib/assistant'
import {
  loadNorthstarThreadForUi,
  postAgentReportToNorthstar,
  resolveNorthstarThread,
  streamCeoReply,
} from '../lib/northstar-ceo'

type NorthstarCtx = Context<{ Bindings: EnvBindings; Variables: RequestContext }>

export const northstarRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

function actorFromCtx(c: NorthstarCtx): AssistantActor {
  return {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
    userEmail: c.get('userEmail') ?? null,
    userName: c.get('userName') ?? null,
    role: c.get('role'),
  }
}

// GET /api/northstar/:companyId/thread -> {thread, messages}
northstarRoute.get('/:companyId/thread', async (c) => {
  const companyId = c.req.param('companyId')
  try {
    const result = await loadNorthstarThreadForUi(c.env, actorFromCtx(c), companyId)
    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Northstar thread.'
    return c.json({ error: message }, 400)
  }
})

const messageSchema = z.object({
  message: z.string().min(1).max(8000),
})

// POST /api/northstar/:companyId/thread/messages/stream -> SSE
//   event: delta   data: {"text": "..."}
//   event: done    data: {"messageId": "...", "usedModel": "anthropic:claude-3-5"}
//   event: error   data: {"message": "..."}
northstarRoute.post('/:companyId/thread/messages/stream', zValidator('json', messageSchema), async (c) => {
  const companyId = c.req.param('companyId')
  const { message } = c.req.valid('json')

  let thread
  try {
    thread = await resolveNorthstarThread(c.env, actorFromCtx(c), companyId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to resolve Northstar thread.'
    return c.json({ error: msg }, 400)
  }

  const encoder = new TextEncoder()
  const actor = actorFromCtx(c)
  const env = c.env

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: string, payload: unknown) => {
        const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
        controller.enqueue(encoder.encode(line))
      }

      try {
        for await (const chunk of streamCeoReply(env, actor, companyId, thread.id, message)) {
          if (chunk.type === 'delta') write('delta', { text: chunk.text })
          else if (chunk.type === 'done') write('done', { messageId: chunk.messageId, usedModel: chunk.usedModel })
          else if (chunk.type === 'error') write('error', { message: chunk.message })
        }
      } catch (err) {
        write('error', { message: err instanceof Error ? err.message : 'Stream crashed.' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// POST /api/northstar/:companyId/agent-report
//   body: { agentRoleKey, agentName?, message }
// Lets a sub-agent push a report into the CEO thread; on the next user turn
// the CEO model sees the tagged message in history context and folds it in.
const agentReportSchema = z.object({
  agentRoleKey: z.string().min(1).max(32),
  agentName: z.string().min(1).max(120).optional(),
  message: z.string().min(1).max(4000),
})

northstarRoute.post('/:companyId/agent-report', zValidator('json', agentReportSchema), async (c) => {
  const companyId = c.req.param('companyId')
  const payload = c.req.valid('json')
  try {
    const result = await postAgentReportToNorthstar(c.env, actorFromCtx(c), companyId, payload)
    return c.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to post agent report.'
    return c.json({ ok: false, error: message }, 400)
  }
})

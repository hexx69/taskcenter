import { DurableObject } from 'cloudflare:workers'
import type { EnvBindings } from './context'

type StreamListener = {
  controller: ReadableStreamDefaultController<Uint8Array>
  heartbeat: number
}

function encodeSse(event: string, data: string) {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`)
}

function executionSessionStreamStub(env: Pick<EnvBindings, 'EXECUTION_SESSION_STREAM'>, sessionId: string) {
  if (!env.EXECUTION_SESSION_STREAM) return null
  const id = env.EXECUTION_SESSION_STREAM.idFromName(sessionId)
  return env.EXECUTION_SESSION_STREAM.get(id)
}

function companyRuntimeStub(env: Pick<EnvBindings, 'COMPANY_RUNTIME_COORDINATOR'>, companyId: string) {
  if (!env.COMPANY_RUNTIME_COORDINATOR) return null
  const id = env.COMPANY_RUNTIME_COORDINATOR.idFromName(companyId)
  return env.COMPANY_RUNTIME_COORDINATOR.get(id)
}

export async function openExecutionSessionLiveStream(
  env: Pick<EnvBindings, 'EXECUTION_SESSION_STREAM'>,
  sessionId: string
) {
  const stub = executionSessionStreamStub(env, sessionId)
  if (!stub) {
    return new Response('Execution session live stream is not configured.', { status: 503 })
  }
  return stub.fetch('https://execution-session-stream/stream')
}

export async function publishExecutionSessionSnapshot(
  env: Pick<EnvBindings, 'EXECUTION_SESSION_STREAM'>,
  sessionId: string,
  snapshot: unknown
) {
  const stub = executionSessionStreamStub(env, sessionId)
  if (!stub) return
  await stub.fetch('https://execution-session-stream/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  })
}

export async function signalCompanyRuntime(
  env: Pick<EnvBindings, 'COMPANY_RUNTIME_COORDINATOR'>,
  companyId: string,
  signal: Record<string, unknown>
) {
  const stub = companyRuntimeStub(env, companyId)
  if (!stub) return
  await stub.fetch('https://company-runtime/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signal),
  })
}

/** Fan out an SSE event to all open listeners of `/api/companies/:id/stream`. */
export async function publishCompanyEvent(
  env: Pick<EnvBindings, 'COMPANY_RUNTIME_COORDINATOR'>,
  companyId: string,
  payload: { kind: string; [key: string]: unknown }
) {
  const stub = companyRuntimeStub(env, companyId)
  if (!stub) return
  await stub
    .fetch('https://company-runtime/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ts: Date.now() }),
    })
    .catch(() => {})
}

export async function openCompanyRuntimeLiveStream(
  env: Pick<EnvBindings, 'COMPANY_RUNTIME_COORDINATOR'>,
  companyId: string
) {
  const stub = companyRuntimeStub(env, companyId)
  if (!stub) {
    return new Response('Company runtime stream is not configured.', { status: 503 })
  }
  return stub.fetch('https://company-runtime/stream')
}

export class ExecutionSessionStreamDurableObject extends DurableObject<EnvBindings> {
  private listeners = new Map<string, StreamListener>()
  private lastSnapshot = ''

  constructor(ctx: DurableObjectState, env: EnvBindings) {
    super(ctx, env)
    void this.ctx.blockConcurrencyWhile(async () => {
      this.lastSnapshot = (await this.ctx.storage.get<string>('lastSnapshot')) || ''
    })
  }

  private broadcast(raw: string) {
    this.lastSnapshot = raw
    void this.ctx.storage.put('lastSnapshot', raw)
    for (const [listenerId, listener] of this.listeners.entries()) {
      try {
        listener.controller.enqueue(encodeSse('snapshot', raw))
      } catch {
        clearInterval(listener.heartbeat)
        this.listeners.delete(listenerId)
      }
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/publish' && request.method === 'POST') {
      const payload = (await request.json().catch(() => null)) as { snapshot?: unknown } | null
      this.broadcast(JSON.stringify(payload?.snapshot ?? {}))
      return new Response(null, { status: 202 })
    }

    if (url.pathname === '/stream') {
      const listenerId = crypto.randomUUID()
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
            } catch {
              clearInterval(heartbeat)
              this.listeners.delete(listenerId)
            }
          }, 15_000) as unknown as number

          this.listeners.set(listenerId, { controller, heartbeat })
          if (this.lastSnapshot) {
            controller.enqueue(encodeSse('snapshot', this.lastSnapshot))
          }
        },
        cancel: () => {
          const listener = this.listeners.get(listenerId)
          if (listener) {
            clearInterval(listener.heartbeat)
            this.listeners.delete(listenerId)
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}

export class CompanyRuntimeCoordinatorDurableObject extends DurableObject<EnvBindings> {
  private state: Record<string, unknown> = {}
  private listeners = new Map<string, StreamListener>()
  private lastEvent = ''

  constructor(ctx: DurableObjectState, env: EnvBindings) {
    super(ctx, env)
    void this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get<Record<string, unknown>>('state')) || {}
    })
  }

  private broadcast(raw: string) {
    this.lastEvent = raw
    for (const [listenerId, listener] of this.listeners.entries()) {
      try {
        listener.controller.enqueue(encodeSse('tick', raw))
      } catch {
        clearInterval(listener.heartbeat)
        this.listeners.delete(listenerId)
      }
    }
  }

  async alarm() {
    const companyId = this.state['companyId'] as string | undefined
    const tenantId = this.state['tenantId'] as string | undefined
    if (companyId && tenantId) {
      try {
        const { tickCompanyAgents } = await import('./agent-runtime')
        await tickCompanyAgents(this.env, { tenantId, companyId })
      } catch {
        // best-effort: don't let alarm failures break rescheduling
      }
    }
    // Re-schedule in 15 minutes
    const interval = (this.state['intervalMs'] as number | undefined) ?? 15 * 60 * 1000
    await this.ctx.storage.setAlarm(Date.now() + interval)
  }

  async fetch(request: Request) {
    const url = new URL(request.url)

    if (url.pathname === '/signal' && request.method === 'POST') {
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null
      this.state = { ...this.state, ...(payload || {}), updatedAt: Date.now() }
      await this.ctx.storage.put('state', this.state)
      return Response.json({ ok: true, state: this.state }, { status: 202 })
    }

    if (url.pathname === '/state') {
      return Response.json({ ok: true, state: this.state })
    }

    if (url.pathname === '/wake' && request.method === 'POST') {
      await this.ctx.storage.setAlarm(Date.now() + 100)
      return Response.json({ ok: true, scheduled: true })
    }

    if (url.pathname === '/schedule' && request.method === 'POST') {
      const { delayMs } = (await request.json().catch(() => ({ delayMs: 60_000 }))) as { delayMs?: number }
      await this.ctx.storage.setAlarm(Date.now() + (delayMs ?? 60_000))
      return Response.json({ ok: true, scheduled: true, delayMs })
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      const raw = await request.text()
      this.broadcast(raw || '{}')
      return new Response(null, { status: 202 })
    }

    if (url.pathname === '/stream') {
      const listenerId = crypto.randomUUID()
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
            } catch {
              clearInterval(heartbeat)
              this.listeners.delete(listenerId)
            }
          }, 15_000) as unknown as number

          this.listeners.set(listenerId, { controller, heartbeat })
          if (this.lastEvent) {
            controller.enqueue(encodeSse('tick', this.lastEvent))
          }
        },
        cancel: () => {
          const listener = this.listeners.get(listenerId)
          if (listener) {
            clearInterval(listener.heartbeat)
            this.listeners.delete(listenerId)
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}

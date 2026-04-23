import { DurableObject } from 'cloudflare:workers'
import type { EnvBindings } from './context'

type SnapshotListener = {
  controller: ReadableStreamDefaultController<Uint8Array>
  heartbeat: number
}

function threadStreamStub(env: Pick<EnvBindings, 'ASSISTANT_THREAD_STREAM'>, threadId: string) {
  if (!env.ASSISTANT_THREAD_STREAM) {
    return null
  }
  const id = env.ASSISTANT_THREAD_STREAM.idFromName(threadId)
  return env.ASSISTANT_THREAD_STREAM.get(id)
}

function encodeSse(event: string, data: string) {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`)
}

export async function openAssistantThreadLiveStream(
  env: Pick<EnvBindings, 'ASSISTANT_THREAD_STREAM'>,
  threadId: string
) {
  const stub = threadStreamStub(env, threadId)
  if (!stub) {
    return new Response('Assistant thread live stream is not configured.', { status: 503 })
  }
  return stub.fetch('https://assistant-thread-stream/stream')
}

export async function publishAssistantThreadSnapshot(
  env: Pick<EnvBindings, 'ASSISTANT_THREAD_STREAM'>,
  threadId: string,
  snapshot: unknown
) {
  const stub = threadStreamStub(env, threadId)
  if (!stub) {
    return
  }
  await stub.fetch('https://assistant-thread-stream/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  })
}

export class AssistantThreadStreamDurableObject extends DurableObject<EnvBindings> {
  private listeners = new Map<string, SnapshotListener>()
  private lastSnapshot = ''

  constructor(ctx: DurableObjectState, env: EnvBindings) {
    super(ctx, env)
    void this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<string>('lastSnapshot')
      this.lastSnapshot = stored || ''
    })
  }

  private broadcastSnapshot(raw: string) {
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
      this.broadcastSnapshot(JSON.stringify(payload?.snapshot ?? {}))
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

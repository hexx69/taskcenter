// Northstar — per-company CEO chat client.
// Talks to the worker routes added in worker/src/routes/northstar.ts.

export type NorthstarRole = "system" | "user" | "assistant";

export interface NorthstarMessage {
  id: string;
  threadId: string;
  role: NorthstarRole;
  content: string;
  createdAt: number;
  model?: string | null;
  // The backend returns a richer shape; we only expose what the UI renders.
}

export interface NorthstarThreadSnapshot {
  thread: { id: string; companyId: string | null };
  messages: NorthstarMessage[];
}

// A caller-provided event handler for streaming. Each `delta` is a raw text
// chunk to append to the in-flight assistant message. `done` fires exactly
// once with the persisted message id. `error` fires if the stream failed.
export interface NorthstarStreamHandlers {
  onDelta: (text: string) => void;
  onDone?: (messageId: string, usedModel: string) => void;
  onError?: (message: string) => void;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function normalizeMessage(raw: unknown): NorthstarMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  const role = row.role === "user" || row.role === "assistant" || row.role === "system" ? row.role : null;
  const content = typeof row.content === "string" ? row.content : "";
  const threadId = typeof row.threadId === "string" ? row.threadId : typeof row.thread_id === "string" ? row.thread_id : "";
  const createdAt =
    typeof row.createdAt === "number"
      ? row.createdAt
      : typeof row.created_at === "number"
        ? row.created_at
        : Date.now();
  if (!id || !role) return null;
  return { id, threadId, role, content, createdAt, model: (row.model as string | null | undefined) ?? null };
}

export const northstarApi = {
  // Resolve (or lazily create) this user's Northstar thread for the given company.
  getThread: async (companyId: string): Promise<NorthstarThreadSnapshot> => {
    const raw = await getJson<{ thread: { id: string; companyId?: string | null; company_id?: string | null }; messages: unknown[] }>(
      `/api/northstar/${encodeURIComponent(companyId)}/thread`,
    );
    const messages = (raw.messages ?? [])
      .map(normalizeMessage)
      .filter((m): m is NorthstarMessage => m !== null);
    return {
      thread: {
        id: raw.thread.id,
        companyId: raw.thread.companyId ?? raw.thread.company_id ?? null,
      },
      messages,
    };
  },

  // Stream a user message → CEO reply over SSE. Returns when the stream closes.
  // Caller is responsible for inserting an optimistic user message + a pending
  // assistant bubble that grows with `onDelta` calls.
  sendMessage: async (
    companyId: string,
    message: string,
    handlers: NorthstarStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetch(
      `/api/northstar/${encodeURIComponent(companyId)}/thread/messages/stream`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
        signal,
      },
    );
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(body || `Stream failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // SSE frames are separated by a blank line. Each frame is one or more
    // "field: value" lines. We only need `event:` and `data:`.
    const consumeFrame = (frame: string) => {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return;
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (event === "delta" && typeof payload.text === "string") {
          handlers.onDelta(payload.text);
        } else if (event === "done") {
          handlers.onDone?.(String(payload.messageId ?? ""), String(payload.usedModel ?? "unknown"));
        } else if (event === "error") {
          handlers.onError?.(String(payload.message ?? "Stream error"));
        }
      } catch {
        // Ignore malformed frames rather than killing the stream.
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        consumeFrame(frame);
        idx = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim().length > 0) consumeFrame(buffer);
  },

  // Post a report from a sub-agent into the CEO thread. The CEO will see it
  // as an "[Agent Report · <role>]" message next turn.
  postAgentReport: (
    companyId: string,
    payload: { agentRoleKey: string; agentName?: string; message: string },
  ) =>
    postJson<{ ok: boolean; threadId: string; messageId: string }>(
      `/api/northstar/${encodeURIComponent(companyId)}/agent-report`,
      payload,
    ),
};

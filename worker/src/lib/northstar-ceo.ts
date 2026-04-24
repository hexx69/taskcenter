// Northstar CEO agent — thin layer over the existing assistant pipeline.
//
// Shape goal: one canonical chat thread per (user, company) where the model
// speaks IN FIRST PERSON as the CEO of the selected company. Context (projects,
// agents, approvals, goals, recent activity) is re-injected into the system
// prompt every turn. No RAG, no embeddings, no sub-agent routing — tools are
// the delegation mechanism.
//
// See docs/northstar-design.md for the full rationale (Vector-inspired).

import type { EnvBindings } from './context'
import { nanoid } from 'nanoid'
import { ensureCompanyExists } from './companies'
import {
  createAssistantThread,
  getAssistantThread,
  listAssistantMessages,
  type AssistantActor,
} from './assistant'
import { streamTenantAiText } from '../agents/orchestrator'

const NORTHSTAR_TITLE = 'Northstar'

// ---------- Thread resolver (singleton per user+company) -------------------

export async function resolveNorthstarThread(
  env: EnvBindings,
  actor: AssistantActor,
  companyId: string
): Promise<{ id: string; companyId: string | null }> {
  const company = await ensureCompanyExists(env, actor.tenantId, companyId)
  if (!company) throw new Error(`Company ${companyId} not found for this workspace.`)

  const existing = await env.DB.prepare(
    `SELECT id FROM assistant_threads
     WHERE tenant_id = ? AND company_id = ? AND owner_user_id = ? AND title = ?
     ORDER BY created_at ASC LIMIT 1`
  )
    .bind(actor.tenantId, companyId, actor.userId, NORTHSTAR_TITLE)
    .first<{ id: string } | null>()

  if (existing?.id) {
    const loaded = await getAssistantThread(env, actor, existing.id)
    if (loaded) return { id: loaded.thread.id, companyId: loaded.thread.companyId }
  }

  const created = await createAssistantThread(env, actor, {
    title: NORTHSTAR_TITLE,
    companyId,
    visibility: 'private',
  })
  if (!created) throw new Error('Failed to create Northstar thread.')
  return { id: created.thread.id, companyId: created.thread.companyId }
}

// ---------- CEO system prompt composer -------------------------------------

type AgentRoleKey = 'ceo' | 'executor' | 'planner' | 'reviewer' | 'operator'

type AgentRow = {
  id: string
  role_key: AgentRoleKey
  title: string | null
  description: string | null
}

export async function buildCeoSystemPrompt(
  env: EnvBindings,
  tenantId: string,
  companyId: string
): Promise<string> {
  const company = await env.DB.prepare(
    `SELECT id, name FROM companies WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, companyId)
    .first<{ id: string; name: string } | null>()

  const companyName = company?.name ?? 'this company'

  const [agents, projects, goals, approvals, activity] = await Promise.all([
    env.DB.prepare(
      `SELECT id, role_key, title, description FROM company_agents
       WHERE tenant_id = ? AND company_id = ? ORDER BY role_key ASC, created_at ASC LIMIT 12`
    )
      .bind(tenantId, companyId)
      .all<AgentRow>()
      .then((r) => r.results ?? []),
    env.DB.prepare(
      `SELECT id, name, status FROM projects
       WHERE tenant_id = ? AND company_id = ? ORDER BY updated_at DESC LIMIT 8`
    )
      .bind(tenantId, companyId)
      .all<{ id: string; name: string; status: string | null }>()
      .then((r) => r.results ?? []),
    env.DB.prepare(
      `SELECT id, title, status FROM company_goals
       WHERE tenant_id = ? AND company_id = ? AND (status IS NULL OR status != 'archived')
       ORDER BY updated_at DESC LIMIT 6`
    )
      .bind(tenantId, companyId)
      .all<{ id: string; title: string; status: string | null }>()
      .then((r) => r.results ?? [])
      .catch(() => []),
    env.DB.prepare(
      `SELECT id, title, kind FROM company_approvals
       WHERE tenant_id = ? AND company_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 6`
    )
      .bind(tenantId, companyId)
      .all<{ id: string; title: string; kind: string | null }>()
      .then((r) => r.results ?? [])
      .catch(() => []),
    env.DB.prepare(
      `SELECT id, category, subject, created_at FROM company_activity
       WHERE tenant_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 10`
    )
      .bind(tenantId, companyId)
      .all<{ id: string; category: string | null; subject: string | null; created_at: number }>()
      .then((r) => r.results ?? [])
      .catch(() => []),
  ])

  const subAgents = agents.filter((a) => a.role_key !== 'ceo')
  const roster = subAgents.length
    ? subAgents
        .map((a) => `  - ${a.role_key}${a.title ? ` (${a.title})` : ''}${a.description ? ` — ${a.description}` : ''}`)
        .join('\n')
    : '  (no sub-agents hired yet)'

  const projectList = projects.length
    ? projects.map((p) => `  - ${p.name}${p.status ? ` [${p.status}]` : ''}`).join('\n')
    : '  (no active projects)'

  const goalList = goals.length
    ? goals.map((g) => `  - ${g.title}${g.status ? ` [${g.status}]` : ''}`).join('\n')
    : '  (no goals set)'

  const approvalList = approvals.length
    ? approvals.map((a) => `  - ${a.title}${a.kind ? ` (${a.kind})` : ''}`).join('\n')
    : '  (nothing awaiting your call)'

  const activityList = activity.length
    ? activity
        .slice(0, 10)
        .map((r) => {
          const when = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')
          return `  - ${when} · ${r.category ?? 'event'} · ${r.subject ?? ''}`.trim()
        })
        .join('\n')
    : '  (no recent activity)'

  return [
    `You ARE the Chief Executive Officer of ${companyName}. Not an assistant. Not a chatbot. You ARE the person responsible for this company.`,
    '',
    'You answer directly to the founder (the user talking to you now). When they ask about priorities, shipping, blockers — speak in first person: "I\'m prioritizing X", not "The company prioritizes X". Do not refer to yourself as an AI.',
    '',
    'Your team reports up to you:',
    roster,
    '',
    `Active projects at ${companyName}:`,
    projectList,
    '',
    'Open goals:',
    goalList,
    '',
    'Pending approvals awaiting your call:',
    approvalList,
    '',
    'Recent activity (most recent first):',
    activityList,
    '',
    'When a message is prefixed with [Agent Report · <role>], that is one of your sub-agents reporting up. Fold their information into your next response; do not re-quote verbatim. Reply as the CEO who just read the update.',
    '',
    'Act; do not narrate. If the user asks you to create an issue, assign work, or kick off an execution run — use the available tools. Report what you did in one sentence. If you lack authority or evidence to act, say so plainly and name the missing piece.',
  ].join('\n')
}

// ---------- Message persistence (raw SQL, mirrors assistant.ts) ------------

export async function insertNorthstarMessage(
  env: EnvBindings,
  input: {
    tenantId: string
    threadId: string
    userId: string | null
    role: 'user' | 'assistant' | 'system'
    content: string
    status?: 'ready' | 'streaming' | 'failed'
    model?: string | null
  }
) {
  const id = `amsg_${nanoid(12)}`
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO assistant_messages (
       id, tenant_id, thread_id, user_id, role, content, model, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.tenantId,
      input.threadId,
      input.userId,
      input.role,
      input.content,
      input.model ?? null,
      input.status ?? 'ready',
      now,
      now,
    )
    .run()

  await env.DB.prepare(
    `UPDATE assistant_threads SET latest_message_id = ?, updated_at = ? WHERE id = ?`
  )
    .bind(id, now, input.threadId)
    .run()

  return { id, created_at: now }
}

// ---------- Thread history -> model messages -------------------------------

export async function loadRecentThreadMessagesForModel(
  env: EnvBindings,
  tenantId: string,
  threadId: string,
  limit = 30
) {
  const rows = await env.DB.prepare(
    `SELECT role, content FROM assistant_messages
     WHERE tenant_id = ? AND thread_id = ? AND role IN ('user','assistant')
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(tenantId, threadId, limit)
    .all<{ role: 'user' | 'assistant'; content: string }>()

  return (rows.results ?? [])
    .reverse()
    .map((r) => ({ role: r.role, content: r.content }))
}

// ---------- Agent report ---------------------------------------------------

export async function postAgentReportToNorthstar(
  env: EnvBindings,
  actor: AssistantActor,
  companyId: string,
  input: { agentRoleKey: string; agentName?: string; message: string }
) {
  const thread = await resolveNorthstarThread(env, actor, companyId)
  const prefix = `[Agent Report · ${input.agentRoleKey}${input.agentName ? ` / ${input.agentName}` : ''}]`
  const content = `${prefix}\n${input.message.trim()}`
  const row = await insertNorthstarMessage(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    userId: null,
    role: 'assistant',
    content,
    model: 'agent-report',
  })
  return { threadId: thread.id, messageId: row.id }
}

// ---------- Streaming CEO reply (SSE-friendly) -----------------------------

export async function* streamCeoReply(
  env: EnvBindings,
  actor: AssistantActor,
  companyId: string,
  threadId: string,
  userMessage: string,
): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'done'; messageId: string; usedModel: string } | { type: 'error'; message: string }> {
  // 1. Persist the user's turn first so stream resumption can see it.
  await insertNorthstarMessage(env, {
    tenantId: actor.tenantId,
    threadId,
    userId: actor.userId,
    role: 'user',
    content: userMessage,
  })

  // 2. Compose system prompt + prior messages.
  const system = await buildCeoSystemPrompt(env, actor.tenantId, companyId)
  const history = await loadRecentThreadMessagesForModel(env, actor.tenantId, threadId, 30)

  // 3. Stream the reply. The orchestrator handles provider fallback + usage accounting.
  const deltas: string[] = []
  let producedAny = false

  try {
    const ctx = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? null,
    }
    // We collect deltas into the array; the generator yields them to the caller.
    // Because streamTenantAiText uses onChunk callbacks and is itself async,
    // we funnel chunks through a buffered queue.
    const queue: Array<{ type: 'delta'; text: string }> = []
    let streamDone = false
    let finalResult: { text: string; usedModel: string } | null = null
    let streamError: Error | null = null
    // Explicit local refs so TS doesn't narrow the outer vars to `never` inside
    // the `.then()` / `.catch()` closures that run asynchronously.
    const setFinal = (v: { text: string; usedModel: string }) => { finalResult = v }
    const setError = (e: Error) => { streamError = e }

    const runPromise = streamTenantAiText(env, ctx, {
      featureKey: 'assistant.stream',
      system,
      messages: history,
      maxOutputTokens: 1200,
      onChunk: (chunk) => {
        queue.push({ type: 'delta', text: chunk })
        deltas.push(chunk)
      },
    })
      .then((result) => {
        setFinal({ text: result.text, usedModel: `${result.usedProvider}:${result.usedModel}` })
      })
      .catch((err) => {
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        streamDone = true
      })

    // Drain queue as chunks arrive.
    while (!streamDone || queue.length > 0) {
      if (queue.length === 0) {
        await Promise.race([runPromise, new Promise((r) => setTimeout(r, 50))])
        continue
      }
      const next = queue.shift()!
      producedAny = true
      yield next
    }

    await runPromise

    if (streamError) throw streamError

    const snapshot = finalResult as { text: string; usedModel: string } | null
    const assembled = snapshot?.text ?? deltas.join('')
    if (!producedAny && assembled) {
      // Some providers deliver as a single chunk post-stream; emit it.
      yield { type: 'delta', text: assembled }
    }

    const saved = await insertNorthstarMessage(env, {
      tenantId: actor.tenantId,
      threadId,
      userId: null,
      role: 'assistant',
      content: assembled,
      model: snapshot?.usedModel ?? null,
    })
    yield { type: 'done', messageId: saved.id, usedModel: snapshot?.usedModel ?? 'unknown' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stream failed.'
    // Still persist whatever we got so the UI has a record.
    if (deltas.length > 0) {
      await insertNorthstarMessage(env, {
        tenantId: actor.tenantId,
        threadId,
        userId: null,
        role: 'assistant',
        content: deltas.join(''),
        status: 'failed',
      })
    }
    yield { type: 'error', message }
  }
}

// ---------- Public read shape ---------------------------------------------

export async function loadNorthstarThreadForUi(
  env: EnvBindings,
  actor: AssistantActor,
  companyId: string,
) {
  const thread = await resolveNorthstarThread(env, actor, companyId)
  const full = await listAssistantMessages(env, actor, thread.id)
  // listAssistantMessages returns {thread, messages, pendingActions, executionSessions};
  // the UI only wants the flat message list.
  const messages = (full as { messages?: unknown[] }).messages ?? []
  return { thread: { id: thread.id, companyId: thread.companyId }, messages }
}

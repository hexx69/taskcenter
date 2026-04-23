import { generateTenantAiText } from '../agents/orchestrator'
import { upsertProjectSearchIndex } from '../db/project-index'
import { newId } from './ids'
import { buildChatTools } from './chat-tools'
import { buildProjectRagContext } from './project-rag'
import { ensureProjectExists } from './projects'
import { createDebugInvestigation } from './debug'
import { refreshProjectMemoryDocs } from './project-memory'
import { upsertAppMemoryEntry } from './app-memory'
import type { EnvBindings, RequestContext } from './context'
import { applyProposalActions, canModerateRole } from '../routes/proposals'
import { decryptStoredSecret } from './secrets'
import { recordRuntimeEvent } from './runtime-events'
import { publishAssistantThreadSnapshot } from './assistant-live'
import { publishExecutionSessionSnapshot, signalCompanyRuntime } from './control-plane-live'
import { ensureCompanyExists, getCompanyForProject, listCompanyInstructionBundles } from './companies'
import { loadRuntimeToolSession } from './tool-registry'

export type AssistantThreadVisibility = 'private' | 'shared' | 'public'
export type AssistantThreadStatus = 'idle' | 'streaming' | 'blocked' | 'error'
export type AssistantMessageRole = 'system' | 'user' | 'assistant'
export type AssistantMessagePartType =
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'pending_action'
  | 'proposal_card'
  | 'execution_card'
  | 'system_notice'

export type AssistantPendingActionKind =
  | 'proposal_apply'
  | 'proposal_draft'
  | 'execution_start'

export type ExecutionSessionMode =
  | 'implementation'
  | 'repo_review'
  | 'debug_investigation'
  | 'planning'

export type ExecutionSessionProvider = 'codex' | 'claude' | 'shell'
export type ExecutionSessionTransport = 'cloud' | 'bridge_cli'

type BridgeTransportConfig = {
  status: 'active' | 'pending' | 'disabled' | 'missing'
  summary: string | null
  serverUrl: string | null
  machineId: string | null
  authToken: string | null
  defaultCwd: string | null
  repoRoots: Record<string, string>
  autoLaunch: boolean
  defaultProvider: ExecutionSessionProvider
  updatedAt: number | null
}

export type AssistantActor = Pick<RequestContext, 'tenantId' | 'userId' | 'userEmail' | 'role' | 'userName'>

type AssistantRuntimeContext = {
  currentPage?: string
  currentRoute?: string
  activeView?: string
  companyName?: string
  currentUserId?: string
  currentUserName?: string
  currentUserEmail?: string
  projectName?: string
  selectedWorkstreamId?: string
  selectedWorkstreamName?: string
  projectViewMode?: 'detailed' | 'compact'
  workspaceName?: string
  selectedTaskId?: string
  selectedTaskTitle?: string
  selectedTaskStatus?: string
  selectedConnectorKeys?: string[]
  selectedConnectorLabels?: string[]
  screenSummary?: string
  conversationSummary?: string
  toolSummary?: string
  activeGoal?: string
}

type AssistantThreadRow = {
  id: string
  tenant_id: string
  company_id: string | null
  project_id: string | null
  owner_user_id: string
  title: string
  visibility: AssistantThreadVisibility
  status: AssistantThreadStatus
  summary: string | null
  current_page: string | null
  current_route: string | null
  active_goal: string | null
  latest_message_id: string | null
  created_at: number
  updated_at: number
}

type AssistantMessageRow = {
  id: string
  tenant_id: string
  thread_id: string
  user_id: string | null
  role: AssistantMessageRole
  content: string
  model: string | null
  status: string
  created_at: number
  updated_at: number
}

type AssistantMessagePartRow = {
  id: string
  tenant_id: string
  thread_id: string
  message_id: string
  part_order: number
  part_type: AssistantMessagePartType
  status: string
  summary: string | null
  payload_json: string
  created_at: number
  updated_at: number
}

type AssistantPendingActionRow = {
  id: string
  tenant_id: string
  thread_id: string
  company_id: string | null
  project_id: string | null
  kind: AssistantPendingActionKind
  status: string
  title: string
  summary: string | null
  payload_json: string
  created_by: string
  confirmed_by: string | null
  cancelled_by: string | null
  executed_at: number | null
  created_at: number
  updated_at: number
}

type ExecutionSessionRow = {
  id: string
  tenant_id: string
  company_id: string | null
  project_id: string | null
  thread_id: string | null
  item_id: string | null
  proposal_id: string | null
  initiated_by: string
  mode: ExecutionSessionMode
  provider: ExecutionSessionProvider
  transport: ExecutionSessionTransport
  status: string
  title: string
  summary: string | null
  target_ref: string | null
  callback_secret: string | null
  external_run_id: string | null
  metadata_json: string | null
  result_json: string | null
  error_message: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
}

type ExecutionSessionEventRow = {
  id: string
  session_id: string
  event_type: string
  status: string | null
  message: string | null
  payload_json: string | null
  created_at: number
}

type PendingActionProposalPayload = {
  projectId: string
  title: string
  summary: string
  impactLevel: 'low' | 'medium' | 'high'
  actions: Array<
    | {
        type: 'task.upsert'
        payload: { id?: string; title: string; status: 'todo' | 'in_progress' | 'review' | 'done'; assignees?: string[]; tags?: string[] }
      }
    | {
        type: 'task.assign'
        payload: { taskId: string; assigneeId: string }
      }
    | {
        type: 'epic.upsert'
        payload: { id?: string; title: string; objective?: string }
      }
    | {
        type: 'member.assign'
        payload: { memberId: string }
      }
  >
  applyOnConfirm: boolean
  executionMode?: 'human' | 'ai_assisted' | 'ai_autonomous'
}

type PendingExecutionPayload = {
  projectId: string
  mode: ExecutionSessionMode
  provider: ExecutionSessionProvider
  transport: ExecutionSessionTransport
  title: string
  summary: string
  itemId?: string | null
  proposalId?: string | null
  metadata?: Record<string, unknown>
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function compactText(input: string, limit = 160) {
  const normalized = input.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

function lower(input: string) {
  return input.trim().toLowerCase()
}

async function readBridgeTransportConfig(env: EnvBindings, tenantId: string): Promise<BridgeTransportConfig> {
  const row = await env.DB.prepare(
    `SELECT status, summary, config_json, updated_at
     FROM admin_integration_configs
     WHERE tenant_id = ? AND integration_key = 'bridge_cli'
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ status: string; summary: string | null; config_json: string | null; updated_at: number | null } | null>()

  if (!row) {
    return {
      status: 'missing',
      summary: null,
      serverUrl: null,
      machineId: null,
      authToken: null,
      defaultCwd: null,
      repoRoots: {},
      autoLaunch: false,
      defaultProvider: 'codex',
      updatedAt: null,
    }
  }

  const parsed = parseJson<Record<string, unknown>>(row.config_json, {})
  let authToken: string | null = null
  try {
    authToken = await decryptStoredSecret(env, typeof parsed.authToken === 'string' ? parsed.authToken : null)
  } catch {
    authToken = null
  }

  return {
    status: row.status === 'active' || row.status === 'pending' || row.status === 'disabled' ? row.status : 'missing',
    summary: row.summary,
    serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl.trim() || null : null,
    machineId: typeof parsed.machineId === 'string' ? parsed.machineId.trim() || null : null,
    authToken,
    defaultCwd: typeof parsed.defaultCwd === 'string' ? parsed.defaultCwd.trim() || null : null,
    repoRoots: typeof parsed.repoRoots === 'object' && parsed.repoRoots ? (parsed.repoRoots as Record<string, string>) : {},
    autoLaunch: parsed.autoLaunch === false ? false : true,
    defaultProvider:
      parsed.defaultProvider === 'claude' || parsed.defaultProvider === 'shell' || parsed.defaultProvider === 'codex'
        ? parsed.defaultProvider
        : 'codex',
    updatedAt: row.updated_at,
  }
}

async function resolveBridgeExecutionCwd(
  env: EnvBindings,
  tenantId: string,
  projectId: string | null | undefined,
  bridgeConfig: BridgeTransportConfig
) {
  if (!projectId) {
    return bridgeConfig.defaultCwd
  }
  const repoLink = await env.DB.prepare(
    `SELECT repo_full_name
     FROM project_github_links
     WHERE tenant_id = ? AND project_id = ?
     LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<{ repo_full_name: string } | null>()

  if (repoLink?.repo_full_name && bridgeConfig.repoRoots[repoLink.repo_full_name]) {
    return bridgeConfig.repoRoots[repoLink.repo_full_name]
  }

  return bridgeConfig.defaultCwd
}

async function getThreadRow(env: EnvBindings, tenantId: string, threadId: string) {
  return env.DB.prepare(
    `SELECT *
     FROM assistant_threads
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, threadId)
    .first<AssistantThreadRow | null>()
}

async function getThreadMemberRole(env: EnvBindings, tenantId: string, threadId: string, userId: string) {
  return env.DB.prepare(
    `SELECT role
     FROM assistant_thread_members
     WHERE tenant_id = ? AND thread_id = ? AND user_id = ?
     LIMIT 1`
  )
    .bind(tenantId, threadId, userId)
    .first<{ role: 'viewer' | 'commenter' | 'editor' } | null>()
}

async function canViewThread(env: EnvBindings, actor: AssistantActor, thread: AssistantThreadRow) {
  if (thread.visibility === 'public') return true
  if (thread.owner_user_id === actor.userId) return true
  const member = await getThreadMemberRole(env, actor.tenantId, thread.id, actor.userId)
  return Boolean(member)
}

async function canEditThread(env: EnvBindings, actor: AssistantActor, thread: AssistantThreadRow) {
  if (thread.owner_user_id === actor.userId) return true
  const member = await getThreadMemberRole(env, actor.tenantId, thread.id, actor.userId)
  return member?.role === 'editor' || member?.role === 'commenter'
}

async function touchThread(
  env: EnvBindings,
  threadId: string,
  input: Partial<Pick<AssistantThreadRow, 'status' | 'summary' | 'current_page' | 'current_route' | 'active_goal' | 'latest_message_id'>> & {
    updatedAt?: number
  }
) {
  const updatedAt = input.updatedAt ?? Date.now()
  await env.DB.prepare(
    `UPDATE assistant_threads
     SET status = COALESCE(?, status),
         summary = COALESCE(?, summary),
         current_page = COALESCE(?, current_page),
         current_route = COALESCE(?, current_route),
         active_goal = COALESCE(?, active_goal),
         latest_message_id = COALESCE(?, latest_message_id),
         updated_at = ?
     WHERE id = ?`
  )
    .bind(
      input.status ?? null,
      input.summary ?? null,
      input.current_page ?? null,
      input.current_route ?? null,
      input.active_goal ?? null,
      input.latest_message_id ?? null,
      updatedAt,
      threadId
    )
    .run()
}

async function insertAssistantMessage(
  env: EnvBindings,
  input: {
    tenantId: string
    threadId: string
    userId?: string | null
    role: AssistantMessageRole
    content: string
    model?: string | null
    status?: string
  }
) {
  const now = Date.now()
  const id = newId('athmsg')
  await env.DB.prepare(
    `INSERT INTO assistant_messages (
      id, tenant_id, thread_id, user_id, role, content, model, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.tenantId,
      input.threadId,
      input.userId ?? null,
      input.role,
      input.content,
      input.model ?? null,
      input.status ?? 'completed',
      now,
      now
    )
    .run()

  return {
    id,
    createdAt: now,
  }
}

async function insertAssistantMessagePart(
  env: EnvBindings,
  input: {
    tenantId: string
    threadId: string
    messageId: string
    order: number
    partType: AssistantMessagePartType
    payload: Record<string, unknown>
    summary?: string | null
    status?: string
  }
) {
  const now = Date.now()
  const id = newId('athpart')
  await env.DB.prepare(
    `INSERT INTO assistant_message_parts (
      id, tenant_id, thread_id, message_id, part_order, part_type, status, summary, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.tenantId,
      input.threadId,
      input.messageId,
      input.order,
      input.partType,
      input.status ?? 'completed',
      input.summary ?? null,
      JSON.stringify(input.payload),
      now,
      now
    )
    .run()
}

export async function createPendingAction(
  env: EnvBindings,
  actor: AssistantActor,
  input: {
    threadId: string
    companyId?: string | null
    projectId?: string | null
    kind: AssistantPendingActionKind
    title: string
    summary: string
    payload: PendingActionProposalPayload | PendingExecutionPayload
  }
) {
  const id = newId('apact')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO assistant_pending_actions (
      id, tenant_id, thread_id, company_id, project_id, kind, status, title, summary, payload_json, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      actor.tenantId,
      input.threadId,
      input.companyId ?? null,
      input.projectId ?? null,
      input.kind,
      input.title,
      input.summary,
      JSON.stringify(input.payload),
      actor.userId,
      now,
      now
    )
    .run()

  return id
}

async function insertExecutionEvent(
  env: EnvBindings,
  input: {
    tenantId: string
    sessionId: string
    eventType: string
    status?: string | null
    message?: string | null
    payload?: Record<string, unknown> | null
  }
) {
  await env.DB.prepare(
    `INSERT INTO execution_session_events (
      id, tenant_id, session_id, event_type, status, message, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('esevt'),
      input.tenantId,
      input.sessionId,
      input.eventType,
      input.status ?? null,
      input.message ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      Date.now()
    )
    .run()
}

async function createExecutionSessionRecord(
  env: EnvBindings,
  actor: AssistantActor,
  input: {
    companyId?: string | null
    projectId?: string | null
    threadId?: string | null
    itemId?: string | null
    proposalId?: string | null
    mode: ExecutionSessionMode
    provider: ExecutionSessionProvider
    transport: ExecutionSessionTransport
    title: string
    summary: string
    targetRef?: string | null
    metadata?: Record<string, unknown>
  }
) {
  const id = newId('exec')
  const now = Date.now()
  const callbackSecret = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO execution_sessions (
      id, tenant_id, company_id, project_id, thread_id, item_id, proposal_id, initiated_by, mode, provider, transport, status,
      title, summary, target_ref, callback_secret, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      actor.tenantId,
      input.companyId ?? null,
      input.projectId ?? null,
      input.threadId ?? null,
      input.itemId ?? null,
      input.proposalId ?? null,
      actor.userId,
      input.mode,
      input.provider,
      input.transport,
      input.title,
      input.summary,
      input.targetRef ?? null,
      callbackSecret,
      JSON.stringify(input.metadata || {}),
      now,
      now
    )
    .run()

  if (input.itemId) {
    await env.DB.prepare(
      `INSERT INTO item_execution_links (id, tenant_id, item_id, session_id, link_type, created_at)
       VALUES (?, ?, ?, ?, 'latest', ?)`
    )
      .bind(newId('itexec'), actor.tenantId, input.itemId, id, now)
      .run()
      .catch(() => {})
  }

  await insertExecutionEvent(env, {
    tenantId: actor.tenantId,
    sessionId: id,
    eventType: 'session_created',
    status: 'queued',
    message: input.summary,
    payload: {
      mode: input.mode,
      provider: input.provider,
      transport: input.transport,
      title: input.title,
    },
  })

  if (input.transport === 'bridge_cli') {
    const bridgeConfig = await readBridgeTransportConfig(env, actor.tenantId)
    if (bridgeConfig.status === 'active' && bridgeConfig.autoLaunch) {
      await launchBridgeExecutionSessionInternal(env, actor, { sessionId: id }).catch(async (error) => {
        await recordRuntimeEvent(env, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          projectId: input.projectId ?? null,
          routeKey: 'execution.bridge_launch',
          category: 'bridge_launch_failed',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Bridge launch failed.',
          metadata: { sessionId: id, transport: 'bridge_cli', autoLaunch: true },
        }).catch(() => {})
      })
    }
  }

  await publishExecutionSessionState(env, id, actor)
  if (input.companyId) {
    await signalCompanyRuntime(env, input.companyId, {
      companyId: input.companyId,
      lastExecutionSessionId: id,
      lastExecutionStatus: 'queued',
      lastExecutionTransport: input.transport,
      updatedAt: now,
    }).catch(() => {})
  }

  return id
}

async function launchBridgeExecutionSessionInternal(
  env: EnvBindings,
  actor: AssistantActor,
  input: {
    sessionId: string
    manual?: boolean
  }
) {
  const row = await env.DB.prepare(
    `SELECT *
     FROM execution_sessions
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(actor.tenantId, input.sessionId)
    .first<ExecutionSessionRow | null>()

  if (!row) {
    throw new Error('Execution session not found.')
  }
  if (row.transport !== 'bridge_cli') {
    throw new Error('Execution session does not use bridge_cli transport.')
  }

  const bridgeConfig = await readBridgeTransportConfig(env, actor.tenantId)
  if (bridgeConfig.status !== 'active' || !bridgeConfig.serverUrl || !bridgeConfig.machineId || !bridgeConfig.authToken) {
    throw new Error('Bridge transport is not fully configured in admin.')
  }

  const callbackBase = (env.PUBLIC_APP_URL || '').trim()
  if (!callbackBase) {
    throw new Error('PUBLIC_APP_URL must be configured before Bridge auto-launch can callback safely.')
  }

  const cwd = await resolveBridgeExecutionCwd(env, actor.tenantId, row.project_id, bridgeConfig)
  if (!cwd) {
    throw new Error('Bridge transport is missing a working directory. Add a default cwd or repo mapping in admin.')
  }

  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
  const callbackUrl = `${callbackBase.replace(/\/$/, '')}/api/public/execution-sessions/${row.id}/callback`
  const spec =
    row.provider === 'shell'
      ? {
          runtime: 'terminal-session',
          cwd,
          startedBy: 'bridge',
          taskcenter: {
            executionSessionId: row.id,
            callbackUrl,
            callbackSecret: row.callback_secret || '',
            provider: 'shell',
            transport: 'bridge_cli',
            projectId: row.project_id || undefined,
            threadId: row.thread_id || undefined,
            itemId: row.item_id || undefined,
            metadata,
          },
        }
      : {
          runtime: 'agent-session',
          agent: row.provider,
          cwd,
          startedBy: 'bridge',
          taskcenter: {
            executionSessionId: row.id,
            callbackUrl,
            callbackSecret: row.callback_secret || '',
            provider: row.provider,
            transport: 'bridge_cli',
            projectId: row.project_id || undefined,
            threadId: row.thread_id || undefined,
            itemId: row.item_id || undefined,
            metadata,
          },
        }

  const response = await fetch(`${bridgeConfig.serverUrl.replace(/\/$/, '')}/machines/${encodeURIComponent(bridgeConfig.machineId)}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridgeConfig.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(spec),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    await insertExecutionEvent(env, {
      tenantId: actor.tenantId,
      sessionId: row.id,
      eventType: input.manual ? 'bridge_launch_retry_failed' : 'bridge_launch_failed',
      status: 'failed',
      message: body || `Bridge launch failed with status ${response.status}.`,
      payload: {
        bridgeServerUrl: bridgeConfig.serverUrl,
        machineId: bridgeConfig.machineId,
        cwd,
      },
    })
    await recordRuntimeEvent(env, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      projectId: row.project_id,
      routeKey: 'execution.bridge_launch',
      category: 'bridge_launch_failed',
      severity: 'error',
      message: body || `Bridge launch failed for execution session ${row.id}.`,
      metadata: { sessionId: row.id, machineId: bridgeConfig.machineId, serverUrl: bridgeConfig.serverUrl, status: response.status },
    }).catch(() => {})
    throw new Error(body || `Bridge launch failed (${response.status}).`)
  }

  const launchResult = (await response.json().catch(() => ({}))) as { id?: string; status?: string; cwd?: string }
  const launchMetadata = {
    ...metadata,
    bridgeLaunch: {
      launchedAt: Date.now(),
      bridgeSessionId: launchResult.id || null,
      machineId: bridgeConfig.machineId,
      cwd,
      lastManualLaunch: Boolean(input.manual),
    },
  }

  await env.DB.prepare(
    `UPDATE execution_sessions
     SET external_run_id = COALESCE(?, external_run_id),
         metadata_json = ?,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(launchResult.id || null, JSON.stringify(launchMetadata), Date.now(), row.id)
    .run()

  await insertExecutionEvent(env, {
    tenantId: actor.tenantId,
    sessionId: row.id,
    eventType: input.manual ? 'bridge_launch_retried' : 'bridge_launch_requested',
    status: 'queued',
    message: `Bridge accepted execution launch on ${bridgeConfig.machineId}.`,
    payload: {
      bridgeServerUrl: bridgeConfig.serverUrl,
      machineId: bridgeConfig.machineId,
      cwd,
      bridgeSessionId: launchResult.id || null,
    },
  })

  await recordRuntimeEvent(env, {
    tenantId: actor.tenantId,
    userId: actor.userId,
    projectId: row.project_id,
    routeKey: 'execution.bridge_launch',
    category: 'bridge_launch_requested',
    severity: 'info',
    message: `Bridge launch requested for execution session ${row.id}.`,
    metadata: { sessionId: row.id, machineId: bridgeConfig.machineId, bridgeSessionId: launchResult.id || null, cwd },
  }).catch(() => {})

  if (row.thread_id) {
    await publishThreadSnapshot(env, row.thread_id)
  }

  await publishExecutionSessionState(env, row.id, actor)
  if (row.company_id) {
    await signalCompanyRuntime(env, row.company_id, {
      companyId: row.company_id,
      lastExecutionSessionId: row.id,
      lastExecutionStatus: 'queued',
      lastExecutionTransport: row.transport,
      updatedAt: Date.now(),
    }).catch(() => {})
  }

  return getExecutionSession(env, actor, row.id)
}

function detectMessageIntent(message: string) {
  const normalized = lower(message)
  const requestsTaskCreate = /\b(create|add|make)\b/.test(normalized) && /\b(task|todo|item)\b/.test(normalized)
  const requestsAssignment = /\b(assign|reassign|take this|give this)\b/.test(normalized)
  const requestsEpic = /\b(epic)\b/.test(normalized) && /\b(create|add|define|make)\b/.test(normalized)
  const requestsPlanning = /\b(plan|proposal|scope|roadmap|break this down)\b/.test(normalized)
  const requestsDebug = /\b(debug|investigate|broken|failing|failure|error|not working)\b/.test(normalized)
  const requestsReview = /\b(review|pr|pull request|push|commit|diff)\b/.test(normalized)
  const requestsExecution =
    /\b(build|implement|fix|ship|execute|run this|launch|start)\b/.test(normalized) &&
    /\b(issue|task|execution|session|run|implementation|work)\b/.test(normalized)
  const requestsBridgeTransport = /\b(bridge|local machine|local run|run locally|local cli)\b/.test(normalized)
  const requestsCloudTransport = /\b(cloud run|run in cloud|remote cloud)\b/.test(normalized)
  return {
    requestsTaskCreate,
    requestsAssignment,
    requestsEpic,
    requestsPlanning,
    requestsDebug,
    requestsReview,
    requestsExecution,
    requestsBridgeTransport,
    requestsCloudTransport,
  }
}

function extractTitleFromMessage(message: string, fallback: string) {
  const cleaned = message
    .replace(/\b(create|add|make|task|todo|please|northstar|for me)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return compactText(cleaned || fallback, 90)
}

function computeMaxOutputTokens(
  message: string,
  intents: ReturnType<typeof detectMessageIntent>,
  hasRagContext: boolean
) {
  const length = message.length
  const intentCount =
    (intents.requestsTaskCreate ? 1 : 0) +
    (intents.requestsAssignment ? 1 : 0) +
    (intents.requestsEpic ? 1 : 0) +
    (intents.requestsPlanning ? 1 : 0) +
    (intents.requestsDebug ? 1 : 0) +
    (intents.requestsReview ? 1 : 0) +
    (intents.requestsExecution ? 1 : 0)

  // Complex planning with retrieval context: needs room for structured output
  if (intents.requestsPlanning && hasRagContext && length > 400) return 4000
  if (intents.requestsPlanning || intents.requestsReview || intents.requestsDebug) return 2500
  if (intentCount >= 2) return 2500
  if (intentCount === 1) return 1500
  // Short questions without intents still deserve a proper reply
  if (length > 400 || hasRagContext) return 1500
  return 800
}

async function maybeCreateIntentArtifacts(
  env: EnvBindings,
  actor: AssistantActor,
  input: {
    thread: AssistantThreadRow
    projectId?: string | null
    message: string
    runtimeContext?: AssistantRuntimeContext
  }
) {
  const intents = detectMessageIntent(input.message)
  const partRefs: Array<{
    type: AssistantMessagePartType
    summary: string
    payload: Record<string, unknown>
  }> = []
  const references: {
    pendingActionIds: string[]
    executionSessionIds: string[]
  } = { pendingActionIds: [], executionSessionIds: [] }

  if (input.projectId && intents.requestsTaskCreate) {
    const title = extractTitleFromMessage(input.message, 'New task')
    const pendingActionId = await createPendingAction(env, actor, {
      threadId: input.thread.id,
      companyId: input.thread.company_id,
      projectId: input.projectId,
      kind: 'proposal_apply',
      title: `Create task: ${title}`,
      summary: 'Task change ready for confirmation in chat.',
      payload: {
        projectId: input.projectId,
        title: `Northstar change for ${title}`,
        summary: input.message,
        impactLevel: 'low',
        actions: [
          {
            type: 'task.upsert',
            payload: {
              title,
              status: 'todo',
              assignees: actor.userId ? [actor.userId] : undefined,
              tags: ['assistant'],
            },
          },
        ],
        applyOnConfirm: true,
        executionMode: 'ai_assisted',
      },
    })
    references.pendingActionIds.push(pendingActionId)
    partRefs.push({
      type: 'pending_action',
      summary: 'Queued a task change for confirmation.',
      payload: { actionId: pendingActionId, actionType: 'task_create' },
    })
  }

  if (input.projectId && intents.requestsAssignment && input.runtimeContext?.selectedTaskId) {
    const pendingActionId = await createPendingAction(env, actor, {
      threadId: input.thread.id,
      companyId: input.thread.company_id,
      projectId: input.projectId,
      kind: 'proposal_apply',
      title: `Assign task ${input.runtimeContext.selectedTaskTitle || input.runtimeContext.selectedTaskId}`,
      summary: 'Assignment change ready for confirmation in chat.',
      payload: {
        projectId: input.projectId,
        title: `Northstar assignment for ${input.runtimeContext.selectedTaskTitle || 'selected task'}`,
        summary: input.message,
        impactLevel: 'low',
        actions: [
          {
            type: 'task.assign',
            payload: {
              taskId: input.runtimeContext.selectedTaskId,
              assigneeId: actor.userId,
            },
          },
        ],
        applyOnConfirm: true,
        executionMode: 'human',
      },
    })
    references.pendingActionIds.push(pendingActionId)
    partRefs.push({
      type: 'pending_action',
      summary: 'Queued an assignment change for confirmation.',
      payload: { actionId: pendingActionId, actionType: 'task_assign' },
    })
  }

  if (input.projectId && intents.requestsEpic) {
    const title = extractTitleFromMessage(input.message, 'New epic')
    const pendingActionId = await createPendingAction(env, actor, {
      threadId: input.thread.id,
      companyId: input.thread.company_id,
      projectId: input.projectId,
      kind: 'proposal_draft',
      title: `Draft epic: ${title}`,
      summary: 'Epic proposal ready to save from chat.',
      payload: {
        projectId: input.projectId,
        title: `Northstar epic draft for ${title}`,
        summary: input.message,
        impactLevel: 'medium',
        actions: [
          {
            type: 'epic.upsert',
            payload: {
              title,
              objective: compactText(input.message, 220),
            },
          },
        ],
        applyOnConfirm: false,
        executionMode: 'ai_assisted',
      },
    })
    references.pendingActionIds.push(pendingActionId)
    partRefs.push({
      type: 'proposal_card',
      summary: 'Drafted an epic proposal for review.',
      payload: { actionId: pendingActionId, actionType: 'epic_draft' },
    })
  }

  if (input.projectId && intents.requestsDebug) {
    const details = await createDebugInvestigation(
      env,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        userEmail: actor.userEmail ?? null,
      },
      {
        projectId: input.projectId,
        mode: intents.requestsReview ? 'push_review' : 'bug_repro',
        summary: input.message.slice(0, 4000),
        evidenceSources: ['assistant_thread', 'project_state', 'runtime_errors'],
        screenContext: input.runtimeContext ? { ...input.runtimeContext } : null,
      }
    ).catch(() => null)

    if (details?.session) {
      references.executionSessionIds.push(String(details.session.id))
      partRefs.push({
        type: 'execution_card',
        summary: 'Opened a durable investigation session.',
        payload: {
          sessionId: details.session.id,
          mode: details.session.mode,
          status: details.session.status,
          title: details.session.summary,
        },
      })
    }
  } else if (input.projectId && intents.requestsExecution) {
    const bridgeConfig = await readBridgeTransportConfig(env, actor.tenantId)
    const shouldUseBridge =
      intents.requestsBridgeTransport ||
      (!intents.requestsCloudTransport && bridgeConfig.status === 'active' && bridgeConfig.autoLaunch)
    const selectedTransport: ExecutionSessionTransport = shouldUseBridge ? 'bridge_cli' : 'cloud'
    const selectedProvider: ExecutionSessionProvider =
      shouldUseBridge ? bridgeConfig.defaultProvider : 'codex'
    const pendingActionId = await createPendingAction(env, actor, {
      threadId: input.thread.id,
      companyId: input.thread.company_id,
      projectId: input.projectId,
      kind: 'execution_start',
      title: 'Start AI execution session',
      summary: 'Execution session is staged and waiting for confirmation.',
      payload: {
        projectId: input.projectId,
        mode: intents.requestsPlanning ? 'planning' : intents.requestsReview ? 'repo_review' : 'implementation',
        provider: selectedProvider,
        transport: selectedTransport,
        title: compactText(input.message, 90),
        summary: input.message,
        itemId: input.runtimeContext?.selectedTaskId ?? null,
        metadata: {
          selectedTaskId: input.runtimeContext?.selectedTaskId ?? null,
          selectedTaskTitle: input.runtimeContext?.selectedTaskTitle ?? null,
          collaborativeReview: intents.requestsReview,
          transportDecision: selectedTransport,
          requestedLocalExecution: intents.requestsBridgeTransport,
        },
      },
    })
    references.pendingActionIds.push(pendingActionId)
    partRefs.push({
      type: 'execution_card',
      summary: 'Staged an execution session for confirmation.',
      payload: { actionId: pendingActionId, mode: 'implementation', status: 'pending' },
    })
  }

  return { partRefs, references }
}

function buildAssistantSystemPrompt(input: {
  thread: AssistantThreadRow
  companyName?: string | null
  projectName?: string | null
  runtimeContext?: AssistantRuntimeContext
  ragContext?: Awaited<ReturnType<typeof buildProjectRagContext>> | null
  companyInstructions?: { bundles: Array<{ bundleKey: string; title: string; markdown: string; summary: string | null }> } | null
  pendingActionsSummary: string[]
  executionSummary: string[]
}) {
  return [
    'You are Northstar, TaskCenter’s threaded workspace agent.',
    'Speak as the in-product operating agent coordinating work, evidence, proposals, and execution.',
    'You are not a detached chatbot. Stay attached to the current company, workstream, issue, approval, or execution session whenever possible.',
    'Prefer issue-first thinking: what is the issue, why does it matter, who owns it, what evidence exists, and what should happen next.',
    'Default communication should land on the work object. Prefer issue comments, review notes, execution cards, and approvals over free-floating discussion.',
    'Durable board changes must stay confirmable in chat; do not claim they already happened unless the tool result says they did.',
    'If the request is bigger than one reply, say so and point to the staged proposal, plan, or execution card.',
    'Humans and agents can both work on the same company. Suggest the right handoff instead of assuming the AI must do everything.',
    'If a human is already working locally or in GitHub, continue from their evidence instead of resetting the work from scratch.',
    'Default to progressive disclosure: brief operating summary first, concrete next actions second, evidence or raw detail third.',
    'Prefer outputs over vibes. Point to artifacts, pending confirmations, execution sessions, review posture, and known blockers.',
    input.companyName ? `Focused company: ${input.companyName}` : 'No company is attached to this thread yet.',
    input.projectName ? `Focused project: ${input.projectName}` : 'No focused project is attached to this thread yet.',
    input.runtimeContext?.currentPage ? `Current page: ${input.runtimeContext.currentPage}` : null,
    input.runtimeContext?.currentRoute ? `Current route: ${input.runtimeContext.currentRoute}` : null,
    input.runtimeContext?.activeGoal ? `Active goal: ${input.runtimeContext.activeGoal}` : null,
    input.runtimeContext?.selectedTaskTitle
      ? `Focused issue/task: ${input.runtimeContext.selectedTaskTitle}${input.runtimeContext.selectedTaskStatus ? ` (${input.runtimeContext.selectedTaskStatus})` : ''}`
      : null,
    input.runtimeContext?.screenSummary ? `Screen context:\n${input.runtimeContext.screenSummary}` : null,
    input.runtimeContext?.conversationSummary ? `Carry-forward:\n${input.runtimeContext.conversationSummary}` : null,
    input.runtimeContext?.toolSummary ? `Available tools:\n${input.runtimeContext.toolSummary}` : null,
    input.companyInstructions?.bundles?.length
      ? `Company instruction bundles:\n${input.companyInstructions.bundles
          .map((bundle) => `## ${bundle.title}\n${bundle.markdown}`)
          .join('\n\n')}`
      : null,
    input.ragContext?.promptContext ? input.ragContext.promptContext : null,
    input.pendingActionsSummary.length ? `Staged confirmations:\n- ${input.pendingActionsSummary.join('\n- ')}` : null,
    input.executionSummary.length ? `Execution artifacts:\n- ${input.executionSummary.join('\n- ')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function listAssistantThreads(
  env: EnvBindings,
  actor: AssistantActor,
  input?: { companyId?: string; projectId?: string; limit?: number }
) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM assistant_threads
     WHERE tenant_id = ?
       AND (? IS NULL OR company_id = ?)
       AND (? IS NULL OR project_id = ?)
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(
      actor.tenantId,
      input?.companyId ?? null,
      input?.companyId ?? null,
      input?.projectId ?? null,
      input?.projectId ?? null,
      Math.min(input?.limit ?? 40, 100)
    )
    .all<AssistantThreadRow>()

  const threads: AssistantThreadRow[] = []
  for (const row of result.results) {
    if (await canViewThread(env, actor, row)) {
      threads.push(row)
    }
  }
  return { threads }
}

export async function createAssistantThread(
  env: EnvBindings,
  actor: AssistantActor,
  input: {
    title?: string
    visibility?: AssistantThreadVisibility
    companyId?: string | null
    projectId?: string | null
    shareWithUserIds?: string[]
  }
) {
  let resolvedCompanyId = input.companyId ?? null
  if (resolvedCompanyId) {
    const company = await ensureCompanyExists(env, actor.tenantId, resolvedCompanyId)
    if (!company) {
      throw new Error(`Company ${resolvedCompanyId} was not found for this workspace.`)
    }
  }
  if (input.projectId) {
    const project = await ensureProjectExists(env, actor.tenantId, input.projectId)
    if (!project) {
      throw new Error(`Project ${input.projectId} was not found for this workspace.`)
    }
    const projectCompany = await getCompanyForProject(env, actor.tenantId, input.projectId)
    if (projectCompany) {
      resolvedCompanyId = projectCompany.id
    }
  }

  const now = Date.now()
  const id = newId('ath')
  const title = compactText(input.title?.trim() || 'New Northstar thread', 80)
  const visibility = input.visibility || 'private'
  await env.DB.prepare(
    `INSERT INTO assistant_threads (
      id, tenant_id, company_id, project_id, owner_user_id, title, visibility, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`
  )
    .bind(id, actor.tenantId, resolvedCompanyId, input.projectId ?? null, actor.userId, title, visibility, now, now)
    .run()

  for (const memberId of Array.from(new Set(input.shareWithUserIds || [])).filter((value) => value && value !== actor.userId)) {
    await env.DB.prepare(
      `INSERT INTO assistant_thread_members (
        id, tenant_id, thread_id, user_id, role, added_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'editor', ?, ?, ?)`
    )
      .bind(newId('athmem'), actor.tenantId, id, memberId, actor.userId, now, now)
      .run()
      .catch(() => {})
  }

  const systemMessage = await insertAssistantMessage(env, {
    tenantId: actor.tenantId,
    threadId: id,
    role: 'system',
    content: input.projectId
      ? `Northstar thread ready for project ${input.projectId}.`
      : resolvedCompanyId
        ? `Northstar thread ready for company ${resolvedCompanyId}.`
        : 'Northstar thread ready.',
  })
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: id,
    messageId: systemMessage.id,
    order: 1,
    partType: 'system_notice',
    summary: 'Thread created',
    payload: {
      text: input.projectId
        ? `Attached to project ${input.projectId}.`
        : resolvedCompanyId
          ? `Attached to company ${resolvedCompanyId}.`
          : 'Workspace thread ready.',
    },
  })
  await touchThread(env, id, { latest_message_id: systemMessage.id, updatedAt: now })

  return getAssistantThread(env, actor, id)
}

export async function getAssistantThread(env: EnvBindings, actor: AssistantActor, threadId: string) {
  const thread = await getThreadRow(env, actor.tenantId, threadId)
  if (!thread) return null
  if (!(await canViewThread(env, actor, thread))) return null

  const members = await env.DB.prepare(
    `SELECT atm.user_id, atm.role, COALESCE(u.name, u.email, u.id) AS name, u.email
     FROM assistant_thread_members atm
     LEFT JOIN users u ON u.id = atm.user_id AND u.tenant_id = atm.tenant_id
     WHERE atm.tenant_id = ? AND atm.thread_id = ?
     ORDER BY atm.created_at ASC`
  )
    .bind(actor.tenantId, threadId)
    .all<{ user_id: string; role: string; name: string | null; email: string | null }>()

  return {
    thread: {
      id: thread.id,
      companyId: thread.company_id,
      projectId: thread.project_id,
      ownerUserId: thread.owner_user_id,
      title: thread.title,
      visibility: thread.visibility,
      status: thread.status,
      summary: thread.summary,
      currentPage: thread.current_page,
      currentRoute: thread.current_route,
      activeGoal: thread.active_goal,
      latestMessageId: thread.latest_message_id,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    },
    members: members.results.map((member) => ({
      userId: member.user_id,
      role: member.role,
      name: member.name,
      email: member.email,
    })),
  }
}

export async function getPublicAssistantThread(env: EnvBindings, threadId: string) {
  const thread = await env.DB.prepare(
    `SELECT *
     FROM assistant_threads
     WHERE id = ? AND visibility = 'public'
     LIMIT 1`
  )
    .bind(threadId)
    .first<AssistantThreadRow | null>()

  if (!thread) return null
  return {
    thread: {
      id: thread.id,
      companyId: thread.company_id,
      projectId: thread.project_id,
      ownerUserId: thread.owner_user_id,
      title: thread.title,
      visibility: thread.visibility,
      status: thread.status,
      summary: thread.summary,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    },
  }
}

export async function listAssistantMessages(env: EnvBindings, actor: AssistantActor, threadId: string) {
  const thread = await getThreadRow(env, actor.tenantId, threadId)
  if (!thread) {
    throw new Error('Thread not found.')
  }
  if (!(await canViewThread(env, actor, thread))) {
    throw new Error('Thread not found.')
  }
  return listAssistantMessagesForThread(env, thread)
}

async function listAssistantMessagesForThread(env: EnvBindings, thread: AssistantThreadRow) {
  const [messages, parts, pendingActions, sessions, events] = await Promise.all([
    env.DB.prepare(
      `SELECT *
       FROM assistant_messages
       WHERE tenant_id = ? AND thread_id = ?
       ORDER BY created_at ASC`
    )
      .bind(thread.tenant_id, thread.id)
      .all<AssistantMessageRow>(),
    env.DB.prepare(
      `SELECT *
       FROM assistant_message_parts
       WHERE tenant_id = ? AND thread_id = ?
       ORDER BY created_at ASC, part_order ASC`
    )
      .bind(thread.tenant_id, thread.id)
      .all<AssistantMessagePartRow>(),
    env.DB.prepare(
      `SELECT *
       FROM assistant_pending_actions
       WHERE tenant_id = ? AND thread_id = ?
       ORDER BY created_at DESC`
    )
      .bind(thread.tenant_id, thread.id)
      .all<AssistantPendingActionRow>(),
    env.DB.prepare(
      `SELECT *
       FROM execution_sessions
       WHERE tenant_id = ? AND thread_id = ?
       ORDER BY created_at DESC`
    )
      .bind(thread.tenant_id, thread.id)
      .all<ExecutionSessionRow>(),
    env.DB.prepare(
      `SELECT ese.*
       FROM execution_session_events ese
       JOIN execution_sessions es ON es.id = ese.session_id AND es.tenant_id = ese.tenant_id
       WHERE es.tenant_id = ? AND es.thread_id = ?
       ORDER BY ese.created_at ASC`
    )
      .bind(thread.tenant_id, thread.id)
      .all<ExecutionSessionEventRow>(),
  ])

  const pendingActionMap = new Map(
    pendingActions.results.map((row) => [
      row.id,
      {
        id: row.id,
        companyId: row.company_id,
        projectId: row.project_id,
        kind: row.kind,
        status: row.status,
        title: row.title,
        summary: row.summary,
        payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ])
  )
  const sessionMap = new Map(
    sessions.results.map((row) => [
      row.id,
      {
        id: row.id,
        companyId: row.company_id,
        projectId: row.project_id,
        itemId: row.item_id,
        proposalId: row.proposal_id,
        mode: row.mode,
        provider: row.provider,
        transport: row.transport,
        status: row.status,
        title: row.title,
        summary: row.summary,
        targetRef: row.target_ref,
        externalRunId: row.external_run_id,
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
        result: parseJson<Record<string, unknown> | null>(row.result_json, null),
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        events: events.results
          .filter((event) => event.session_id === row.id)
          .map((event) => ({
            id: event.id,
            eventType: event.event_type,
            status: event.status,
            message: event.message,
            payload: parseJson<Record<string, unknown> | null>(event.payload_json, null),
            createdAt: event.created_at,
          })),
      },
    ])
  )

  const partMap = new Map<string, Array<Record<string, unknown>>>()
  for (const row of parts.results) {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
    if (row.part_type === 'pending_action' || row.part_type === 'proposal_card') {
      const actionId = String(payload.actionId || '')
      if (actionId && pendingActionMap.has(actionId)) {
        payload.action = pendingActionMap.get(actionId)
      }
    }
    if (row.part_type === 'execution_card') {
      const sessionId = String(payload.sessionId || '')
      if (sessionId && sessionMap.has(sessionId)) {
        payload.session = sessionMap.get(sessionId)
      }
      const actionId = String(payload.actionId || '')
      if (actionId && pendingActionMap.has(actionId)) {
        payload.action = pendingActionMap.get(actionId)
      }
    }

    const list = partMap.get(row.message_id) || []
    list.push({
      id: row.id,
      type: row.part_type,
      status: row.status,
      summary: row.summary,
      payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
    partMap.set(row.message_id, list)
  }

  return {
    thread: {
      id: thread.id,
      companyId: thread.company_id,
      projectId: thread.project_id,
      title: thread.title,
      visibility: thread.visibility,
      status: thread.status,
      summary: thread.summary,
      currentPage: thread.current_page,
      currentRoute: thread.current_route,
      activeGoal: thread.active_goal,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    },
    messages: messages.results.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      model: message.model,
      status: message.status,
      createdAt: message.created_at,
      updatedAt: message.updated_at,
      parts: partMap.get(message.id) || [],
    })),
    pendingActions: Array.from(pendingActionMap.values()),
    executionSessions: Array.from(sessionMap.values()),
  }
}

async function publishThreadSnapshot(env: EnvBindings, threadId: string) {
  const thread = await env.DB.prepare(
    `SELECT *
     FROM assistant_threads
     WHERE id = ?
     LIMIT 1`
  )
    .bind(threadId)
    .first<AssistantThreadRow | null>()

  if (!thread) return
  const snapshot = await listAssistantMessagesForThread(env, thread)
  await publishAssistantThreadSnapshot(env, threadId, snapshot).catch(() => {})
}

async function publishExecutionSessionState(env: EnvBindings, sessionId: string, actor: AssistantActor) {
  const snapshot = await getExecutionSession(env, actor, sessionId)
  if (!snapshot) return
  await publishExecutionSessionSnapshot(env, sessionId, snapshot).catch(() => {})
}

export async function listPublicAssistantMessages(env: EnvBindings, threadId: string) {
  const thread = await env.DB.prepare(
    `SELECT *
     FROM assistant_threads
     WHERE id = ? AND visibility = 'public'
     LIMIT 1`
  )
    .bind(threadId)
    .first<AssistantThreadRow | null>()

  if (!thread) {
    throw new Error('Thread not found.')
  }
  return listAssistantMessagesForThread(env, thread)
}

export async function updateAssistantThread(
  env: EnvBindings,
  actor: AssistantActor,
  threadId: string,
  input: {
    title?: string
    visibility?: AssistantThreadVisibility
    shareWithUserIds?: string[]
  }
) {
  const thread = await getThreadRow(env, actor.tenantId, threadId)
  if (!thread || !(await canEditThread(env, actor, thread))) {
    throw new Error('Thread not found.')
  }

  const now = Date.now()
  await env.DB.prepare(
    `UPDATE assistant_threads
     SET title = COALESCE(?, title),
         visibility = COALESCE(?, visibility),
         updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(input.title?.trim() || null, input.visibility ?? null, now, threadId, actor.tenantId)
    .run()

  if (Array.isArray(input.shareWithUserIds)) {
    for (const memberId of Array.from(new Set(input.shareWithUserIds)).filter((value) => value && value !== actor.userId)) {
      await env.DB.prepare(
        `INSERT INTO assistant_thread_members (
          id, tenant_id, thread_id, user_id, role, added_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'editor', ?, ?, ?)`
      )
        .bind(newId('athmem'), actor.tenantId, threadId, memberId, actor.userId, now, now)
        .run()
        .catch(async () => {
          await env.DB.prepare(
            `UPDATE assistant_thread_members
             SET role = 'editor', updated_at = ?
             WHERE tenant_id = ? AND thread_id = ? AND user_id = ?`
          )
            .bind(now, actor.tenantId, threadId, memberId)
            .run()
        })
    }
  }

  await publishThreadSnapshot(env, threadId)
  return getAssistantThread(env, actor, threadId)
}

export async function attachAssistantThreadToProject(
  env: EnvBindings,
  actor: AssistantActor,
  threadId: string,
  projectId: string
) {
  const thread = await getThreadRow(env, actor.tenantId, threadId)
  if (!thread || !(await canEditThread(env, actor, thread))) {
    throw new Error('Thread not found.')
  }
  const project = await ensureProjectExists(env, actor.tenantId, projectId)
  if (!project) {
    throw new Error(`Project ${projectId} was not found for this workspace.`)
  }
  const company = await getCompanyForProject(env, actor.tenantId, projectId)

  await env.DB.prepare(
    `UPDATE assistant_threads
     SET company_id = ?, project_id = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(company?.id ?? null, projectId, Date.now(), actor.tenantId, threadId)
    .run()

  await publishThreadSnapshot(env, threadId)
  return getAssistantThread(env, actor, threadId)
}

export async function sendAssistantThreadMessage(
  env: EnvBindings,
  actor: AssistantActor,
  input: {
    threadId: string
    message: string
    context?: AssistantRuntimeContext
  }
) {
  const thread = await getThreadRow(env, actor.tenantId, input.threadId)
  if (!thread || !(await canEditThread(env, actor, thread))) {
    throw new Error('Thread not found.')
  }

  const messageText = input.message.trim()
  if (!messageText) {
    throw new Error('Message is required.')
  }

  const now = Date.now()
  const userMessage = await insertAssistantMessage(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    userId: actor.userId,
    role: 'user',
    content: messageText,
  })
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    messageId: userMessage.id,
    order: 1,
    partType: 'text',
    summary: 'User message',
    payload: { text: messageText },
  })
  await touchThread(env, thread.id, {
    status: 'streaming',
    latest_message_id: userMessage.id,
    current_page: input.context?.currentPage ?? undefined,
    current_route: input.context?.currentRoute ?? undefined,
    active_goal: input.context?.activeGoal ?? undefined,
    updatedAt: now,
  })

  const project = thread.project_id ? await ensureProjectExists(env, actor.tenantId, thread.project_id) : null
  const company = thread.company_id ? await ensureCompanyExists(env, actor.tenantId, thread.company_id) : project ? await getCompanyForProject(env, actor.tenantId, project.id) : null
  const ragContext = project
    ? await buildProjectRagContext(env, {
        tenantId: actor.tenantId,
        projectId: project.id,
        query: messageText,
        maxSnippets: 6,
      }).catch(() => null)
    : null
  const artifacts = await maybeCreateIntentArtifacts(env, actor, {
    thread,
    projectId: project?.id ?? null,
    message: messageText,
    runtimeContext: input.context,
  })
  const runtimeToolSession = await loadRuntimeToolSession(env, {
    tenantId: actor.tenantId,
    userId: actor.userId,
    projectId: project?.id ?? undefined,
    selectedConnectorKeys: input.context?.selectedConnectorKeys,
  })
  const mergedRuntimeContext = {
    ...input.context,
    selectedConnectorLabels: input.context?.selectedConnectorLabels?.length
      ? input.context.selectedConnectorLabels
      : runtimeToolSession.selectedConnectorLabels,
    toolSummary: [input.context?.toolSummary, runtimeToolSession.summaryText].filter(Boolean).join('\n\n'),
  } satisfies AssistantRuntimeContext

  const pendingActionSummaries = artifacts.partRefs
    .filter((part) => part.type === 'pending_action' || part.type === 'proposal_card')
    .map((part) => part.summary)
  const executionSummaries = artifacts.partRefs
    .filter((part) => part.type === 'execution_card')
    .map((part) => part.summary)

  const assistantPrompt = buildAssistantSystemPrompt({
    thread,
    companyName: company?.name ?? input.context?.companyName ?? null,
    projectName: project?.name ?? null,
    runtimeContext: mergedRuntimeContext,
    ragContext,
    companyInstructions: company ? await listCompanyInstructionBundles(env, actor.tenantId, company.id).catch(() => ({ bundles: [] })) : null,
    pendingActionsSummary: pendingActionSummaries,
    executionSummary: executionSummaries,
  })

  const chatTools = buildChatTools({
    env,
    actor,
    threadId: thread.id,
    projectId: project?.id ?? null,
    companyId: company?.id ?? null,
  })

  const replyResult = await generateTenantAiText(
    env,
    {
      tenantId: actor.tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? null,
    },
    {
      featureKey: 'agent.chat',
      system: assistantPrompt,
      prompt: [
        `Latest user message:\n${messageText}`,
        artifacts.partRefs.length
          ? `Typed tool artifacts already prepared:\n- ${artifacts.partRefs.map((part) => `${part.type}: ${part.summary}`).join('\n- ')}`
          : 'No typed tool artifact was necessary beyond retrieval and context grounding.',
        'You have chat tools available (searchProject, listTasks, getIssue, createTask, assignTask, createEpic, startExecution, retrieveMemory, checkIntegrations). Use them to ground claims and to stage mutations as pending proposals instead of fabricating results.',
        'Answer concisely. Mention staged confirmations or execution sessions explicitly when they exist. Do not claim a durable board change already landed unless it was executed.',
      ].join('\n\n'),
      tools: chatTools,
      maxSteps: 5,
      maxOutputTokens: computeMaxOutputTokens(messageText, detectMessageIntent(messageText), Boolean(ragContext)),
      metadata: {
        threadId: thread.id,
        projectId: project?.id ?? null,
        currentPage: input.context?.currentPage,
        currentRoute: input.context?.currentRoute,
      },
    }
  ).catch((error) => ({
    text: error instanceof Error ? error.message : 'Northstar could not complete the response.',
    usage: { inputTokens: 0, outputTokens: 0 },
    usedProvider: 'gateway',
    usedModel: 'best-free',
    requestedProvider: 'gateway',
    requestedModel: 'best-free',
    attemptedModels: [],
    warning: undefined,
  }))

  const assistantMessage = await insertAssistantMessage(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    role: 'assistant',
    content: replyResult.text,
    model: `${replyResult.usedProvider}:${replyResult.usedModel}`,
  })

  let partOrder = 1
  const reasoningText = [
    company ? `Grounded the reply in company context for ${company.name}.` : 'No company context was attached to this thread.',
    project ? `Loaded workstream context for ${project.name}.` : 'No specific workstream was attached to this turn.',
    ragContext ? `Loaded ${ragContext.snippets.length} retrieval snippets.` : 'No project retrieval bundle was available.',
    artifacts.partRefs.length ? `Prepared ${artifacts.partRefs.length} typed artifact(s) for this turn.` : 'No new proposal or execution artifact was required.',
  ].join(' ')
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    messageId: assistantMessage.id,
    order: partOrder++,
    partType: 'reasoning',
    summary: 'Northstar reasoning',
    payload: { text: reasoningText },
  })

  if (ragContext) {
    await insertAssistantMessagePart(env, {
      tenantId: actor.tenantId,
      threadId: thread.id,
      messageId: assistantMessage.id,
      order: partOrder++,
      partType: 'tool_result',
      summary: `Retrieved ${ragContext.snippets.length} context snippets`,
      payload: {
        toolName: 'project_rag',
        snippets: ragContext.snippets,
        counts: ragContext.counts,
      },
    })
  }

  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    messageId: assistantMessage.id,
    order: partOrder++,
    partType: 'tool_result',
    summary: `Loaded tool session (${runtimeToolSession.counts.ready}/${runtimeToolSession.counts.total} ready)`,
    payload: {
      toolName: 'runtime_tool_session',
      counts: runtimeToolSession.counts,
      selectedConnectorLabels: runtimeToolSession.selectedConnectorLabels,
      tools: runtimeToolSession.tools,
    },
  })

  for (const part of artifacts.partRefs) {
    await insertAssistantMessagePart(env, {
      tenantId: actor.tenantId,
      threadId: thread.id,
      messageId: assistantMessage.id,
      order: partOrder++,
      partType: part.type,
      summary: part.summary,
      payload: part.payload,
    })
  }

  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: thread.id,
    messageId: assistantMessage.id,
    order: partOrder++,
    partType: 'text',
    summary: 'Northstar reply',
    payload: { text: replyResult.text },
  })

  await touchThread(env, thread.id, {
    status: 'idle',
    summary: compactText(replyResult.text, 220),
    latest_message_id: assistantMessage.id,
    current_page: input.context?.currentPage ?? undefined,
    current_route: input.context?.currentRoute ?? undefined,
    active_goal: input.context?.activeGoal ?? undefined,
  })

  if (project) {
    await upsertProjectSearchIndex(env, {
      tenantId: actor.tenantId,
      projectId: project.id,
      extraTexts: [messageText, replyResult.text],
      }).catch(() => {})
  }

  const snapshot = await listAssistantMessages(env, actor, thread.id)
  await publishAssistantThreadSnapshot(env, thread.id, snapshot).catch(() => {})
  return snapshot
}

async function createProposalRecord(
  env: EnvBindings,
  actor: AssistantActor,
  payload: PendingActionProposalPayload
) {
  const proposalId = newId('prop')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO proposals (
      id, tenant_id, project_id, source, title, summary, status, impact_level, actions_json, diff_json,
      requested_by, created_at, updated_at
    ) VALUES (?, ?, ?, 'agent', ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      proposalId,
      actor.tenantId,
      payload.projectId,
      payload.title,
      payload.summary,
      payload.impactLevel,
      JSON.stringify(payload.actions),
      JSON.stringify({ executionMode: payload.executionMode || 'ai_assisted', assistantSource: 'northstar_v2' }),
      actor.userId,
      now,
      now
    )
    .run()

  return proposalId
}

export async function confirmAssistantPendingAction(
  env: EnvBindings,
  actor: AssistantActor,
  input: { threadId: string; actionId: string }
) {
  const thread = await getThreadRow(env, actor.tenantId, input.threadId)
  if (!thread || !(await canEditThread(env, actor, thread))) {
    throw new Error('Thread not found.')
  }
  const row = await env.DB.prepare(
    `SELECT *
     FROM assistant_pending_actions
     WHERE tenant_id = ? AND thread_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(actor.tenantId, input.threadId, input.actionId)
    .first<AssistantPendingActionRow | null>()

  if (!row || row.status !== 'pending') {
    throw new Error('Pending action not found.')
  }

  let outcomeMessage = row.summary || row.title
  let createdProposalId: string | null = null
  let createdExecutionSessionId: string | null = null
  const payload = parseJson<PendingActionProposalPayload & PendingExecutionPayload>(row.payload_json, {} as PendingActionProposalPayload & PendingExecutionPayload)

  if (row.kind === 'proposal_apply' || row.kind === 'proposal_draft') {
    createdProposalId = await createProposalRecord(env, actor, payload as PendingActionProposalPayload)
    const shouldApply = row.kind === 'proposal_apply' && canModerateRole(actor.role) && Boolean((payload as PendingActionProposalPayload).applyOnConfirm)
    if (shouldApply) {
      const proposal = await env.DB.prepare(
        `UPDATE proposals
         SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      )
        .bind(actor.userId, Date.now(), Date.now(), actor.tenantId, createdProposalId)
        .run()
      void proposal

      await applyProposalActions(env, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        projectId: (payload as PendingActionProposalPayload).projectId,
        actions: (payload as PendingActionProposalPayload).actions,
      })

      await env.DB.prepare(
        `UPDATE proposals
         SET status = 'applied', applied_by = ?, applied_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      )
        .bind(actor.userId, Date.now(), Date.now(), actor.tenantId, createdProposalId)
        .run()

      await refreshProjectMemoryDocs(env, {
        tenantId: actor.tenantId,
        projectId: (payload as PendingActionProposalPayload).projectId,
      }).catch(() => {})
      await upsertProjectSearchIndex(env, {
        tenantId: actor.tenantId,
        projectId: (payload as PendingActionProposalPayload).projectId,
        extraTexts: [(payload as PendingActionProposalPayload).title, (payload as PendingActionProposalPayload).summary],
      }).catch(() => {})
      await upsertAppMemoryEntry(env, {
        tenantId: actor.tenantId,
        projectId: (payload as PendingActionProposalPayload).projectId,
        sourceApp: 'taskcenter',
        sourceType: 'assistant_proposal',
        sourceKey: createdProposalId,
        title: (payload as PendingActionProposalPayload).title,
        content: JSON.stringify((payload as PendingActionProposalPayload).actions, null, 2),
        summary: 'Applied from Northstar chat confirmation.',
        metadata: { proposalId: createdProposalId, status: 'applied' },
      }).catch(() => {})
      outcomeMessage = `Applied proposal ${createdProposalId} from chat confirmation.`
    } else {
      outcomeMessage = `Saved draft proposal ${createdProposalId} from chat confirmation.`
    }
  } else if (row.kind === 'execution_start') {
    const execPayload = payload as PendingExecutionPayload
    createdExecutionSessionId = await createExecutionSessionRecord(env, actor, {
      companyId: row.company_id,
      projectId: execPayload.projectId,
      threadId: input.threadId,
      itemId: execPayload.itemId ?? null,
      proposalId: execPayload.proposalId ?? null,
      mode: execPayload.mode,
      provider: execPayload.provider,
      transport: execPayload.transport,
      title: execPayload.title,
      summary: execPayload.summary,
      metadata: execPayload.metadata,
    })
    outcomeMessage = `Started execution session ${createdExecutionSessionId}.`

    if (execPayload.transport === 'cloud' && createdExecutionSessionId) {
      const sessionId = createdExecutionSessionId
      import('./cloud-executor').then(({ executeCloudSession }) => {
        executeCloudSession(env, { tenantId: actor.tenantId, userId: actor.userId, sessionId }).catch(() => {})
      }).catch(() => {})
    }

    if (execPayload.itemId) {
      await env.DB.prepare(
        `UPDATE items
         SET status = 'in_progress',
             execution_mode = COALESCE(NULLIF(execution_mode, ''), 'ai_autonomous'),
             active_execution_session_id = ?,
             last_execution_session_id = ?,
             updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      )
        .bind(createdExecutionSessionId, createdExecutionSessionId, Date.now(), actor.tenantId, execPayload.itemId)
        .run()
    }
  }

  await env.DB.prepare(
    `UPDATE assistant_pending_actions
     SET status = 'executed',
         confirmed_by = ?,
         executed_at = ?,
         updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(actor.userId, Date.now(), Date.now(), actor.tenantId, row.id)
    .run()

  const assistantMessage = await insertAssistantMessage(env, {
    tenantId: actor.tenantId,
    threadId: input.threadId,
    role: 'assistant',
    content: outcomeMessage,
  })
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: input.threadId,
    messageId: assistantMessage.id,
    order: 1,
    partType: createdExecutionSessionId ? 'execution_card' : 'system_notice',
    summary: 'Confirmation applied',
    payload: {
      text: outcomeMessage,
      proposalId: createdProposalId,
      sessionId: createdExecutionSessionId,
    },
  })
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: input.threadId,
    messageId: assistantMessage.id,
    order: 2,
    partType: 'text',
    summary: 'Northstar confirmation',
    payload: { text: outcomeMessage },
  })
  await touchThread(env, input.threadId, {
    latest_message_id: assistantMessage.id,
    summary: compactText(outcomeMessage, 220),
    status: 'idle',
  })

  const snapshot = await listAssistantMessages(env, actor, input.threadId)
  await publishAssistantThreadSnapshot(env, input.threadId, snapshot).catch(() => {})
  return snapshot
}

export async function cancelAssistantPendingAction(
  env: EnvBindings,
  actor: AssistantActor,
  input: { threadId: string; actionId: string }
) {
  const thread = await getThreadRow(env, actor.tenantId, input.threadId)
  if (!thread || !(await canEditThread(env, actor, thread))) {
    throw new Error('Thread not found.')
  }
  const row = await env.DB.prepare(
    `SELECT id, title
     FROM assistant_pending_actions
     WHERE tenant_id = ? AND thread_id = ? AND id = ? AND status = 'pending'
     LIMIT 1`
  )
    .bind(actor.tenantId, input.threadId, input.actionId)
    .first<{ id: string; title: string } | null>()

  if (!row) {
    throw new Error('Pending action not found.')
  }

  await env.DB.prepare(
    `UPDATE assistant_pending_actions
     SET status = 'cancelled', cancelled_by = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(actor.userId, Date.now(), actor.tenantId, row.id)
    .run()

  const assistantMessage = await insertAssistantMessage(env, {
    tenantId: actor.tenantId,
    threadId: input.threadId,
    role: 'assistant',
    content: `Cancelled: ${row.title}.`,
  })
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: input.threadId,
    messageId: assistantMessage.id,
    order: 1,
    partType: 'system_notice',
    summary: 'Pending action cancelled',
    payload: { text: `Cancelled: ${row.title}.` },
  })
  await insertAssistantMessagePart(env, {
    tenantId: actor.tenantId,
    threadId: input.threadId,
    messageId: assistantMessage.id,
    order: 2,
    partType: 'text',
    summary: 'Northstar cancellation',
    payload: { text: `Cancelled: ${row.title}.` },
  })
  await touchThread(env, input.threadId, {
    latest_message_id: assistantMessage.id,
    summary: `Cancelled: ${row.title}.`,
    status: 'idle',
  })

  const snapshot = await listAssistantMessages(env, actor, input.threadId)
  await publishAssistantThreadSnapshot(env, input.threadId, snapshot).catch(() => {})
  return snapshot
}

export async function listExecutionSessions(
  env: EnvBindings,
  actor: AssistantActor,
  input?: { companyId?: string; projectId?: string; threadId?: string; limit?: number }
) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM execution_sessions
     WHERE tenant_id = ?
       AND (? IS NULL OR company_id = ?)
       AND (? IS NULL OR project_id = ?)
       AND (? IS NULL OR thread_id = ?)
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(
      actor.tenantId,
      input?.companyId ?? null,
      input?.companyId ?? null,
      input?.projectId ?? null,
      input?.projectId ?? null,
      input?.threadId ?? null,
      input?.threadId ?? null,
      Math.min(input?.limit ?? 40, 100)
    )
    .all<ExecutionSessionRow>()

  return {
    sessions: result.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      projectId: row.project_id,
      threadId: row.thread_id,
      itemId: row.item_id,
      proposalId: row.proposal_id,
      mode: row.mode,
      provider: row.provider,
      transport: row.transport,
      status: row.status,
      title: row.title,
      summary: row.summary,
      targetRef: row.target_ref,
      externalRunId: row.external_run_id,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      result: parseJson<Record<string, unknown> | null>(row.result_json, null),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
  }
}

export async function getExecutionSession(env: EnvBindings, actor: AssistantActor, sessionId: string) {
  const row = await env.DB.prepare(
    `SELECT *
     FROM execution_sessions
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(actor.tenantId, sessionId)
    .first<ExecutionSessionRow | null>()

  if (!row) return null
  const events = await env.DB.prepare(
    `SELECT *
     FROM execution_session_events
     WHERE tenant_id = ? AND session_id = ?
     ORDER BY created_at ASC`
  )
    .bind(actor.tenantId, sessionId)
    .all<ExecutionSessionEventRow>()

  return {
    session: {
      id: row.id,
      companyId: row.company_id,
      projectId: row.project_id,
      threadId: row.thread_id,
      itemId: row.item_id,
      proposalId: row.proposal_id,
      mode: row.mode,
      provider: row.provider,
      transport: row.transport,
      status: row.status,
      title: row.title,
      summary: row.summary,
      targetRef: row.target_ref,
      callbackSecret: row.callback_secret,
      externalRunId: row.external_run_id,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      result: parseJson<Record<string, unknown> | null>(row.result_json, null),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    },
    events: events.results.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      status: event.status,
      message: event.message,
      payload: parseJson<Record<string, unknown> | null>(event.payload_json, null),
      createdAt: event.created_at,
    })),
  }
}

export async function launchBridgeExecutionSession(env: EnvBindings, actor: AssistantActor, sessionId: string) {
  return launchBridgeExecutionSessionInternal(env, actor, { sessionId, manual: true })
}

export async function getAdminBridgeTransportSummary(env: EnvBindings, tenantId: string) {
  const config = await readBridgeTransportConfig(env, tenantId)
  const [recentSessions, recentFailures] = await Promise.all([
    env.DB.prepare(
      `SELECT id, company_id, project_id, title, status, external_run_id, updated_at
       FROM execution_sessions
       WHERE tenant_id = ? AND transport = 'bridge_cli'
       ORDER BY updated_at DESC
       LIMIT 12`
    )
      .bind(tenantId)
      .all<{ id: string; company_id: string | null; project_id: string | null; title: string; status: string; external_run_id: string | null; updated_at: number }>(),
    env.DB.prepare(
      `SELECT id, message, metadata_json, created_at
       FROM app_runtime_events
       WHERE tenant_id = ?
         AND route_key = 'execution.bridge_launch'
         AND severity = 'error'
       ORDER BY created_at DESC
       LIMIT 12`
    )
      .bind(tenantId)
      .all<{ id: string; message: string; metadata_json: string | null; created_at: number }>(),
  ])

  return {
    config: {
      status: config.status,
      summary: config.summary,
      serverUrl: config.serverUrl,
      machineId: config.machineId,
      defaultCwd: config.defaultCwd,
      repoRoots: config.repoRoots,
      autoLaunch: config.autoLaunch,
      defaultProvider: config.defaultProvider,
      updatedAt: config.updatedAt,
      hasAuthToken: Boolean(config.authToken),
    },
    recentSessions: recentSessions.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      externalRunId: row.external_run_id,
      updatedAt: row.updated_at,
    })),
    recentFailures: recentFailures.results.map((row) => ({
      id: row.id,
      message: row.message,
      metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null),
      createdAt: row.created_at,
    })),
  }
}

export async function getAdminAssistantOperationsSummary(env: EnvBindings, tenantId: string) {
  const [threadCounts, pendingCounts, totalThreads, totalSessions, totalCompanies, recentThreads, recentPendingActions, recentSessions] = await Promise.all([
    env.DB.prepare(
      `SELECT visibility, COUNT(*) AS count
       FROM assistant_threads
       WHERE tenant_id = ?
       GROUP BY visibility`
    )
      .bind(tenantId)
      .all<{ visibility: string; count: number }>(),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM assistant_pending_actions
       WHERE tenant_id = ?
       GROUP BY status`
    )
      .bind(tenantId)
      .all<{ status: string; count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM assistant_threads WHERE tenant_id = ?`).bind(tenantId).first<{ count: number } | null>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM execution_sessions WHERE tenant_id = ?`).bind(tenantId).first<{ count: number } | null>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM companies WHERE tenant_id = ?`).bind(tenantId).first<{ count: number } | null>(),
    env.DB.prepare(
      `SELECT id, title, visibility, status, company_id, project_id, updated_at
       FROM assistant_threads
       WHERE tenant_id = ?
       ORDER BY updated_at DESC
       LIMIT 12`
    )
      .bind(tenantId)
      .all<{ id: string; title: string; visibility: string; status: string; company_id: string | null; project_id: string | null; updated_at: number }>(),
    env.DB.prepare(
      `SELECT id, kind, status, title, thread_id, company_id, project_id, updated_at
       FROM assistant_pending_actions
       WHERE tenant_id = ?
       ORDER BY updated_at DESC
       LIMIT 12`
    )
      .bind(tenantId)
      .all<{ id: string; kind: string; status: string; title: string; thread_id: string; company_id: string | null; project_id: string | null; updated_at: number }>(),
    env.DB.prepare(
      `SELECT id, title, status, mode, provider, transport, company_id, project_id, updated_at
       FROM execution_sessions
       WHERE tenant_id = ?
       ORDER BY updated_at DESC
       LIMIT 20`
    )
      .bind(tenantId)
      .all<{ id: string; title: string; status: string; mode: string; provider: string; transport: string; company_id: string | null; project_id: string | null; updated_at: number }>(),
  ])

  return {
    summary: {
      totalThreads: Number(totalThreads?.count || 0),
      totalExecutionSessions: Number(totalSessions?.count || 0),
      totalCompanies: Number(totalCompanies?.count || 0),
      pendingActions: pendingCounts.results.reduce((sum, row) => sum + Number(row.count || 0), 0),
      bridgeSessions: recentSessions.results.filter((row) => row.transport === 'bridge_cli').length,
    },
    threadCounts: threadCounts.results.map((row) => ({ visibility: row.visibility, count: Number(row.count || 0) })),
    pendingCounts: pendingCounts.results.map((row) => ({ status: row.status, count: Number(row.count || 0) })),
    recentThreads: recentThreads.results.map((row) => ({
      id: row.id,
      title: row.title,
      visibility: row.visibility,
      status: row.status,
      companyId: row.company_id,
      projectId: row.project_id,
      updatedAt: row.updated_at,
    })),
    recentPendingActions: recentPendingActions.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      threadId: row.thread_id,
      companyId: row.company_id,
      projectId: row.project_id,
      updatedAt: row.updated_at,
    })),
    recentExecutionSessions: recentSessions.results.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      mode: row.mode,
      provider: row.provider,
      transport: row.transport,
      companyId: row.company_id,
      projectId: row.project_id,
      updatedAt: row.updated_at,
    })),
  }
}

export async function recordExecutionSessionCallback(
  env: EnvBindings,
  input: {
    sessionId: string
    callbackSecret: string
    status: 'queued' | 'running' | 'succeeded' | 'failed'
    externalRunId?: string
    message?: string
    logs?: string[]
    result?: Record<string, unknown>
    errorMessage?: string
  }
) {
  const row = await env.DB.prepare(
    `SELECT *
     FROM execution_sessions
     WHERE id = ?
     LIMIT 1`
  )
    .bind(input.sessionId)
    .first<ExecutionSessionRow | null>()

  if (!row || !row.callback_secret || row.callback_secret !== input.callbackSecret) {
    throw new Error('forbidden')
  }

  const now = Date.now()
  const currentMetadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
  const existingLogs = Array.isArray(currentMetadata.logs) ? (currentMetadata.logs as string[]) : []
  const mergedLogs = Array.from(new Set([...existingLogs, ...(input.logs || [])])).slice(-500)
  const duplicateStatus =
    row.status === input.status &&
    (row.external_run_id || null) === (input.externalRunId || row.external_run_id || null) &&
    (row.error_message || null) === (input.errorMessage || row.error_message || null)
  const nextMetadata = {
    ...currentMetadata,
    logs: mergedLogs,
    callbackState: {
      count: Number((currentMetadata.callbackState as { count?: number } | undefined)?.count || 0) + 1,
      lastStatus: input.status,
      lastAt: now,
    },
  }
  await env.DB.prepare(
    `UPDATE execution_sessions
     SET status = ?,
         external_run_id = COALESCE(?, external_run_id),
         metadata_json = ?,
         result_json = COALESCE(?, result_json),
         error_message = COALESCE(?, error_message),
         updated_at = ?,
         started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
         completed_at = CASE WHEN ? IN ('succeeded', 'failed') THEN ? ELSE completed_at END
     WHERE id = ?`
  )
    .bind(
      input.status,
      input.externalRunId ?? null,
      JSON.stringify(nextMetadata),
      input.result ? JSON.stringify(input.result) : null,
      input.errorMessage ?? null,
      now,
      input.status,
      now,
      input.status,
      now,
      input.sessionId
    )
    .run()

  if (!duplicateStatus || (input.logs && input.logs.length > 0)) {
    await insertExecutionEvent(env, {
      tenantId: row.tenant_id,
      sessionId: row.id,
      eventType: duplicateStatus ? `status_${input.status}_duplicate` : `status_${input.status}`,
      status: input.status,
      message: input.message || input.errorMessage || `Execution session is now ${input.status}.`,
      payload: {
        externalRunId: input.externalRunId ?? row.external_run_id,
        logs: input.logs || [],
        result: input.result || null,
        duplicate: duplicateStatus,
      },
    })
  }

  if (input.status === 'failed') {
    await recordRuntimeEvent(env, {
      tenantId: row.tenant_id,
      userId: row.initiated_by,
      projectId: row.project_id,
      routeKey: 'execution.callback',
      category: row.transport === 'bridge_cli' ? 'bridge_callback_failed' : 'execution_callback_failed',
      severity: 'error',
      message: input.errorMessage || input.message || `Execution session ${row.id} failed.`,
      metadata: { sessionId: row.id, transport: row.transport, externalRunId: input.externalRunId ?? row.external_run_id ?? null },
    }).catch(() => {})
  }

  if (row.item_id && input.status === 'succeeded') {
    const metadata = currentMetadata
    const forceReview = Boolean(metadata.collaborativeReview)
    const canAutoDone = Boolean(metadata.allowDone) && !forceReview
    await env.DB.prepare(
      `UPDATE items
       SET status = ?,
           active_execution_session_id = NULL,
           last_execution_session_id = COALESCE(last_execution_session_id, ?),
           updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    )
      .bind(canAutoDone ? 'done' : 'review', row.id, now, row.tenant_id, row.item_id)
      .run()
  } else if (row.item_id && input.status === 'failed') {
    await env.DB.prepare(
      `UPDATE items
       SET active_execution_session_id = NULL,
           last_execution_session_id = COALESCE(last_execution_session_id, ?),
           updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    )
      .bind(row.id, now, row.tenant_id, row.item_id)
      .run()
  }

  if (row.thread_id) {
    await publishThreadSnapshot(env, row.thread_id)
  }

  await publishExecutionSessionState(
    env,
    row.id,
    {
      tenantId: row.tenant_id,
      userId: row.initiated_by,
      userEmail: null,
      role: 'owner',
      userName: null,
    }
  )
  if (row.company_id) {
    await signalCompanyRuntime(env, row.company_id, {
      companyId: row.company_id,
      lastExecutionSessionId: row.id,
      lastExecutionStatus: input.status,
      lastExecutionTransport: row.transport,
      updatedAt: now,
    }).catch(() => {})
  }

  return getExecutionSession(
    env,
    {
      tenantId: row.tenant_id,
      userId: row.initiated_by,
      userEmail: null,
      role: 'owner',
      userName: null,
    },
    row.id
  )
}

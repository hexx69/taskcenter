import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { EnvBindings, RequestContext } from '../lib/context'
import { newId } from '../lib/ids'
import { listCatalogModels, maybeRefreshOpenRouterModelCatalog, refreshOpenRouterModelCatalog } from '../lib/model-catalog'
import { getUsageSnapshot, grantUsageCredits } from '../lib/usage'
import { deleteProjectRecords } from './projects'
import { encryptStoredSecret, isStoredSecretPlaceholder, maskStoredSecret } from '../lib/secrets'
import { getWorkspaceCapabilities } from '../lib/capabilities'
import { recordSecurityEvent } from '../lib/security-events'
import { getAdminAssistantOperationsSummary, getAdminBridgeTransportSummary } from '../lib/assistant'

const adminRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()
type AdminContext = Context<{ Bindings: EnvBindings; Variables: RequestContext }>

const apiKeySchema = z.object({
  id: z.string(),
  provider: z.enum(['gateway', 'openai', 'openrouter', 'gemini', 'anthropic']),
  name: z.string().min(1),
  key: z.string().min(1),
  model: z.string().min(1),
  isActive: z.boolean(),
})

const agentConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  order: z.number().int(),
  isActive: z.boolean(),
})

const settingsPayloadSchema = z.object({
  apiKeys: z.array(apiKeySchema),
  agents: z.array(agentConfigSchema),
  runtimeConfig: z.object({
    primaryProvider: z.enum(['gateway', 'openai', 'openrouter', 'gemini', 'anthropic']),
    primaryModel: z.string().min(1),
    fallbackProvider: z.enum(['gateway', 'openai', 'openrouter', 'gemini', 'anthropic']).nullable().optional(),
    fallbackModel: z.string().nullable().optional(),
  }).optional(),
})

const accountRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
})

const accountCreditGrantSchema = z.object({
  requests: z.number().int().min(0).max(100000),
  tokens: z.number().int().min(0).max(100000000),
  note: z.string().max(500).optional(),
})

const bulkAccountRoleSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(100),
  role: z.enum(['admin', 'member', 'viewer']),
})

const bulkDeleteAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(100),
})

const bulkDeleteProjectsSchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1).max(200),
})

const bridgeConfigSchema = z.object({
  status: z.enum(['active', 'pending', 'disabled']).default('active'),
  serverUrl: z.string().trim().min(1),
  machineId: z.string().trim().min(1),
  authToken: z.string().trim().min(1).or(z.literal('__configured__')).or(z.literal('')),
  defaultCwd: z.string().trim().optional(),
  autoLaunch: z.boolean().default(true),
  defaultProvider: z.enum(['codex', 'claude', 'shell']).default('codex'),
  repoRoots: z.record(z.string()).optional(),
})

async function deleteUserAccountRecords(env: EnvBindings, tenantId: string, userId: string) {
  await env.DB.prepare(`UPDATE items SET assignee_id = NULL WHERE tenant_id = ? AND assignee_id = ?`).bind(tenantId, userId).run()

  const connections = await env.DB.prepare(
    `SELECT id
     FROM service_connections
     WHERE tenant_id = ? AND user_id = ?`
  )
    .bind(tenantId, userId)
    .all<{ id: string }>()

  for (const connection of connections.results) {
    await env.DB.prepare(`DELETE FROM github_contributors WHERE tenant_id = ? AND connection_id = ?`).bind(tenantId, connection.id).run()
    await env.DB.prepare(`DELETE FROM github_commits WHERE tenant_id = ? AND connection_id = ?`).bind(tenantId, connection.id).run()
    await env.DB.prepare(`DELETE FROM github_repos WHERE tenant_id = ? AND connection_id = ?`).bind(tenantId, connection.id).run()
    await env.DB.prepare(`DELETE FROM jira_issues WHERE tenant_id = ? AND connection_id = ?`).bind(tenantId, connection.id).run()
    await env.DB.prepare(`DELETE FROM jira_projects WHERE tenant_id = ? AND connection_id = ?`).bind(tenantId, connection.id).run()
  }

  const statements = [
    'DELETE FROM project_member_assignments WHERE tenant_id = ? AND member_id = ?',
    'DELETE FROM service_connections WHERE tenant_id = ? AND user_id = ?',
    'DELETE FROM custom_connectors WHERE tenant_id = ? AND user_id = ?',
    'DELETE FROM workspace_skills WHERE tenant_id = ? AND created_by = ?',
    'DELETE FROM billing_credit_grants WHERE tenant_id = ? AND user_id = ?',
    'DELETE FROM usage_events WHERE tenant_id = ? AND user_id = ?',
    'DELETE FROM auth_sessions WHERE tenant_id = ? AND user_id = ?',
    'DELETE FROM auth_oauth_accounts WHERE user_id = ?',
    'DELETE FROM auth_credentials WHERE user_id = ?',
    'DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?',
    'DELETE FROM users WHERE tenant_id = ? AND id = ?',
  ] as const

  for (const sql of statements) {
    if (sql.includes('WHERE user_id = ?') && !sql.includes('tenant_id')) {
      await env.DB.prepare(sql).bind(userId).run()
    } else {
      await env.DB.prepare(sql).bind(tenantId, userId).run()
    }
  }
}

async function resolveIncomingAdminSecret(
  env: EnvBindings,
  inputKey: string,
  existingSecret?: string | null
) {
  const trimmed = inputKey.trim()
  if (isStoredSecretPlaceholder(trimmed)) {
    return existingSecret || null
  }
  return encryptStoredSecret(env, trimmed)
}

const LEGACY_ORCHESTRATOR_PROMPT =
  'You are TaskCenter Orchestrator. Convert messy user requests into clear execution intent. Be concrete, conservative, and brief. Identify goal, scope, constraints, assumptions, success criteria, and missing information. When details are missing, infer the safest default and label it as an assumption. Never write marketing copy. Never invent completed work.'

const LEGACY_PLANNING_ANALYST_PROMPT =
  'You are TaskCenter Planning Analyst. Turn product intent into structured requirements for a project workspace. Focus on deliverables, dependencies, roles, risks, sequencing, and acceptance criteria. Prefer structured output, explicit decisions, and medium-sized plans that a small team can actually execute.'

const LEGACY_TASK_DECOMPOSER_PROMPT =
  'You are TaskCenter Task Decomposer. Break approved work into durable epics, stories, and tasks. Use implementation-ready language, keep tasks independently actionable, and avoid vague placeholders. Every task should have a clear outcome, sensible status, and a dependency-aware order.'

const defaultAgentConfigs = [
  {
    name: 'Orchestrator',
    prompt:
      'You are TaskCenter Orchestrator. Act as the main coordinator for project planning, assignment, GitHub-aware review flow, and board-safe execution. Keep decisions grounded in retrieved project state and make the mode explicit: solo agent-build, collaborative review, or collaborative but blocked on missing GitHub access.',
    model: 'best-free',
    provider: 'gateway',
    order: 1,
    isActive: true,
  },
  {
    name: 'Planning Analyst',
    prompt:
      'You are TaskCenter Planning Analyst. Convert ambiguous requests into a grounded project brief with scope, constraints, risks, deliverables, repo signals, and collaboration signals that downstream agents can trust.',
    model: 'best-free',
    provider: 'gateway',
    order: 2,
    isActive: true,
  },
  {
    name: 'Repo Strategist',
    prompt:
      'You are TaskCenter Repo Strategist. Decide whether GitHub access is optional, required, or blocking; define the correct collaboration mode; and set the review posture for teams already shipping code.',
    model: 'best-free',
    provider: 'gateway',
    order: 3,
    isActive: true,
  },
  {
    name: 'Integration Specialist',
    prompt:
      'You are TaskCenter Integration Specialist. Decide which integrations should be connected, who owns setup, what requires admin approval, and which automation hooks are actually worth enabling.',
    model: 'best-free',
    provider: 'gateway',
    order: 4,
    isActive: true,
  },
  {
    name: 'Task Decomposer',
    prompt:
      'You are TaskCenter Task Decomposer. Break approved work into durable epics, stories, and implementation-ready tasks with explicit done criteria so the board does not become a museum of optimistic nouns.',
    model: 'fast-free',
    provider: 'gateway',
    order: 5,
    isActive: true,
  },
  {
    name: 'Assignment Router',
    prompt:
      'You are TaskCenter Assignment Router. Decide what AI should do, what humans should own, and what should use a hybrid handoff, especially when merge approval and repo review still require a person with actual skin in the game.',
    model: 'best-free',
    provider: 'gateway',
    order: 6,
    isActive: true,
  },
  {
    name: 'Code Reviewer',
    prompt:
      'You are TaskCenter Code Reviewer. Define evidence thresholds, diff-review checks, and safe rules for moving work to review or done, modeled after practical push-based review tools instead of wishful thinking.',
    model: 'reasoning-free',
    provider: 'gateway',
    order: 7,
    isActive: true,
  },
  {
    name: 'Execution Planner',
    prompt:
      'You are TaskCenter Execution Planner. Synthesize the upstream outputs into milestones, checkpoints, next actions, and recovery steps when GitHub access, review evidence, or ownership mapping is incomplete.',
    model: 'fast-free',
    provider: 'gateway',
    order: 8,
    isActive: true,
  },
] as const

// Query schema for logs
const logsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  userEmail: z.string().optional(),
  agentName: z.string().optional(),
  actionType: z.string().optional(),
  projectId: z.string().optional(),
  status: z.enum(['success', 'error', 'pending']).optional(),
  limit: z.string().default('50'),
  offset: z.string().default('0'),
})

// Helper to check if user is admin
function isAdminUser(email: string | null, role: RequestContext['role'], env: EnvBindings): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (!email) return false
  const adminEmails = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return adminEmails.includes(email.toLowerCase())
}

function requireAdminAccess(c: AdminContext) {
  const currentUserEmail = c.get('userEmail')
  const role = c.get('role')
  return isAdminUser(currentUserEmail, role, c.env)
}

async function ensureDefaultAgentConfigs(c: AdminContext) {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const existing = await c.env.DB.prepare(
    `SELECT id, name, prompt, provider, model
     FROM admin_agent_configs
     WHERE tenant_id = ?
     ORDER BY sort_order ASC`
  )
    .bind(tenantId)
    .all<{ id: string; name: string; prompt: string; provider: string; model: string }>()

  if (existing.results.length > 0) {
    const looksLegacyDefault =
      existing.results.length === 3 &&
      existing.results.every((row, index) => row.name === ['Orchestrator', 'Planning Analyst', 'Task Decomposer'][index]) &&
      existing.results.every((row) => row.provider === 'openai' && row.model === 'gpt-4')

    const looksOpenRouterPlaceholderDefault =
      existing.results.length === 3 &&
      existing.results.every((row, index) => row.name === ['Orchestrator', 'Planning Analyst', 'Task Decomposer'][index]) &&
      existing.results.every((row, index) => row.provider === 'openrouter' && row.model === ['best-free', 'reasoning-free', 'fast-free'][index])

    const looksGatewayPlaceholderDefault =
      existing.results.length === 3 &&
      existing.results.every((row, index) => row.name === ['Orchestrator', 'Planning Analyst', 'Task Decomposer'][index]) &&
      existing.results.every((row, index) => row.provider === ['gateway', 'gateway', 'gateway'][index] && row.model === ['best-free', 'best-free', 'fast-free'][index]) &&
      existing.results.every((row) =>
        row.name === 'Orchestrator'
          ? row.prompt === 'You are the orchestrator agent...'
          : row.name === 'Planning Analyst'
            ? row.prompt === 'You analyze project requirements...'
            : row.name === 'Task Decomposer'
              ? row.prompt === 'You break down epics into tasks...'
              : false
      )

    const looksGatewayLegacyDefault =
      existing.results.length === 3 &&
      existing.results.every((row, index) => row.name === ['Orchestrator', 'Planning Analyst', 'Task Decomposer'][index]) &&
      existing.results.every((row, index) => row.provider === ['gateway', 'gateway', 'gateway'][index] && row.model === ['best-free', 'best-free', 'fast-free'][index]) &&
      existing.results.every((row) =>
        row.name === 'Orchestrator'
          ? row.prompt === LEGACY_ORCHESTRATOR_PROMPT
          : row.name === 'Planning Analyst'
            ? row.prompt === LEGACY_PLANNING_ANALYST_PROMPT
            : row.name === 'Task Decomposer'
              ? row.prompt === LEGACY_TASK_DECOMPOSER_PROMPT
              : false
      )

    const looksSevenAgentDefault =
      existing.results.length === 7 &&
      existing.results.every((row, index) => row.name === ['Orchestrator', 'Planning Analyst', 'Repo Strategist', 'Task Decomposer', 'Assignment Router', 'Code Reviewer', 'Execution Planner'][index])

    if (!looksLegacyDefault && !looksOpenRouterPlaceholderDefault && !looksGatewayPlaceholderDefault && !looksGatewayLegacyDefault && !looksSevenAgentDefault) return

    await c.env.DB.prepare(`DELETE FROM admin_agent_configs WHERE tenant_id = ?`).bind(tenantId).run()
  }

  const now = Date.now()
  for (const agent of defaultAgentConfigs) {
    await c.env.DB.prepare(
      `INSERT INTO admin_agent_configs (
        id, tenant_id, name, prompt, model, provider, sort_order, is_active, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(newId('agentcfg'), tenantId, agent.name, agent.prompt, agent.model, agent.provider, agent.order, agent.isActive ? 1 : 0, userId, now, now)
      .run()
  }
}

async function ensureDefaultRuntimeConfig(c: AdminContext) {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const existing = await c.env.DB.prepare(
    `SELECT tenant_id, primary_provider, primary_model, fallback_provider, fallback_model
     FROM admin_runtime_config
     WHERE tenant_id = ?
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{
      tenant_id: string
      primary_provider: string
      primary_model: string
      fallback_provider: string | null
      fallback_model: string | null
    } | null>()

  if (existing) {
    const looksLikeLegacyOpenRouterRuntime =
      existing.primary_provider === 'openrouter' &&
      existing.primary_model === 'best-free' &&
      (existing.fallback_provider === 'openrouter' || existing.fallback_provider === null) &&
      (!existing.fallback_model || existing.fallback_model === 'fast-free')

    if (!looksLikeLegacyOpenRouterRuntime) return

    await c.env.DB.prepare(
      `UPDATE admin_runtime_config
       SET primary_provider = 'gateway',
           primary_model = 'best-free',
           fallback_provider = 'gateway',
           fallback_model = 'fast-free',
           updated_by = ?,
           updated_at = ?
       WHERE tenant_id = ?`
    )
      .bind(userId, Date.now(), tenantId)
      .run()
    return
  }

  await c.env.DB.prepare(
    `INSERT INTO admin_runtime_config (
      tenant_id, primary_provider, primary_model, fallback_provider, fallback_model, updated_by, updated_at
    ) VALUES (?, 'gateway', 'best-free', 'gateway', 'fast-free', ?, ?)`
  )
    .bind(tenantId, userId, Date.now())
    .run()
}

adminRoute.get('/settings', async (c) => {
  const tenantId = c.get('tenantId')

  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  await ensureDefaultAgentConfigs(c)
  await ensureDefaultRuntimeConfig(c)
  await maybeRefreshOpenRouterModelCatalog(c.env).catch(() => {})

  const apiKeysResult = await c.env.DB.prepare(
    `SELECT id, provider, name, secret, model, is_active
     FROM admin_api_keys
     WHERE tenant_id = ?
     ORDER BY updated_at DESC, created_at DESC`
  )
    .bind(tenantId)
    .all<{ id: string; provider: 'gateway' | 'openai' | 'openrouter' | 'gemini' | 'anthropic'; name: string; secret: string; model: string; is_active: number }>()

  const agentsResult = await c.env.DB.prepare(
    `SELECT id, name, prompt, model, provider, sort_order, is_active
     FROM admin_agent_configs
     WHERE tenant_id = ?
     ORDER BY sort_order ASC, updated_at DESC`
  )
    .bind(tenantId)
    .all<{ id: string; name: string; prompt: string; model: string; provider: string; sort_order: number; is_active: number }>()

  const catalog = await listCatalogModels(c.env).catch(() => ({ updatedAt: null, models: [] }))
  const runtimeConfig = await c.env.DB.prepare(
    `SELECT primary_provider, primary_model, fallback_provider, fallback_model
     FROM admin_runtime_config
     WHERE tenant_id = ?
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ primary_provider: string; primary_model: string; fallback_provider: string | null; fallback_model: string | null } | null>()

  return c.json({
    apiKeys: apiKeysResult.results.map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      key: maskStoredSecret(row.secret),
      model: row.model,
      isActive: Boolean(row.is_active),
      hasStoredKey: Boolean(row.secret),
    })),
    agents: agentsResult.results.map((row) => ({
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      model: row.model,
      provider: row.provider,
      order: row.sort_order,
      isActive: Boolean(row.is_active),
    })),
    runtimeConfig: runtimeConfig
      ? {
          primaryProvider: runtimeConfig.primary_provider,
          primaryModel: runtimeConfig.primary_model,
          fallbackProvider: runtimeConfig.fallback_provider,
          fallbackModel: runtimeConfig.fallback_model,
        }
      : null,
    modelCatalog: catalog,
  })
})

adminRoute.get('/model-catalog', async (c) => {
  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  await maybeRefreshOpenRouterModelCatalog(c.env).catch(() => {})
  const catalog = await listCatalogModels(c.env)
  return c.json(catalog)
})

adminRoute.post('/model-catalog/refresh', async (c) => {
  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const result = await refreshOpenRouterModelCatalog(c.env)
  const catalog = await listCatalogModels(c.env)
  return c.json({ refreshed: true, ...catalog, count: result.count, updatedAt: result.updatedAt })
})

adminRoute.put('/settings', zValidator('json', settingsPayloadSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const payload = c.req.valid('json')

  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  await ensureDefaultAgentConfigs(c)
  await ensureDefaultRuntimeConfig(c)

  const existingApiKeys = await c.env.DB.prepare(
    `SELECT id, secret
     FROM admin_api_keys
     WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .all<{ id: string; secret: string }>()
  const existingApiKeyById = new Map(existingApiKeys.results.map((row) => [row.id, row.secret]))

  await c.env.DB.prepare(`DELETE FROM admin_api_keys WHERE tenant_id = ?`).bind(tenantId).run()
  await c.env.DB.prepare(`DELETE FROM admin_agent_configs WHERE tenant_id = ?`).bind(tenantId).run()

  const now = Date.now()

  for (const key of payload.apiKeys) {
    const storedSecret = await resolveIncomingAdminSecret(c.env, key.key, existingApiKeyById.get(key.id))
    if (!storedSecret) {
      continue
    }

    await c.env.DB.prepare(
      `INSERT INTO admin_api_keys (
        id, tenant_id, provider, name, secret, model, is_active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(key.id || newId('akey'), tenantId, key.provider, key.name, storedSecret, key.model, key.isActive ? 1 : 0, userId, now, now)
      .run()
  }

  for (const agent of payload.agents) {
    await c.env.DB.prepare(
      `INSERT INTO admin_agent_configs (
        id, tenant_id, name, prompt, model, provider, sort_order, is_active, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(agent.id || newId('agentcfg'), tenantId, agent.name, agent.prompt, agent.model, agent.provider, agent.order, agent.isActive ? 1 : 0, userId, now, now)
      .run()
  }

  const runtimeConfig = payload.runtimeConfig || {
    primaryProvider: 'gateway',
    primaryModel: 'best-free',
    fallbackProvider: 'gateway',
    fallbackModel: 'fast-free',
  }

  await c.env.DB.prepare(`DELETE FROM admin_runtime_config WHERE tenant_id = ?`).bind(tenantId).run()
  await c.env.DB.prepare(
    `INSERT INTO admin_runtime_config (
      tenant_id, primary_provider, primary_model, fallback_provider, fallback_model, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tenantId,
      runtimeConfig.primaryProvider,
      runtimeConfig.primaryModel,
      runtimeConfig.fallbackProvider || null,
      runtimeConfig.fallbackModel || null,
      userId,
      now
    )
    .run()

  return c.json({ ok: true })
})

adminRoute.get('/bridge/config', async (c) => {
  const tenantId = c.get('tenantId')
  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const row = await c.env.DB.prepare(
    `SELECT status, summary, config_json, updated_at
     FROM admin_integration_configs
     WHERE tenant_id = ? AND integration_key = 'bridge_cli'
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ status: string; summary: string | null; config_json: string | null; updated_at: number | null } | null>()

  const parsed = row?.config_json ? JSON.parse(row.config_json) as Record<string, unknown> : {}
  return c.json({
    config: {
      status: row?.status || 'missing',
      summary: row?.summary || null,
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
      machineId: typeof parsed.machineId === 'string' ? parsed.machineId : '',
      authToken: maskStoredSecret(typeof parsed.authToken === 'string' ? parsed.authToken : null),
      defaultCwd: typeof parsed.defaultCwd === 'string' ? parsed.defaultCwd : '',
      autoLaunch: parsed.autoLaunch === false ? false : true,
      defaultProvider: parsed.defaultProvider === 'claude' || parsed.defaultProvider === 'shell' || parsed.defaultProvider === 'codex' ? parsed.defaultProvider : 'codex',
      repoRoots: typeof parsed.repoRoots === 'object' && parsed.repoRoots ? parsed.repoRoots : {},
      updatedAt: row?.updated_at || null,
    },
  })
})

adminRoute.put('/bridge/config', zValidator('json', bridgeConfigSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const payload = c.req.valid('json')
  const existing = await c.env.DB.prepare(
    `SELECT id, config_json
     FROM admin_integration_configs
     WHERE tenant_id = ? AND integration_key = 'bridge_cli'
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ id: string; config_json: string | null } | null>()
  const existingConfig = existing?.config_json ? JSON.parse(existing.config_json) as Record<string, unknown> : {}
  const nextAuthToken = payload.authToken && !isStoredSecretPlaceholder(payload.authToken)
    ? await encryptStoredSecret(c.env, payload.authToken)
    : typeof existingConfig.authToken === 'string'
      ? existingConfig.authToken
      : null

  const configJson = JSON.stringify({
    serverUrl: payload.serverUrl,
    machineId: payload.machineId,
    authToken: nextAuthToken,
    defaultCwd: payload.defaultCwd?.trim() || '',
    autoLaunch: payload.autoLaunch,
    defaultProvider: payload.defaultProvider,
    repoRoots: payload.repoRoots || {},
  })
  const now = Date.now()
  const summary = `${payload.machineId} · ${payload.serverUrl}${payload.defaultCwd ? ` · ${payload.defaultCwd}` : ''}`

  await c.env.DB.prepare(
    `INSERT INTO admin_integration_configs (
      id, tenant_id, integration_key, status, summary, config_json, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'bridge_cli', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, integration_key)
    DO UPDATE SET
      status = excluded.status,
      summary = excluded.summary,
      config_json = excluded.config_json,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`
  )
    .bind(existing?.id || newId('aicfg'), tenantId, payload.status, summary, configJson, userId, now, now)
    .run()

  return c.json({ ok: true, summary })
})

adminRoute.get('/assistant/operations', async (c) => {
  const tenantId = c.get('tenantId')
  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const [assistantOps, bridgeTransport] = await Promise.all([
    getAdminAssistantOperationsSummary(c.env, tenantId),
    getAdminBridgeTransportSummary(c.env, tenantId),
  ])

  return c.json({
    assistant: assistantOps,
    bridge: bridgeTransport,
  })
})

adminRoute.get('/observability/errors', async (c) => {
  const tenantId = c.get('tenantId')

  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const [recentErrors, errorCounts, debugSessions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, project_id, route_key, category, message, metadata_json, created_at
       FROM app_runtime_events
       WHERE tenant_id = ? AND severity = 'error'
       ORDER BY created_at DESC
       LIMIT 100`
    )
      .bind(tenantId)
      .all<{
        id: string
        project_id: string | null
        route_key: string
        category: string
        message: string
        metadata_json: string | null
        created_at: number
      }>(),
    c.env.DB.prepare(
      `SELECT category, COUNT(*) AS count
       FROM app_runtime_events
       WHERE tenant_id = ? AND severity = 'error'
       GROUP BY category
       ORDER BY count DESC, category ASC`
    )
      .bind(tenantId)
      .all<{ category: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT id, project_id, mode, status, summary, updated_at
       FROM debug_sessions
       WHERE tenant_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`
    )
      .bind(tenantId)
      .all<{
        id: string
        project_id: string
        mode: string
        status: string
        summary: string
        updated_at: number
      }>(),
  ])

  return c.json({
    recentErrors: recentErrors.results.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      routeKey: row.route_key,
      category: row.category,
      message: row.message,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      createdAt: row.created_at,
    })),
    categoryCounts: errorCounts.results.map((row) => ({
      category: row.category,
      count: row.count,
    })),
    debugSessions: debugSessions.results.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      mode: row.mode,
      status: row.status,
      summary: row.summary,
      updatedAt: row.updated_at,
    })),
  })
})

adminRoute.get('/billing/reconciliation', async (c) => {
  const tenantId = c.get('tenantId')

  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const capabilities = await getWorkspaceCapabilities(c.env, { tenantId })
  const [subscriptions, customers, grantsBySource, recentWebhookErrors] = await Promise.all([
    c.env.DB.prepare(
      `SELECT tenant_id, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id, plan_key, status, current_period_end, cancel_at_period_end, updated_at
       FROM billing_subscriptions
       WHERE tenant_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 100`
    )
      .bind(tenantId)
      .all<{
        tenant_id: string
        stripe_customer_id: string | null
        stripe_subscription_id: string
        stripe_checkout_session_id: string | null
        plan_key: string
        status: string
        current_period_end: number | null
        cancel_at_period_end: number
        updated_at: number
      }>(),
    c.env.DB.prepare(
      `SELECT tenant_id, stripe_customer_id, email, updated_at
       FROM billing_customers
       WHERE tenant_id = ?
       ORDER BY updated_at DESC
       LIMIT 100`
    )
      .bind(tenantId)
      .all<{
        tenant_id: string
        stripe_customer_id: string
        email: string | null
        updated_at: number
      }>(),
    c.env.DB.prepare(
      `SELECT source_type, COUNT(*) AS grant_count, COALESCE(SUM(requests_granted), 0) AS requests_granted, COALESCE(SUM(tokens_granted), 0) AS tokens_granted
       FROM billing_credit_grants
       WHERE tenant_id = ?
       GROUP BY source_type
       ORDER BY grant_count DESC, source_type ASC`
    )
      .bind(tenantId)
      .all<{
        source_type: string
        grant_count: number
        requests_granted: number
        tokens_granted: number
      }>(),
    c.env.DB.prepare(
      `SELECT id, category, message, metadata_json, created_at
       FROM app_runtime_events
       WHERE tenant_id = ?
         AND route_key = 'billing.webhook'
         AND severity IN ('warning', 'error')
       ORDER BY created_at DESC
       LIMIT 20`
    )
      .bind(tenantId)
      .all<{
        id: string
        category: string
        message: string
        metadata_json: string | null
        created_at: number
      }>(),
  ])

  const customerIds = new Set(customers.results.map((row) => row.stripe_customer_id))
  const subscriptionsByCustomer = new Map<string, number>()
  for (const row of subscriptions.results) {
    if (row.stripe_customer_id) {
      subscriptionsByCustomer.set(row.stripe_customer_id, (subscriptionsByCustomer.get(row.stripe_customer_id) || 0) + 1)
    }
  }

  const subscriptionsMissingCustomer = subscriptions.results.filter((row) => !row.stripe_customer_id)
  const subscriptionsWithUnknownCustomer = subscriptions.results.filter(
    (row) => row.stripe_customer_id && !customerIds.has(row.stripe_customer_id)
  )
  const customersWithoutSubscription = customers.results.filter(
    (row) => !subscriptionsByCustomer.has(row.stripe_customer_id)
  )

  return c.json({
    capabilities,
    summary: {
      billingReady: capabilities.billingReady,
      customers: customers.results.length,
      subscriptions: subscriptions.results.length,
      activeSubscriptions: subscriptions.results.filter((row) => row.status === 'active').length,
      recentWebhookErrors: recentWebhookErrors.results.length,
    },
    drift: {
      subscriptionsMissingCustomer: subscriptionsMissingCustomer.length,
      subscriptionsWithUnknownCustomer: subscriptionsWithUnknownCustomer.length,
      customersWithoutSubscription: customersWithoutSubscription.length,
    },
    subscriptions: subscriptions.results.map((row) => ({
      tenantId: row.tenant_id,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      stripeCheckoutSessionId: row.stripe_checkout_session_id,
      planKey: row.plan_key,
      status: row.status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      updatedAt: row.updated_at,
    })),
    customers: customers.results.map((row) => ({
      tenantId: row.tenant_id,
      stripeCustomerId: row.stripe_customer_id,
      email: row.email,
      updatedAt: row.updated_at,
    })),
    creditGrantsBySource: grantsBySource.results.map((row) => ({
      sourceType: row.source_type,
      grantCount: row.grant_count,
      requestsGranted: row.requests_granted,
      tokensGranted: row.tokens_granted,
    })),
    recentWebhookErrors: recentWebhookErrors.results.map((row) => ({
      id: row.id,
      category: row.category,
      message: row.message,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      createdAt: row.created_at,
    })),
  })
})

adminRoute.get('/integrations/health', async (c) => {
  const tenantId = c.get('tenantId')

  if (!requireAdminAccess(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const capabilities = await getWorkspaceCapabilities(c.env, { tenantId })
  const [serviceRows, githubLinkCounts, adminConfigs, customConnectors, recentErrors] = await Promise.all([
    c.env.DB.prepare(
      `SELECT service_type, COUNT(*) AS total_connections, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_connections,
              COUNT(DISTINCT user_id) AS connected_accounts, MAX(updated_at) AS last_updated_at
       FROM service_connections
       WHERE tenant_id = ?
       GROUP BY service_type
       ORDER BY active_connections DESC, service_type ASC`
    )
      .bind(tenantId)
      .all<{
        service_type: string
        total_connections: number
        active_connections: number
        connected_accounts: number
        last_updated_at: string | null
      }>(),
    c.env.DB.prepare(
      `SELECT sc.service_type, COUNT(*) AS linked_projects
       FROM project_github_links pgl
       JOIN service_connections sc ON sc.id = pgl.connection_id
       WHERE pgl.tenant_id = ?
       GROUP BY sc.service_type`
    )
      .bind(tenantId)
      .all<{ service_type: string; linked_projects: number }>(),
    c.env.DB.prepare(
      `SELECT integration_key, status, summary, updated_at
       FROM admin_integration_configs
       WHERE tenant_id = ?
       ORDER BY updated_at DESC`
    )
      .bind(tenantId)
      .all<{
        integration_key: string
        status: string
        summary: string | null
        updated_at: number
      }>(),
    c.env.DB.prepare(
      `SELECT id, connector_type, name, slug, status, access_scope, transport, auth_mode, endpoint_url, command, updated_at
       FROM custom_connectors
       WHERE tenant_id = ?
       ORDER BY updated_at DESC`
    )
      .bind(tenantId)
      .all<{
        id: string
        connector_type: string
        name: string
        slug: string
        status: string
        access_scope: string
        transport: string | null
        auth_mode: string
        endpoint_url: string | null
        command: string | null
        updated_at: number
      }>(),
    c.env.DB.prepare(
      `SELECT category, COUNT(*) AS error_count
       FROM app_runtime_events
       WHERE tenant_id = ?
         AND severity = 'error'
         AND (category LIKE 'integration%' OR route_key LIKE 'integrations.%')
       GROUP BY category
       ORDER BY error_count DESC, category ASC`
    )
      .bind(tenantId)
      .all<{ category: string; error_count: number }>(),
  ])

  const linkedProjectByService = new Map(githubLinkCounts.results.map((row) => [row.service_type, row.linked_projects]))

  return c.json({
    capabilities,
    summary: {
      integrationHealthReady: capabilities.integrationHealthReady,
      activeConnections: serviceRows.results.reduce((sum, row) => sum + (row.active_connections || 0), 0),
      adminConfigs: adminConfigs.results.length,
      customConnectors: customConnectors.results.length,
      linkedProjects: githubLinkCounts.results.reduce((sum, row) => sum + row.linked_projects, 0),
    },
    services: serviceRows.results.map((row) => ({
      serviceType: row.service_type,
      totalConnections: row.total_connections,
      activeConnections: row.active_connections || 0,
      connectedAccounts: row.connected_accounts,
      linkedProjects: linkedProjectByService.get(row.service_type) || 0,
      lastUpdatedAt: row.last_updated_at,
    })),
    adminConfigs: adminConfigs.results.map((row) => ({
      integrationKey: row.integration_key,
      status: row.status,
      summary: row.summary,
      updatedAt: row.updated_at,
    })),
    customConnectors: customConnectors.results.map((row) => ({
      id: row.id,
      connectorType: row.connector_type,
      name: row.name,
      slug: row.slug,
      status: row.status,
      accessScope: row.access_scope,
      transport: row.transport,
      authMode: row.auth_mode,
      endpointUrl: row.endpoint_url,
      command: row.command,
      updatedAt: row.updated_at,
    })),
    recentErrorCategories: recentErrors.results.map((row) => ({
      category: row.category,
      count: row.error_count,
    })),
  })
})

adminRoute.get('/accounts', async (c) => {
  const tenantId = c.get('tenantId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const usersResult = await c.env.DB.prepare(
    `SELECT
       u.id,
       u.email,
       u.name,
       u.created_at,
       COALESCE(m.role, 'member') AS role,
       MAX(s.last_seen_at) AS last_active
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
     LEFT JOIN auth_sessions s ON s.user_id = u.id AND s.tenant_id = u.tenant_id
     WHERE u.tenant_id = ?
     GROUP BY u.id, u.email, u.name, u.created_at, m.role
     ORDER BY u.created_at DESC`
  )
    .bind(tenantId)
    .all<{
      id: string
      email: string | null
      name: string | null
      created_at: number
      role: 'owner' | 'admin' | 'member' | 'viewer'
      last_active: number | null
    }>()

  const projectRows = await c.env.DB.prepare(
    `SELECT
       p.id,
       p.name,
       p.description,
       p.created_by,
       p.created_at,
       p.updated_at
     FROM projects p
     WHERE p.tenant_id = ?
     ORDER BY p.updated_at DESC, p.created_at DESC`
  )
    .bind(tenantId)
    .all<{
      id: string
      name: string
      description: string | null
      created_by: string
      created_at: number
      updated_at: number
    }>()

  const visibleProjects = projectRows.results.map((project) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }))

  const roleRank: Record<'owner' | 'admin' | 'member' | 'viewer', number> = {
    owner: 4,
    admin: 3,
    member: 2,
    viewer: 1,
  }

  const dedupedAccounts = new Map<string, {
    id: string
    email: string | null
    name: string | null
    role: 'owner' | 'admin' | 'member' | 'viewer'
    createdAt: number
    lastActive: number | null
    projects: Array<{
      id: string
      name: string
      description: string | null
      createdAt: number
      updatedAt: number
    }>
  }>()

  for (const row of usersResult.results) {
    const key = row.email?.trim().toLowerCase() || row.id
    const nextProjects = visibleProjects
    const existing = dedupedAccounts.get(key)

    if (!existing) {
      dedupedAccounts.set(key, {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        createdAt: row.created_at,
        lastActive: row.last_active,
        projects: nextProjects,
      })
      continue
    }

    const preferred =
      roleRank[row.role] > roleRank[existing.role] ||
      ((row.last_active || 0) > (existing.lastActive || 0))
        ? {
            id: row.id,
            email: row.email || existing.email,
            name: row.name || existing.name,
            role: row.role,
            createdAt: Math.min(row.created_at, existing.createdAt),
            lastActive: Math.max(row.last_active || 0, existing.lastActive || 0) || null,
            projects: existing.projects,
          }
        : existing

    const mergedProjects = new Map<string, (typeof nextProjects)[number]>()
    for (const project of [...existing.projects, ...nextProjects]) {
      mergedProjects.set(project.id, project)
    }

    dedupedAccounts.set(key, {
      ...preferred,
      projects: Array.from(mergedProjects.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    })
  }

  return c.json({
    accounts: Array.from(dedupedAccounts.values()).sort((a, b) => {
      const roleDelta = roleRank[b.role] - roleRank[a.role]
      if (roleDelta !== 0) return roleDelta
      return (b.lastActive || b.createdAt) - (a.lastActive || a.createdAt)
    }),
  })
})

adminRoute.get('/accounts/:accountId/detail', async (c) => {
  const tenantId = c.get('tenantId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  const accountId = c.req.param('accountId')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const account = await c.env.DB.prepare(
    `SELECT
       u.id,
       u.email,
       u.name,
       u.created_at,
       COALESCE(m.role, 'member') AS role,
       MAX(s.last_seen_at) AS last_active
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
     LEFT JOIN auth_sessions s ON s.user_id = u.id AND s.tenant_id = u.tenant_id
     WHERE u.tenant_id = ? AND u.id = ?
     GROUP BY u.id, u.email, u.name, u.created_at, m.role
     LIMIT 1`
  )
    .bind(tenantId, accountId)
    .first<{
      id: string
      email: string | null
      name: string | null
      created_at: number
      role: 'owner' | 'admin' | 'member' | 'viewer'
      last_active: number | null
    } | null>()

  if (!account) {
    return c.json({ error: 'account_not_found' }, 404)
  }

  const projectsResult = await c.env.DB.prepare(
    `SELECT id, name, description, created_at, updated_at
     FROM projects
     WHERE tenant_id = ?
     ORDER BY updated_at DESC, created_at DESC`
  )
    .bind(tenantId)
    .all<{ id: string; name: string; description: string | null; created_at: number; updated_at: number }>()

  const logsResult = await c.env.DB.prepare(
    `SELECT
       id, created_at, user_email, action_type, agent_name, project_name,
       status, tokens_used, model_name, response_time_ms, error_message
     FROM agent_action_logs
     WHERE tenant_id = ? AND (user_id = ? OR (? IS NOT NULL AND user_email = ?))
     ORDER BY created_at DESC
     LIMIT 12`
  )
    .bind(tenantId, accountId, account.email, account.email)
    .all<{
      id: string
      created_at: string
      user_email: string
      action_type: string
      agent_name: string
      project_name: string | null
      status: 'success' | 'error' | 'pending'
      tokens_used: number
      model_name: string | null
      response_time_ms: number | null
      error_message: string | null
    }>()

  const runsResult = await c.env.DB.prepare(
    `SELECT id, project_id, root_prompt, status, created_at, updated_at
     FROM agent_runs
     WHERE tenant_id = ? AND requested_by = ?
     ORDER BY created_at DESC
     LIMIT 8`
  )
    .bind(tenantId, accountId)
    .all<{ id: string; project_id: string; root_prompt: string; status: string; created_at: number; updated_at: number }>()

  const usageTotals = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS events,
       COALESCE(SUM(request_count), 0) AS requests,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM usage_events
     WHERE tenant_id = ? AND user_id = ?`
  )
    .bind(tenantId, accountId)
    .first<{ events: number; requests: number; input_tokens: number; output_tokens: number } | null>()

  const featureBreakdown = await c.env.DB.prepare(
    `SELECT feature_key, COUNT(*) AS events, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM usage_events
     WHERE tenant_id = ? AND user_id = ?
     GROUP BY feature_key
     ORDER BY tokens DESC, events DESC
     LIMIT 6`
  )
    .bind(tenantId, accountId)
    .all<{ feature_key: string; events: number; tokens: number }>()

  const subscription = await c.env.DB.prepare(
    `SELECT plan_key, status, current_period_end, cancel_at_period_end
     FROM billing_subscriptions
     WHERE tenant_id = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ plan_key: string; status: string; current_period_end: number | null; cancel_at_period_end: number } | null>()

  const accountUsage = await getUsageSnapshot(c.env, tenantId, accountId)

  return c.json({
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role,
      createdAt: account.created_at,
      lastActive: account.last_active,
      projects: projectsResult.results.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      })),
      recentLogs: logsResult.results,
      recentRuns: runsResult.results,
      usage: {
        events: usageTotals?.events ?? 0,
        requests: usageTotals?.requests ?? 0,
        tokens: (usageTotals?.input_tokens ?? 0) + (usageTotals?.output_tokens ?? 0),
        features: featureBreakdown.results.map((row) => ({
          featureKey: row.feature_key,
          events: row.events,
          tokens: row.tokens,
        })),
      },
      billing: {
        planKey: subscription?.plan_key || accountUsage.planKey,
        status: subscription?.status || 'inactive',
        currentPeriodEnd: subscription?.current_period_end ?? null,
        cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
        limits: accountUsage.limits,
        baseLimits: accountUsage.baseLimits,
        creditGrants: accountUsage.creditGrants,
        remainingRequests: accountUsage.remainingRequests,
        remainingTokens: accountUsage.remainingTokens,
      },
    },
  })
})

adminRoute.post('/accounts/:accountId/credits', zValidator('json', accountCreditGrantSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserId = c.get('userId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  const accountId = c.req.param('accountId')
  const payload = c.req.valid('json')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const account = await c.env.DB.prepare(
    `SELECT id
     FROM users
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, accountId)
    .first<{ id: string } | null>()

  if (!account) {
    return c.json({ error: 'account_not_found' }, 404)
  }

  if (payload.requests === 0 && payload.tokens === 0) {
    return c.json({ error: 'invalid_credit_amount', message: 'Add at least one request or token credit.' }, 400)
  }

  const grant = await grantUsageCredits(c.env, {
    tenantId,
    userId: accountId,
    sourceType: 'admin_grant',
    requestsGranted: payload.requests,
    tokensGranted: payload.tokens,
    note: payload.note ?? 'Manual admin grant',
    createdBy: currentUserId,
  })

  await c.env.DB.prepare(
    `INSERT INTO agent_action_logs (
      tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tenantId,
      currentUserId,
      userEmail || currentUserId,
      'admin.credit_grant',
      'admin-console',
      null,
      null,
      'success',
      null,
      0,
      0,
      0,
      null,
      '/api/admin/accounts/:accountId/credits',
      'internal',
      null,
      JSON.stringify({ accountId, requests: payload.requests, tokens: payload.tokens, note: payload.note ?? null }),
      '',
      ''
    )
    .run()

  return c.json({ ok: true, grantId: grant.id })
})

adminRoute.post('/accounts/bulk-role', zValidator('json', bulkAccountRoleSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserId = c.get('userId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  const payload = c.req.valid('json')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const uniqueIds = Array.from(new Set(payload.accountIds.filter(Boolean)))
  if (uniqueIds.length === 0) {
    return c.json({ error: 'no_accounts_selected' }, 400)
  }

  const placeholders = uniqueIds.map(() => '?').join(', ')
  const memberships = await c.env.DB.prepare(
    `SELECT user_id, role
     FROM memberships
     WHERE tenant_id = ?
       AND user_id IN (${placeholders})`
  )
    .bind(tenantId, ...uniqueIds)
    .all<{ user_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>()

  const mutableIds = memberships.results.filter((membership) => membership.role !== 'owner').map((membership) => membership.user_id)
  if (mutableIds.length === 0) {
    return c.json({ error: 'no_mutable_accounts', message: 'Selected accounts are owner-protected.' }, 400)
  }

  const updatePlaceholders = mutableIds.map(() => '?').join(', ')
  await c.env.DB.prepare(
    `UPDATE memberships
     SET role = ?, updated_at = ?
     WHERE tenant_id = ?
       AND user_id IN (${updatePlaceholders})`
  )
    .bind(payload.role, Date.now(), tenantId, ...mutableIds)
    .run()

  await c.env.DB.prepare(
    `INSERT INTO agent_action_logs (
      tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tenantId,
      currentUserId,
      userEmail || currentUserId,
      'admin.bulk_role_update',
      'admin-console',
      null,
      null,
      'success',
      null,
      0,
      0,
      0,
      null,
      '/api/admin/accounts/bulk-role',
      'internal',
      null,
      JSON.stringify({ accountIds: mutableIds, role: payload.role }),
      '',
      ''
    )
    .run()

  return c.json({ ok: true, updatedAccountIds: mutableIds, skipped: uniqueIds.filter((id) => !mutableIds.includes(id)) })
})

adminRoute.post('/accounts/bulk-delete', zValidator('json', bulkDeleteAccountsSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserId = c.get('userId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  const payload = c.req.valid('json')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const uniqueIds = Array.from(new Set(payload.accountIds.filter(Boolean)))
  if (uniqueIds.length === 0) {
    return c.json({ error: 'no_accounts_selected' }, 400)
  }

  const placeholders = uniqueIds.map(() => '?').join(', ')
  const memberships = await c.env.DB.prepare(
    `SELECT user_id, role
     FROM memberships
     WHERE tenant_id = ?
       AND user_id IN (${placeholders})`
  )
    .bind(tenantId, ...uniqueIds)
    .all<{ user_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>()

  const protectedIds = new Set(
    memberships.results
      .filter((membership) => membership.role === 'owner' || membership.user_id === currentUserId)
      .map((membership) => membership.user_id)
  )
  const deletableIds = memberships.results
    .map((membership) => membership.user_id)
    .filter((id) => !protectedIds.has(id))

  if (deletableIds.length === 0) {
    return c.json({ error: 'no_deletable_accounts', message: 'Selected accounts are protected or belong to the current admin session.' }, 400)
  }

  for (const accountId of deletableIds) {
    await deleteUserAccountRecords(c.env, tenantId, accountId)
  }

  await c.env.DB.prepare(
    `INSERT INTO agent_action_logs (
      tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tenantId,
      currentUserId,
      userEmail || currentUserId,
      'admin.bulk_account_delete',
      'admin-console',
      null,
      null,
      'success',
      null,
      0,
      0,
      0,
      null,
      '/api/admin/accounts/bulk-delete',
      'internal',
      null,
      JSON.stringify({ deletedAccountIds: deletableIds }),
      '',
      ''
    )
    .run()

  return c.json({ ok: true, deletedAccountIds: deletableIds, skipped: uniqueIds.filter((id) => !deletableIds.includes(id)) })
})

adminRoute.post('/projects/bulk-delete', zValidator('json', bulkDeleteProjectsSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserId = c.get('userId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  const payload = c.req.valid('json')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const projectIds = Array.from(new Set(payload.projectIds.filter(Boolean)))
  if (projectIds.length === 0) {
    return c.json({ error: 'no_projects_selected' }, 400)
  }

  const placeholders = projectIds.map(() => '?').join(', ')
  const existing = await c.env.DB.prepare(
    `SELECT id
     FROM projects
     WHERE tenant_id = ?
       AND id IN (${placeholders})`
  )
    .bind(tenantId, ...projectIds)
    .all<{ id: string }>()

  const existingIds = existing.results.map((row) => row.id)
  if (existingIds.length === 0) {
    return c.json({ error: 'projects_not_found' }, 404)
  }

  for (const projectId of existingIds) {
    await deleteProjectRecords(c.env, tenantId, projectId)
  }

  await c.env.DB.prepare(
    `INSERT INTO agent_action_logs (
      tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tenantId,
      currentUserId,
      userEmail || currentUserId,
      'admin.bulk_project_delete',
      'admin-console',
      null,
      null,
      'success',
      null,
      0,
      0,
      0,
      null,
      '/api/admin/projects/bulk-delete',
      'internal',
      null,
      JSON.stringify({ deletedProjectIds: existingIds }),
      '',
      ''
    )
    .run()

  return c.json({ ok: true, deletedProjectIds: existingIds, skipped: projectIds.filter((id) => !existingIds.includes(id)) })
})

adminRoute.put('/accounts/:accountId/role', zValidator('json', accountRoleSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserId = c.get('userId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  const accountId = c.req.param('accountId')
  const payload = c.req.valid('json')

  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const membership = await c.env.DB.prepare(
    `SELECT id, role FROM memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1`
  )
    .bind(tenantId, accountId)
    .first<{ id: string; role: 'owner' | 'admin' | 'member' | 'viewer' } | null>()

  if (!membership) {
    return c.json({ error: 'Account membership not found' }, 404)
  }

  if (membership.role === 'owner') {
    return c.json({ error: 'Owner role cannot be changed' }, 400)
  }

  const now = Date.now()
  await c.env.DB.prepare(
    `UPDATE memberships SET role = ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?`
  )
    .bind(payload.role, now, tenantId, accountId)
    .run()

  await recordSecurityEvent(c.env, {
    tenantId,
    userId: accountId,
    eventType: 'membership.role_changed',
    description: `Workspace role changed to ${payload.role}.`,
    request: c.req.raw,
    metadata: {
      actorUserId: currentUserId,
      previousRole: membership.role,
      nextRole: payload.role,
    },
  })

  await c.env.DB.prepare(
    `INSERT INTO agent_action_logs (
      tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tenantId,
      currentUserId,
      userEmail || currentUserId,
      'admin.role_update',
      'admin-console',
      null,
      null,
      'success',
      null,
      0,
      0,
      0,
      null,
      '/api/admin/accounts/:accountId/role',
      'internal',
      null,
      JSON.stringify({ accountId, role: payload.role }),
      '',
      ''
    )
    .run()

  return c.json({ ok: true, accountId, role: payload.role })
})

// Get agent logs with filtering
adminRoute.get('/logs', zValidator('query', logsQuerySchema), async (c) => {
  const tenantId = c.get('tenantId')
  const currentUserEmail = c.get('userEmail')
  const role = c.get('role')
  
  if (!isAdminUser(currentUserEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }
  
  const query = c.req.valid('query')
  const { startDate, endDate, userEmail: filterUserEmail, agentName, actionType, projectId, status, limit, offset } = query
  
  // Build conditions array
  const conditions: string[] = ['tenant_id = ?']
  const params: (string | number)[] = [tenantId]
  
  if (startDate) {
    conditions.push('created_at >= ?')
    params.push(startDate)
  }
  
  if (endDate) {
    conditions.push('created_at <= ?')
    params.push(endDate)
  }
  
  if (filterUserEmail) {
    conditions.push('user_email LIKE ?')
    params.push(`%${filterUserEmail}%`)
  }
  
  if (agentName) {
    conditions.push('agent_name = ?')
    params.push(agentName)
  }
  
  if (actionType) {
    conditions.push('action_type = ?')
    params.push(actionType)
  }
  
  if (projectId) {
    conditions.push('project_id = ?')
    params.push(projectId)
  }
  
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }
  
  const whereClause = conditions.join(' AND ')
  
  // Count total
  const countStmt = c.env.DB.prepare(`SELECT COUNT(*) as total FROM agent_action_logs WHERE ${whereClause}`)
  const countResult = await countStmt.bind(...params).first()
  const total = countResult?.total as number || 0
  
  // Fetch logs with pagination
  const sql = `
    SELECT 
      id, created_at, user_id, user_email, action_type, agent_name,
      project_id, project_name, status, error_message, tokens_used,
      tokens_input, tokens_output, model_name, api_endpoint, api_provider,
      response_time_ms, metadata, request_preview, response_preview
    FROM agent_action_logs
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `
  
  const stmt = c.env.DB.prepare(sql)
  const result = await stmt.bind(...params, parseInt(limit), parseInt(offset)).all()
  
  return c.json({
    logs: result.results,
    total,
    limit: parseInt(limit),
    offset: parseInt(offset),
  })
})

// Get aggregated stats
adminRoute.get('/stats', async (c) => {
  const tenantId = c.get('tenantId')
  const userEmail = c.get('userEmail')
  const role = c.get('role')
  
  if (!isAdminUser(userEmail, role, c.env)) {
    return c.json({ error: 'Admin access required' }, 403)
  }
  
  // Today's stats
  const todayStmt = c.env.DB.prepare(`
    SELECT 
      COUNT(*) as total_calls,
      SUM(tokens_used) as total_tokens,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      COUNT(DISTINCT user_id) as unique_users,
      AVG(response_time_ms) as avg_response_time
    FROM agent_action_logs
    WHERE tenant_id = ? AND date(created_at) = date('now')
  `)
  const today = await todayStmt.bind(tenantId).first()
  
  // Agent breakdown (last 7 days)
  const agentStmt = c.env.DB.prepare(`
    SELECT 
      agent_name,
      COUNT(*) as calls,
      SUM(tokens_used) as tokens
    FROM agent_action_logs
    WHERE tenant_id = ? AND created_at >= datetime('now', '-7 days')
    GROUP BY agent_name
    ORDER BY calls DESC
  `)
  const agentResult = await agentStmt.bind(tenantId).all()
  
  // Daily trend (last 30 days)
  const trendStmt = c.env.DB.prepare(`
    SELECT 
      date(created_at) as date,
      COUNT(*) as calls,
      SUM(tokens_used) as tokens
    FROM agent_action_logs
    WHERE tenant_id = ? AND created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY date DESC
  `)
  const trendResult = await trendStmt.bind(tenantId).all()
  
  return c.json({
    today: {
      total_calls: Number(today?.total_calls || 0),
      total_tokens: Number(today?.total_tokens || 0),
      error_count: Number(today?.error_count || 0),
      unique_users: Number(today?.unique_users || 0),
      avg_response_time: Number(today?.avg_response_time || 0),
    },
    agents: agentResult.results,
    trend: trendResult.results,
  })
})

// Create a log entry
adminRoute.post('/log', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const body = await c.req.json()
  
  const stmt = c.env.DB.prepare(`
    INSERT INTO agent_action_logs (
      tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `)
  
  const result = await stmt.bind(
    tenantId,
    userId,
    body.user_email || userId,
    body.action_type,
    body.agent_name,
    body.project_id,
    body.project_name,
    body.status || 'success',
    body.error_message || null,
    body.tokens_used || 0,
    body.tokens_input || 0,
    body.tokens_output || 0,
    body.model_name || null,
    body.api_endpoint || null,
    body.api_provider || null,
    body.response_time_ms || null,
    JSON.stringify(body.metadata || {}),
    (body.request_preview || '').substring(0, 500),
    (body.response_preview || '').substring(0, 500)
  ).first()
  
  return c.json({ id: result?.id }, 201)
})

export default adminRoute

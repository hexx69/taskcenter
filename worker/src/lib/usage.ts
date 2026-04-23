import { newId } from './ids'
import type { EnvBindings } from './context'

export type UsageFeatureKey =
  | 'planning.context_analysis'
  | 'planning.epic_generation'
  | 'project.ai_create'
  | 'item.ai_enhance'
  | 'agent.chat'
  | 'agent.run'
  | 'agent.heartbeat'
  | 'agent.execution'
  | 'assistant.stream'
  | 'integration.github_progress_review'

type UsageContext = {
  tenantId: string
  userId: string
}

type CreditGrantInput = {
  tenantId: string
  userId: string
  sourceType: 'stripe_topup' | 'admin_grant'
  sourceRef?: string | null
  requestsGranted: number
  tokensGranted: number
  amountCents?: number | null
  currency?: string | null
  note?: string | null
  createdBy?: string | null
}

type UsageEventInput = {
  featureKey: UsageFeatureKey
  provider?: string | null
  model?: string | null
  requestCount?: number
  inputTokens?: number
  outputTokens?: number
  status: 'success' | 'error' | 'blocked'
  metadata?: Record<string, unknown>
}

const PLAN_LIMITS: Record<string, { monthlyRequests: number; monthlyTokens: number }> = {
  starter: { monthlyRequests: 25, monthlyTokens: 100_000 },
  pro: { monthlyRequests: 500, monthlyTokens: 2_000_000 },
  team: { monthlyRequests: 5_000, monthlyTokens: 20_000_000 },
  enterprise: { monthlyRequests: Number.MAX_SAFE_INTEGER, monthlyTokens: Number.MAX_SAFE_INTEGER },
}

export const CREDIT_PACKAGES = [
  {
    id: 'boost-50',
    label: 'Boost 50',
    description: 'Extra room for personal planning and follow-up chats.',
    amountCents: 1500,
    requestsGranted: 50,
    tokensGranted: 250_000,
  },
  {
    id: 'boost-200',
    label: 'Boost 200',
    description: 'A healthier top-up when a real project starts pulling weight.',
    amountCents: 4900,
    requestsGranted: 200,
    tokensGranted: 1_000_000,
  },
  {
    id: 'boost-1000',
    label: 'Boost 1000',
    description: 'For heavy operators who plan, revise, and review constantly.',
    amountCents: 19900,
    requestsGranted: 1_000,
    tokensGranted: 5_000_000,
  },
] as const

export type CreditPackageId = (typeof CREDIT_PACKAGES)[number]['id']

export function getCreditPackage(packageId: string) {
  return CREDIT_PACKAGES.find((entry) => entry.id === packageId) || null
}

export async function getTenantPlan(env: EnvBindings, tenantId: string) {
  const active = await env.DB.prepare(
    `SELECT plan_key, status
     FROM billing_subscriptions
     WHERE tenant_id = ? AND status IN ('trialing', 'active')
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ plan_key: string; status: string } | null>()

  return active?.plan_key || 'starter'
}

export async function getUsageSnapshot(env: EnvBindings, tenantId: string, userId?: string | null) {
  const planKey = await getTenantPlan(env, tenantId)
  const baseLimits = PLAN_LIMITS[planKey] || PLAN_LIMITS.starter
  const periodStart = new Date()
  periodStart.setUTCDate(1)
  periodStart.setUTCHours(0, 0, 0, 0)
  const start = periodStart.getTime()

  const totalsQuery = userId
    ? env.DB.prepare(
        `SELECT
           COALESCE(SUM(request_count), 0) AS requests,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM usage_events
         WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND status != 'blocked'`
      ).bind(tenantId, userId, start)
    : env.DB.prepare(
        `SELECT
           COALESCE(SUM(request_count), 0) AS requests,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM usage_events
         WHERE tenant_id = ? AND created_at >= ? AND status != 'blocked'`
      ).bind(tenantId, start)

  const totals = await totalsQuery.first<{ requests: number; input_tokens: number; output_tokens: number } | null>()

  const requests = totals?.requests ?? 0
  const tokens = (totals?.input_tokens ?? 0) + (totals?.output_tokens ?? 0)
  const creditGrants = userId
    ? await env.DB.prepare(
        `SELECT
           COALESCE(SUM(requests_granted), 0) AS requests_granted,
           COALESCE(SUM(tokens_granted), 0) AS tokens_granted
         FROM billing_credit_grants
         WHERE tenant_id = ? AND user_id = ?`
      )
        .bind(tenantId, userId)
        .first<{ requests_granted: number; tokens_granted: number } | null>()
    : null

  const limits = {
    monthlyRequests: baseLimits.monthlyRequests + (creditGrants?.requests_granted ?? 0),
    monthlyTokens: baseLimits.monthlyTokens + (creditGrants?.tokens_granted ?? 0),
  }

  return {
    planKey,
    periodStart: start,
    requests,
    tokens,
    baseLimits,
    limits,
    creditGrants: {
      requests: creditGrants?.requests_granted ?? 0,
      tokens: creditGrants?.tokens_granted ?? 0,
    },
    remainingRequests: Math.max(0, limits.monthlyRequests - requests),
    remainingTokens: Math.max(0, limits.monthlyTokens - tokens),
    blocked: requests >= limits.monthlyRequests || tokens >= limits.monthlyTokens,
  }
}

export async function assertUsageAllowed(env: EnvBindings, tenantId: string, userId?: string | null) {
  const snapshot = await getUsageSnapshot(env, tenantId, userId)
  if (snapshot.blocked) {
    const error = new Error(`Usage limit reached for the ${snapshot.planKey} plan.`)
    ;(error as Error & { code?: string }).code = 'usage_limit_reached'
    throw error
  }
  return snapshot
}

export async function grantUsageCredits(env: EnvBindings, input: CreditGrantInput) {
  const sourceRef = input.sourceRef?.trim() || null
  if (sourceRef) {
    const existing = await env.DB.prepare(
      `SELECT id
       FROM billing_credit_grants
       WHERE tenant_id = ? AND user_id = ? AND source_type = ? AND source_ref = ?
       LIMIT 1`
    )
      .bind(input.tenantId, input.userId, input.sourceType, sourceRef)
      .first<{ id: string } | null>()

    if (existing) {
      return { id: existing.id, created: false }
    }
  }

  const id = newId('credit')
  await env.DB.prepare(
    `INSERT INTO billing_credit_grants (
      id, tenant_id, user_id, source_type, source_ref, requests_granted, tokens_granted,
      amount_cents, currency, note, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.tenantId,
      input.userId,
      input.sourceType,
      sourceRef,
      Math.max(0, input.requestsGranted),
      Math.max(0, input.tokensGranted),
      input.amountCents ?? null,
      input.currency ?? null,
      input.note ?? null,
      input.createdBy ?? null,
      Date.now()
    )
    .run()

  return { id, created: true }
}

export async function recordUsageEvent(env: EnvBindings, context: UsageContext, input: UsageEventInput) {
  await env.DB.prepare(
    `INSERT INTO usage_events (
      id, tenant_id, user_id, feature_key, provider, model, request_count,
      input_tokens, output_tokens, status, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('usage'),
      context.tenantId,
      context.userId,
      input.featureKey,
      input.provider ?? null,
      input.model ?? null,
      input.requestCount ?? 1,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.status,
      JSON.stringify(input.metadata || {}),
      Date.now()
    )
    .run()
}

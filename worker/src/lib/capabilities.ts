import type { EnvBindings } from './context'

export type WorkspaceCapabilities = {
  billingReady: boolean
  repoReviewReady: boolean
  debuggerReady: boolean
  integrationHealthReady: boolean
  adminObservabilityReady: boolean
}

export async function getWorkspaceCapabilities(
  env: EnvBindings,
  input: { tenantId?: string | null }
): Promise<WorkspaceCapabilities> {
  const billingReady = Boolean(
    env.STRIPE_SECRET_KEY &&
      env.STRIPE_PRICE_PRO_MONTHLY &&
      env.STRIPE_PRICE_PRO_YEARLY &&
      env.STRIPE_PRICE_TEAM_MONTHLY &&
      env.STRIPE_PRICE_TEAM_YEARLY &&
      env.STRIPE_WEBHOOK_SECRET
  )

  const tenantId = input.tenantId?.trim() || null
  const repoReviewReady = tenantId
    ? Boolean(
        await env.DB.prepare(
          `SELECT id
           FROM project_github_links
           WHERE tenant_id = ?
           LIMIT 1`
        )
          .bind(tenantId)
          .first<{ id: string } | null>()
      )
    : false

  return {
    billingReady,
    repoReviewReady,
    debuggerReady: true,
    integrationHealthReady: true,
    adminObservabilityReady: true,
  }
}

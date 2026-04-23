import type { MiddlewareHandler } from 'hono'
import { readSessionToken, resolveSessionContext } from './server-auth'

export type EnvBindings = {
  DB: D1Database
  ASSISTANT_THREAD_STREAM?: DurableObjectNamespace
  EXECUTION_SESSION_STREAM?: DurableObjectNamespace
  COMPANY_RUNTIME_COORDINATOR?: DurableObjectNamespace
  ADMIN_EMAILS?: string
  AUTH_SESSION_SECRET?: string
  AUTH_PBKDF2_ITERATIONS?: string
  AUTH_EMAIL_FROM?: string
  AUTH_OTP_TTL_SECONDS?: string
  RESEND_API_KEY?: string
  REPO_RUNNER_URL?: string
  REPO_RUNNER_SECRET?: string
  SECRET_ENCRYPTION_KEY?: string
  PUBLIC_APP_URL?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GITHUB_ACCESS_TOKEN?: string
  OPENROUTER_GATEWAY_TOKEN?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  GATEWAY_BASE_URL?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_PRICE_PRO_MONTHLY?: string
  STRIPE_PRICE_PRO_YEARLY?: string
  STRIPE_PRICE_TEAM_MONTHLY?: string
  STRIPE_PRICE_TEAM_YEARLY?: string
  STRIPE_WEBHOOK_SECRET?: string
  WORKER_URL?: string
  INTERNAL_SECRET?: string
}

export type RequestContext = {
  tenantId: string
  userId: string
  sessionId: string
  userEmail: string | null
  userName: string | null
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

export const requireContext: MiddlewareHandler<{ Bindings: EnvBindings; Variables: RequestContext }> = async (
  c,
  next
) => {
  const token = readSessionToken(c)
  const sessionContext = token ? await resolveSessionContext(c.env, token) : null
  if (sessionContext) {
    c.set('tenantId', sessionContext.tenantId)
    c.set('userId', sessionContext.userId)
    c.set('sessionId', sessionContext.sessionId)
    c.set('userEmail', sessionContext.userEmail)
    c.set('userName', sessionContext.userName)
    c.set('role', sessionContext.role)
    await next()
    return
  }

  return c.json(
    {
      error: 'missing_context',
      message: 'Provide a valid TaskCenter session before calling this endpoint.',
    },
    401
  )
}

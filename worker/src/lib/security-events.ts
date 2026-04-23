import { newId } from './ids'

type EnvBindings = {
  DB: D1Database
}

function readForwardedHeader(value?: string | null) {
  return value?.split(',')[0]?.trim() || null
}

function resolveIpAddress(request?: Request | null) {
  if (!request) return null
  return (
    readForwardedHeader(request.headers.get('cf-connecting-ip')) ||
    readForwardedHeader(request.headers.get('x-forwarded-for')) ||
    readForwardedHeader(request.headers.get('x-real-ip'))
  )
}

export async function recordSecurityEvent(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    eventType:
      | 'account.created'
      | 'session.created'
      | 'session.signed_out'
      | 'session.revoked'
      | 'password_reset.requested'
      | 'membership.role_changed'
    description: string
    sessionId?: string | null
    request?: Request | null
    metadata?: Record<string, unknown> | null
    createdAt?: number
  }
) {
  const createdAt = input.createdAt ?? Date.now()
  const ipAddress = resolveIpAddress(input.request)
  const userAgent = input.request?.headers.get('user-agent') || null

  await env.DB.prepare(
    `INSERT INTO security_events (
      id, tenant_id, user_id, session_id, event_type, description,
      ip_address, user_agent, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('secevt'),
      input.tenantId,
      input.userId,
      input.sessionId || null,
      input.eventType,
      input.description,
      ipAddress,
      userAgent,
      input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt
    )
    .run()
}

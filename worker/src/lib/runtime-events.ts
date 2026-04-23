import { newId } from './ids'
import type { EnvBindings } from './context'

export type RuntimeEventSeverity = 'info' | 'warning' | 'error'

export async function recordRuntimeEvent(
  env: EnvBindings,
  input: {
    tenantId?: string | null
    userId?: string | null
    projectId?: string | null
    routeKey: string
    category: string
    severity: RuntimeEventSeverity
    message: string
    metadata?: Record<string, unknown>
  }
) {
  await env.DB.prepare(
    `INSERT INTO app_runtime_events (
      id, tenant_id, user_id, project_id, route_key, category, severity, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('evt'),
      input.tenantId ?? null,
      input.userId ?? null,
      input.projectId ?? null,
      input.routeKey,
      input.category,
      input.severity,
      input.message.slice(0, 600),
      JSON.stringify(input.metadata || {}),
      Date.now()
    )
    .run()
}

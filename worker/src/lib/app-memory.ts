import { newId } from './ids'

type EnvBindings = {
  DB: D1Database
}

export type MemorySourceApp =
  | 'taskcenter'
  | 'github'
  | 'jira'
  | 'notion'
  | 'google_sheets'
  | 'airtable'
  | 'webhooks'
  | 'slack'
  | 'coda'
  | 'google_analytics'
  | 'meta_pixel'
  | 'zapier'
  | 'make'
  | 'pipedream'
  | 'custom_api'
  | 'custom_mcp'

function compact(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function truncate(input: string, limit: number): string {
  if (input.length <= limit) return input
  return `${input.slice(0, Math.max(0, limit - 3)).trim()}...`
}

export async function upsertAppMemoryEntry(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId?: string | null
    sourceApp: MemorySourceApp
    sourceType: string
    sourceKey: string
    title: string
    content: string
    summary?: string | null
    metadata?: Record<string, unknown>
  }
) {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO app_memory_entries (
      id, tenant_id, project_id, source_app, source_type, source_key, title, content, summary, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, source_app, source_type, source_key)
    DO UPDATE SET
      project_id = excluded.project_id,
      title = excluded.title,
      content = excluded.content,
      summary = excluded.summary,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`
  )
    .bind(
      newId('mem'),
      input.tenantId,
      input.projectId ?? null,
      input.sourceApp,
      input.sourceType,
      input.sourceKey,
      truncate(compact(input.title), 240),
      truncate(compact(input.content), 12000),
      input.summary ? truncate(compact(input.summary), 500) : null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    )
    .run()
}

export async function deleteAppMemoryEntry(
  env: EnvBindings,
  input: {
    tenantId: string
    sourceApp: MemorySourceApp
    sourceType: string
    sourceKey: string
  }
) {
  await env.DB.prepare(
    `DELETE FROM app_memory_entries
     WHERE tenant_id = ? AND source_app = ? AND source_type = ? AND source_key = ?`
  )
    .bind(input.tenantId, input.sourceApp, input.sourceType, input.sourceKey)
    .run()
}

export async function deleteAppMemoryEntriesByProject(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId: string
    sourceApp?: MemorySourceApp
    sourceType?: string
  }
) {
  const filters = ['tenant_id = ?', 'project_id = ?']
  const params: Array<string> = [input.tenantId, input.projectId]

  if (input.sourceApp) {
    filters.push('source_app = ?')
    params.push(input.sourceApp)
  }
  if (input.sourceType) {
    filters.push('source_type = ?')
    params.push(input.sourceType)
  }

  await env.DB.prepare(`DELETE FROM app_memory_entries WHERE ${filters.join(' AND ')}`)
    .bind(...params)
    .run()
}

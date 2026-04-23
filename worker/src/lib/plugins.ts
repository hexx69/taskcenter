import { newId } from './ids'
import type { EnvBindings } from './context'

export type PluginRecord = {
  id: string
  slug: string
  name: string
  description: string | null
  version: string
  manifest: Record<string, unknown>
  workerUrl: string | null
  uiUrl: string | null
  status: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

type PluginRow = {
  id: string
  slug: string
  name: string
  description: string | null
  version: string
  manifest_json: string
  worker_url: string | null
  ui_url: string | null
  status: string
  created_by: string
  created_at: number
  updated_at: number
}

function rowToPlugin(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    manifest: JSON.parse(row.manifest_json || '{}') as Record<string, unknown>,
    workerUrl: row.worker_url,
    uiUrl: row.ui_url,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listPlugins(env: EnvBindings, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, slug, name, description, version, manifest_json, worker_url, ui_url, status, created_by, created_at, updated_at
     FROM workspace_plugins WHERE tenant_id = ? ORDER BY updated_at DESC`
  )
    .bind(tenantId)
    .all<PluginRow>()
  return { plugins: rows.results.map(rowToPlugin) }
}

export async function installPlugin(
  env: EnvBindings,
  input: {
    tenantId: string
    createdBy: string
    slug: string
    name: string
    description?: string
    version?: string
    manifest: Record<string, unknown>
    workerUrl?: string
    uiUrl?: string
  }
) {
  const id = newId('plug')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO workspace_plugins (id, tenant_id, slug, name, description, version, manifest_json, worker_url, ui_url, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
     ON CONFLICT(tenant_id, slug) DO UPDATE SET
       name = excluded.name, description = excluded.description, version = excluded.version,
       manifest_json = excluded.manifest_json, worker_url = excluded.worker_url, ui_url = excluded.ui_url, updated_at = excluded.updated_at`
  )
    .bind(id, input.tenantId, input.slug, input.name, input.description ?? null, input.version ?? '1.0.0',
      JSON.stringify(input.manifest), input.workerUrl ?? null, input.uiUrl ?? null, input.createdBy, now, now)
    .run()
  return { ok: true, pluginId: id, status: 'draft' }
}

export async function activatePlugin(env: EnvBindings, input: { tenantId: string; pluginId: string }) {
  await env.DB.prepare(
    `UPDATE workspace_plugins SET status = 'active', updated_at = ? WHERE tenant_id = ? AND id = ?`
  ).bind(Date.now(), input.tenantId, input.pluginId).run()
  return { ok: true }
}

export async function invokePlugin(
  env: EnvBindings,
  input: { tenantId: string; slug: string; action: string; payload: unknown }
): Promise<unknown> {
  const plugin = await env.DB.prepare(
    `SELECT id, slug, worker_url, status FROM workspace_plugins WHERE tenant_id = ? AND slug = ? LIMIT 1`
  )
    .bind(input.tenantId, input.slug)
    .first<{ id: string; slug: string; worker_url: string | null; status: string } | null>()

  if (!plugin || plugin.status !== 'active') throw new Error(`Plugin ${input.slug} not found or not active.`)
  if (!plugin.worker_url) throw new Error(`Plugin ${input.slug} has no worker URL configured.`)

  const res = await fetch(`${plugin.worker_url}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Plugin-Id': plugin.id, 'X-Tenant-Id': input.tenantId },
    body: JSON.stringify({ action: input.action, payload: input.payload }),
  })

  if (!res.ok) throw new Error(`Plugin invocation failed: ${res.status}`)
  return res.json()
}

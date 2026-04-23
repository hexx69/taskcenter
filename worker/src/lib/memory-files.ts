import { newId } from './ids'
import type { EnvBindings } from './context'

export type MemoryFileRecord = {
  id: string
  projectId: string
  paraCategory: string
  path: string
  title: string
  markdown: string
  summary: string | null
  tags: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}

type MemoryFileRow = {
  id: string
  project_id: string
  para_category: string
  path: string
  title: string
  markdown: string
  summary: string | null
  tags_json: string | null
  created_by: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: MemoryFileRow): MemoryFileRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    paraCategory: row.para_category,
    path: row.path,
    title: row.title,
    markdown: row.markdown,
    summary: row.summary,
    tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listMemoryFiles(
  env: EnvBindings,
  input: { tenantId: string; projectId: string; paraCategory?: string }
) {
  const rows = input.paraCategory
    ? await env.DB.prepare(
        `SELECT id, project_id, para_category, path, title, markdown, summary, tags_json, created_by, created_at, updated_at
         FROM project_memory_files
         WHERE tenant_id = ? AND project_id = ? AND para_category = ?
         ORDER BY updated_at DESC`
      )
        .bind(input.tenantId, input.projectId, input.paraCategory)
        .all<MemoryFileRow>()
    : await env.DB.prepare(
        `SELECT id, project_id, para_category, path, title, markdown, summary, tags_json, created_by, created_at, updated_at
         FROM project_memory_files
         WHERE tenant_id = ? AND project_id = ?
         ORDER BY updated_at DESC`
      )
        .bind(input.tenantId, input.projectId)
        .all<MemoryFileRow>()

  return { files: rows.results.map(rowToRecord) }
}

export async function getMemoryFile(
  env: EnvBindings,
  input: { tenantId: string; projectId: string; fileId: string }
) {
  const row = await env.DB.prepare(
    `SELECT id, project_id, para_category, path, title, markdown, summary, tags_json, created_by, created_at, updated_at
     FROM project_memory_files
     WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1`
  )
    .bind(input.tenantId, input.projectId, input.fileId)
    .first<MemoryFileRow | null>()

  return row ? rowToRecord(row) : null
}

export async function upsertMemoryFile(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId: string
    fileId?: string
    paraCategory: 'projects' | 'areas' | 'resources' | 'archives'
    path: string
    title: string
    markdown: string
    summary?: string
    tags?: string[]
    createdBy: string
  }
) {
  const id = input.fileId ?? newId('pmf')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO project_memory_files (
      id, tenant_id, project_id, para_category, path, title, markdown, summary, tags_json, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      para_category = excluded.para_category,
      path = excluded.path,
      title = excluded.title,
      markdown = excluded.markdown,
      summary = excluded.summary,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at`
  )
    .bind(
      id,
      input.tenantId,
      input.projectId,
      input.paraCategory,
      input.path,
      input.title,
      input.markdown,
      input.summary ?? null,
      JSON.stringify(input.tags ?? []),
      input.createdBy,
      now,
      now
    )
    .run()

  return getMemoryFile(env, { tenantId: input.tenantId, projectId: input.projectId, fileId: id })
}

export async function archiveMemoryFile(
  env: EnvBindings,
  input: { tenantId: string; projectId: string; fileId: string }
) {
  await env.DB.prepare(
    `UPDATE project_memory_files
     SET para_category = 'archives', updated_at = ?
     WHERE tenant_id = ? AND project_id = ? AND id = ?`
  )
    .bind(Date.now(), input.tenantId, input.projectId, input.fileId)
    .run()
  return { ok: true }
}

import type { Context } from 'hono'
import { schemaStatements } from './schema'
import { newId } from '../lib/ids'

type Env = {
  DB: D1Database
}

async function getTableColumns(db: D1Database, table: string) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  return new Set(result.results.map((row) => row.name))
}

async function ensureColumn(db: D1Database, table: string, column: string, definition: string) {
  const columns = await getTableColumns(db, table)
  if (columns.has(column)) return
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run()
}

async function tableExists(db: D1Database, table: string) {
  const row = await db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1`
  )
    .bind(table)
    .first<{ name: string } | null>()

  return Boolean(row?.name)
}

function buildIssuePrefix(name: string, fallback: string) {
  const clean = name
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .join('')
  const base = (clean || fallback.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'COMP').slice(0, 6)
  return base.toUpperCase()
}

function buildBrandColor(seed: string) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return `hsl(${hue} 68% 52%)`
}

function defaultInstructionBundle(bundleKey: string, companyName: string) {
  if (bundleKey === 'company') {
    return {
      title: 'COMPANY.md',
      markdown: `# ${companyName}\n\nThis company is managed through TaskCenter.\n\n## Control plane rules\n- Backend routes are the source of truth for durable state.\n- Proposal approval and execution evidence must land in backend records.\n- Use workstreams to scope delivery, repos, and execution.\n`,
      summary: 'Company operating context for Northstar and attached execution adapters.',
    }
  }

  return {
    title: 'AGENTS.md',
    markdown: `# ${companyName} Agents\n\n## Roles\n- CEO: keeps goal alignment, approvals, and workstream direction visible.\n- Operator: turns requests into proposals, pending actions, and execution sessions.\n- Reviewer: moves autonomous work to review with evidence.\n- Executor: runs approved implementation through Cloudflare or Bridge transport.\n\n## Runtime posture\n- Prefer attached work objects over detached chat.\n- Never claim a durable change landed unless the backend recorded it.\n`,
    summary: 'Agent runtime instructions and company-specific operating rules.',
  }
}

async function ensureCompanyIndexes(db: D1Database) {
  const statementsByTable: Array<{ table: string; sql: string }> = [
    { table: 'projects', sql: `CREATE INDEX IF NOT EXISTS idx_projects_company_updated ON projects(tenant_id, company_id, updated_at DESC)` },
    { table: 'assistant_threads', sql: `CREATE INDEX IF NOT EXISTS idx_assistant_threads_company_updated ON assistant_threads(tenant_id, company_id, updated_at DESC)` },
    { table: 'assistant_pending_actions', sql: `CREATE INDEX IF NOT EXISTS idx_assistant_pending_actions_company_updated ON assistant_pending_actions(tenant_id, company_id, updated_at DESC)` },
    { table: 'execution_sessions', sql: `CREATE INDEX IF NOT EXISTS idx_execution_sessions_company_updated ON execution_sessions(tenant_id, company_id, updated_at DESC)` },
    { table: 'issue_comments', sql: `CREATE INDEX IF NOT EXISTS idx_issue_comments_item_created ON issue_comments(tenant_id, item_id, created_at ASC)` },
    { table: 'issue_attachments', sql: `CREATE INDEX IF NOT EXISTS idx_issue_attachments_item_created ON issue_attachments(tenant_id, item_id, created_at DESC)` },
    { table: 'issue_attachment_blobs', sql: `CREATE INDEX IF NOT EXISTS idx_issue_attachment_blobs_tenant_created ON issue_attachment_blobs(tenant_id, created_at DESC)` },
    { table: 'issue_documents', sql: `CREATE INDEX IF NOT EXISTS idx_issue_documents_item_created ON issue_documents(tenant_id, item_id, created_at DESC)` },
    { table: 'issue_approvals', sql: `CREATE INDEX IF NOT EXISTS idx_issue_approvals_item_updated ON issue_approvals(tenant_id, item_id, updated_at DESC)` },
  ]

  for (const statement of statementsByTable) {
    if (!(await tableExists(db, statement.table))) continue
    await db.prepare(statement.sql).run()
  }
}

async function ensureCompanyIndexesOnce(db: D1Database) {
  const indexStateKey = 'company_indexes_v1'
  if (await getBootstrapState(db, indexStateKey) === 'done') {
    return
  }

  await ensureCompanyIndexes(db)
  await setBootstrapState(db, indexStateKey, 'done')
}

async function ensureItemExecutionColumnsOnce(db: D1Database) {
  const stateKey = 'item_execution_columns_v1'
  if (await getBootstrapState(db, stateKey) === 'done') {
    return
  }

  await ensureColumn(db, 'items', 'active_execution_session_id', 'TEXT')
  await ensureColumn(db, 'items', 'last_execution_session_id', 'TEXT')
  await setBootstrapState(db, stateKey, 'done')
}

async function ensureItemsAgentAssigneeColumn(db: D1Database) {
  const stateKey = 'items_assignee_agent_id_v1'
  if ((await getBootstrapState(db, stateKey)) === 'done') return
  await ensureColumn(db, 'items', 'assignee_agent_id', 'TEXT')
  await setBootstrapState(db, stateKey, 'done')
}

async function ensurePaperclipNorthstarMigrationV1(db: D1Database) {
  const stateKey = 'paperclip_northstar_v1'
  if ((await getBootstrapState(db, stateKey)) === 'done') {
    return
  }

  // Routine scheduling needs last_run_at on existing DBs
  await ensureColumn(db, 'company_routines', 'last_run_at', 'INTEGER')

  // PARA memory files + plugin system tables (new tables for existing DBs)
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS project_memory_files (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      para_category TEXT NOT NULL DEFAULT 'resources',
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL DEFAULT '',
      summary TEXT,
      tags_json TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run()

  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_project_memory_files_project ON project_memory_files(tenant_id, project_id, updated_at DESC)`
  ).run()

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS workspace_plugins (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '1.0.0',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      worker_url TEXT,
      ui_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, slug)
    )`
  ).run()

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS workspace_plugin_grants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      company_id TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`
  ).run()

  await setBootstrapState(db, stateKey, 'done')
}

async function getBootstrapState(db: D1Database, stateKey: string) {
  const row = await db.prepare(
    `SELECT state_value
     FROM app_bootstrap_state
     WHERE state_key = ?
     LIMIT 1`
  )
    .bind(stateKey)
    .first<{ state_value: string | null } | null>()

  return row?.state_value ?? null
}

async function setBootstrapState(db: D1Database, stateKey: string, stateValue: string) {
  await db.prepare(
    `INSERT INTO app_bootstrap_state (state_key, state_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(state_key) DO UPDATE SET
       state_value = excluded.state_value,
       updated_at = excluded.updated_at`
  )
    .bind(stateKey, stateValue, Date.now())
    .run()
}

async function backfillCompanies(db: D1Database) {
  const backfillStateKey = 'company_backfill_v1'
  const alreadyBackfilled = await getBootstrapState(db, backfillStateKey)
  if (alreadyBackfilled === 'done') {
    return
  }

  await ensureColumn(db, 'projects', 'company_id', 'TEXT')
  await ensureColumn(db, 'projects', 'workstream_key', 'TEXT')
  await ensureColumn(db, 'projects', 'is_default_workstream', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'assistant_threads', 'company_id', 'TEXT')
  await ensureColumn(db, 'assistant_pending_actions', 'company_id', 'TEXT')
  await ensureColumn(db, 'execution_sessions', 'company_id', 'TEXT')

  const membershipRows = await db.prepare(
    `SELECT tenant_id, user_id, role, created_at, updated_at
     FROM memberships`
  ).all<{ tenant_id: string; user_id: string; role: string; created_at: number; updated_at: number }>()
  const membershipsByTenant = new Map<string, typeof membershipRows.results>()
  for (const membership of membershipRows.results) {
    const entries = membershipsByTenant.get(membership.tenant_id) || []
    entries.push(membership)
    membershipsByTenant.set(membership.tenant_id, entries)
  }

  const projects = await db.prepare(
    `SELECT id, tenant_id, name, description, created_by, created_at, updated_at, company_id
     FROM projects
     ORDER BY created_at ASC`
  ).all<{
    id: string
    tenant_id: string
    name: string
    description: string | null
    created_by: string
    created_at: number
    updated_at: number
    company_id: string | null
  }>()

  for (const project of projects.results) {
    let companyId = project.company_id

    if (!companyId) {
      const existingCompany = await db.prepare(
        `SELECT id
         FROM companies
         WHERE tenant_id = ? AND canonical_project_id = ?
         LIMIT 1`
      )
        .bind(project.tenant_id, project.id)
        .first<{ id: string } | null>()

      companyId = existingCompany?.id ?? null
    }

    if (!companyId) {
      companyId = newId('cmp')
      const issuePrefix = buildIssuePrefix(project.name, project.id)
      await db.prepare(
        `INSERT INTO companies (
          id, tenant_id, canonical_project_id, name, description, status, issue_prefix, brand_color, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
        .bind(
          companyId,
          project.tenant_id,
          project.id,
          project.name,
          project.description,
          issuePrefix,
          buildBrandColor(project.id),
          project.created_by,
          project.created_at,
          project.updated_at
        )
        .run()
    }

    await db.prepare(
      `UPDATE projects
       SET company_id = COALESCE(company_id, ?),
           workstream_key = COALESCE(NULLIF(workstream_key, ''), 'default'),
           is_default_workstream = CASE WHEN is_default_workstream IS NULL OR is_default_workstream = 0 THEN 1 ELSE is_default_workstream END
       WHERE id = ?`
    )
      .bind(companyId, project.id)
      .run()

    const existingWorkstream = await db.prepare(
      `SELECT id
       FROM company_workstreams
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(project.tenant_id, project.id)
      .first<{ id: string } | null>()

    if (!existingWorkstream) {
      await db.prepare(
        `INSERT INTO company_workstreams (
          id, tenant_id, company_id, project_id, name, description, status, is_default, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
      )
        .bind(
          newId('cws'),
          project.tenant_id,
          companyId,
          project.id,
          project.name,
          project.description,
          project.created_by,
          project.created_at,
          project.updated_at
        )
        .run()
    }

    for (const membership of membershipsByTenant.get(project.tenant_id) || []) {
      await db.prepare(
        `INSERT INTO company_members (
          id, tenant_id, company_id, user_id, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, user_id) DO UPDATE SET
          role = excluded.role,
          updated_at = excluded.updated_at`
      )
        .bind(
          newId('cmpm'),
          project.tenant_id,
          companyId,
          membership.user_id,
          membership.role,
          membership.created_at,
          membership.updated_at
        )
        .run()
    }

    for (const bundleKey of ['company', 'agents']) {
      const bundle = defaultInstructionBundle(bundleKey, project.name)
      await db.prepare(
        `INSERT INTO company_instruction_bundles (
          id, tenant_id, company_id, bundle_key, title, markdown, summary, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, bundle_key) DO NOTHING`
      )
        .bind(
          newId('cib'),
          project.tenant_id,
          companyId,
          bundleKey,
          bundle.title,
          bundle.markdown,
          bundle.summary,
          project.created_by,
          project.created_at,
          project.updated_at
        )
        .run()
    }
  }

  await db.prepare(
    `UPDATE assistant_threads
     SET company_id = (
       SELECT p.company_id
       FROM projects p
       WHERE p.id = assistant_threads.project_id
         AND p.tenant_id = assistant_threads.tenant_id
       LIMIT 1
     )
     WHERE company_id IS NULL
       AND project_id IS NOT NULL`
  ).run()

  await db.prepare(
    `UPDATE assistant_pending_actions
     SET company_id = (
       SELECT p.company_id
       FROM projects p
       WHERE p.id = assistant_pending_actions.project_id
         AND p.tenant_id = assistant_pending_actions.tenant_id
       LIMIT 1
     )
     WHERE company_id IS NULL
       AND project_id IS NOT NULL`
  ).run()

  await db.prepare(
    `UPDATE execution_sessions
     SET company_id = (
       SELECT p.company_id
       FROM projects p
       WHERE p.id = execution_sessions.project_id
         AND p.tenant_id = execution_sessions.tenant_id
       LIMIT 1
     )
     WHERE company_id IS NULL
       AND project_id IS NOT NULL`
  ).run()

  await setBootstrapState(db, backfillStateKey, 'done')
}

async function backfillIssueParity(db: D1Database) {
  const parityStateKey = 'issue_parity_v1'
  if (await getBootstrapState(db, parityStateKey) === 'done') {
    return
  }

  await ensureColumn(db, 'items', 'issue_key', 'TEXT')
  await ensureColumn(db, 'items', 'priority', "TEXT NOT NULL DEFAULT 'medium'")
  await ensureColumn(db, 'items', 'goal_id', 'TEXT')

  const issueTables = [
    `CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT,
      project_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      author_user_id TEXT,
      author_name TEXT,
      author_email TEXT,
      source_type TEXT NOT NULL DEFAULT 'human',
      body TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS issue_attachments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT,
      project_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'attachment',
      title TEXT NOT NULL,
      url TEXT,
      mime_type TEXT,
      metadata_json TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS issue_attachment_blobs (
      attachment_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_base64 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS issue_documents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT,
      project_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      body_markdown TEXT,
      metadata_json TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS issue_approvals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT,
      project_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      summary TEXT,
      payload_json TEXT,
      requested_by TEXT NOT NULL,
      decided_by TEXT,
      decided_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ]

  for (const sql of issueTables) {
    await db.prepare(sql).run()
  }

  const companies = await db.prepare(
    `SELECT id, tenant_id, issue_prefix
     FROM companies
     ORDER BY created_at ASC`
  ).all<{ id: string; tenant_id: string; issue_prefix: string | null }>()

  for (const company of companies.results) {
    const prefix = company.issue_prefix || buildIssuePrefix(company.id, company.id)
    const items = await db.prepare(
      `SELECT i.id
       FROM items i
       JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
       WHERE i.tenant_id = ? AND p.company_id = ? AND i.kind IN ('task', 'feature', 'story', 'story_point')
       ORDER BY i.created_at ASC, i.id ASC`
    )
      .bind(company.tenant_id, company.id)
      .all<{ id: string }>()

    let index = 1
    for (const item of items.results) {
      const issueKey = `${prefix}-${String(index).padStart(3, '0')}`
      await db.prepare(
        `UPDATE items
         SET issue_key = COALESCE(NULLIF(issue_key, ''), ?),
             priority = COALESCE(NULLIF(priority, ''), 'medium')
         WHERE id = ? AND tenant_id = ?`
      )
        .bind(issueKey, item.id, company.tenant_id)
        .run()
      index += 1
    }
  }

  await setBootstrapState(db, parityStateKey, 'done')
}

export async function initDb(c: Context<{ Bindings: Env }>) {
  console.log('[taskcenter] initDb begin')
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_bootstrap_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT,
      updated_at INTEGER NOT NULL
    )`
  ).run()
  console.log('[taskcenter] initDb bootstrap table ready')

  const schemaStateKey = 'schema_init_v1'
  const schemaReady = await getBootstrapState(c.env.DB, schemaStateKey)
  console.log('[taskcenter] initDb schema state', schemaReady ?? 'missing')

  if (schemaReady !== 'done') {
    console.log('[taskcenter] initDb applying schema statements')
    for (const [index, sql] of schemaStatements.entries()) {
      try {
        await c.env.DB.prepare(sql).run()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown D1 init error'
        throw new Error(`Schema init failed at statement ${index + 1}: ${message}. SQL: ${sql.slice(0, 160)}`)
      }
    }

    await setBootstrapState(c.env.DB, schemaStateKey, 'done')
    console.log('[taskcenter] initDb schema statements applied')
  }

  console.log('[taskcenter] initDb backfill begin')
  await backfillCompanies(c.env.DB)
  await backfillIssueParity(c.env.DB)
  await ensureItemExecutionColumnsOnce(c.env.DB)
  await ensureItemsAgentAssigneeColumn(c.env.DB)
  await ensurePaperclipNorthstarMigrationV1(c.env.DB)
  await ensureCompanyIndexesOnce(c.env.DB)
  console.log('[taskcenter] initDb complete')
}

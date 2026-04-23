import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { generateTenantAiText } from '../agents/orchestrator'
import { upsertProjectSearchIndex } from '../db/project-index'
import { upsertAppMemoryEntry } from '../lib/app-memory'
import { newId } from '../lib/ids'
import { getCatalogEntry, integrationCatalog, listIntegrationCatalogStatus } from '../lib/integration-catalog'
import { ensureProjectExists } from '../lib/projects'
import { decryptStoredSecret, encryptStoredSecret } from '../lib/secrets'
import { loadRuntimeToolSession } from '../lib/tool-registry'
import { applyProposalActions, canModerateRole } from './proposals'

const integrationsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const integrationConnectSchema = z.object({
  accessToken: z.string().trim().optional(),
  refreshToken: z.string().trim().optional(),
  serviceUrl: z.string().trim().optional(),
  accountId: z.string().trim().optional(),
  accountEmail: z.string().trim().optional(),
  accountName: z.string().trim().optional(),
})

const integrationAdminConfigSchema = z.object({
  status: z.enum(['active', 'pending', 'disabled']).default('active'),
  summary: z.string().trim().max(240).optional(),
  config: z.record(z.string(), z.string()).default({}),
})

const customConnectorCreateSchema = z.object({
  connectorType: z.enum(['custom_api', 'custom_mcp']),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(8).max(240),
  accessScope: z.enum(['personal', 'workspace']).default('personal'),
  status: z.enum(['active', 'pending', 'disabled']).default('active'),
  endpointUrl: z.string().trim().url().optional().or(z.literal('')),
  command: z.string().trim().max(240).optional().or(z.literal('')),
  transport: z.enum(['http', 'sse', 'stdio']).optional(),
  authMode: z.enum(['none', 'bearer', 'header']).default('none'),
  headerName: z.string().trim().max(80).optional().or(z.literal('')),
  authToken: z.string().trim().max(4000).optional().or(z.literal('')),
  config: z.record(z.string(), z.string()).default({}),
})

const customConnectorUpdateSchema = customConnectorCreateSchema.partial()

type CustomConnectorRow = {
  id: string
  tenant_id: string
  user_id: string
  connector_type: 'custom_api' | 'custom_mcp'
  name: string
  slug: string
  description: string
  status: 'active' | 'pending' | 'disabled'
  access_scope: 'personal' | 'workspace'
  endpoint_url: string | null
  command: string | null
  transport: 'http' | 'sse' | 'stdio' | null
  auth_mode: 'none' | 'bearer' | 'header'
  header_name: string | null
  auth_token: string | null
  config_json: string | null
  created_at: number
  updated_at: number
}

function slugifyConnectorName(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'connector'
}

function isAdminRole(role: RequestContext['role']) {
  return role === 'owner' || role === 'admin'
}

function parseConnectorConfig(input: string | null) {
  if (!input) return {} as Record<string, string>
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
  } catch {
    return {}
  }
}

async function decryptConnectionSecret(env: EnvBindings, value?: string | null) {
  return decryptStoredSecret(env, value)
}

function serializeCustomConnector(row: CustomConnectorRow) {
  return {
    id: row.id,
    connectorType: row.connector_type,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    accessScope: row.access_scope,
    endpointUrl: row.endpoint_url,
    command: row.command,
    transport: row.transport,
    authMode: row.auth_mode,
    headerName: row.header_name,
    hasSecret: Boolean(row.auth_token),
    config: parseConnectorConfig(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function upsertCustomConnectorMemory(env: EnvBindings, input: {
  tenantId: string
  connectorType: 'custom_api' | 'custom_mcp'
  connectorId: string
  name: string
  description: string
  accessScope: 'personal' | 'workspace'
  status: 'active' | 'pending' | 'disabled'
  endpointUrl?: string | null
  command?: string | null
  transport?: string | null
  authMode: 'none' | 'bearer' | 'header'
  config: Record<string, string>
}) {
  await upsertAppMemoryEntry(env, {
    tenantId: input.tenantId,
    sourceApp: input.connectorType,
    sourceType: 'connector',
    sourceKey: input.connectorId,
    title: input.name,
    content: [
      input.description,
      `scope:${input.accessScope}`,
      `status:${input.status}`,
      input.endpointUrl ? `endpoint:${input.endpointUrl}` : '',
      input.command ? `command:${input.command}` : '',
      input.transport ? `transport:${input.transport}` : '',
      `auth:${input.authMode}`,
      ...Object.entries(input.config).map(([key, value]) => `${key}:${value}`),
    ].filter(Boolean).join('\n'),
    summary: input.description,
    metadata: { connectorType: input.connectorType },
  })
}

function normalizeIdentity(input?: string | null): string {
  return (input || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function parseJsonObject<T>(input: string): T | null {
  const candidates = [input.trim()]
  const fenced = input.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const firstBrace = input.indexOf('{')
  const lastBrace = input.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(input.slice(firstBrace, lastBrace + 1).trim())
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      continue
    }
  }

  return null
}

async function repairJsonObject<T>(
  env: EnvBindings,
  context: { tenantId: string; userId: string; userEmail: string | null },
  input: {
    rawText: string
    shapeDescription: string
    metadata?: Record<string, unknown>
  }
): Promise<T | null> {
  const repaired = await generateTenantAiText(env, context, {
    featureKey: 'integration.github_progress_review',
    system: 'Convert the input into strict JSON only. Do not add commentary or markdown fences.',
    prompt: [
      'Repair this model output into valid JSON.',
      `Required shape: ${input.shapeDescription}`,
      'If some fields are missing, keep them conservative and use empty arrays where appropriate.',
      `Raw output:\n${input.rawText}`,
    ].join('\n'),
    maxOutputTokens: 700,
    metadata: input.metadata,
  }).catch(() => null)

  if (!repaired) return null
  return parseJsonObject<T>(repaired.text)
}

type ProjectMember = {
  id: string
  name: string
  email: string | null
}

function matchProjectMember(
  members: ProjectMember[],
  candidate: { name?: string | null; email?: string | null; login?: string | null }
): ProjectMember | null {
  const email = (candidate.email || '').trim().toLowerCase()
  if (email) {
    const byEmail = members.find((member) => (member.email || '').trim().toLowerCase() === email)
    if (byEmail) return byEmail
  }

  const aliases = [candidate.name, candidate.login, email.split('@')[0]]
    .map((value) => normalizeIdentity(value))
    .filter(Boolean)

  for (const alias of aliases) {
    const byName = members.find((member) => {
      const memberName = normalizeIdentity(member.name)
      const memberEmailPrefix = normalizeIdentity((member.email || '').split('@')[0])
      return alias === memberName || alias === memberEmailPrefix
    })
    if (byName) return byName
  }

  return null
}

type GitHubConnection = {
  connectionId: string
  accessToken: string
}

type GitHubRepoRecord = {
  id: string
  fullName: string
}

type GitHubCommitListItem = {
  sha: string
  commit: {
    message: string
    author: {
      name: string
      email: string
      date: string
    }
  }
  author: { id: number; login: string } | null
}

type GitHubCommitDetail = GitHubCommitListItem & {
  stats?: { additions: number; deletions: number }
  files?: Array<{ filename: string; status?: string; additions?: number; deletions?: number; patch?: string }>
}

type SyncedGitHubCommit = {
  sha: string
  message: string
  authorName: string
  authorEmail: string | null
  authorLogin: string | null
  committedAt: string
  additions: number
  deletions: number
  files: string[]
  fileSummary: string[]
  extracted: {
    tasks: string[]
    epics: string[]
    issues: string[]
  }
}

const githubProgressReviewSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  days: z.number().int().min(1).max(90).optional(),
  autoApprove: z.boolean().optional(),
  autoApply: z.boolean().optional(),
})

const githubProjectCommitsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  memberId: z.string().min(1).optional(),
})

const githubRepoRunCreateSchema = z.object({
  baseBranch: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  commitMessage: z.string().min(1),
  prTitle: z.string().min(1),
  prBody: z.string().optional(),
  buildCommands: z.array(z.string().min(1)).max(10).optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
  })).min(1).max(50),
})

function normalizeTaskStatus(value?: string | null): 'todo' | 'in_progress' | 'review' | 'done' {
  if (value === 'done' || value === 'completed') return 'done'
  if (value === 'in_progress' || value === 'in-progress' || value === 'active') return 'in_progress'
  if (value === 'review' || value === 'blocked' || value === 'needs_review') return 'review'
  return 'todo'
}

function truncate(input: string, max = 240): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function parseJsonStringArray(input?: string | null): string[] {
  if (!input) return []
  try {
    const parsed = JSON.parse(input)
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : []
  } catch {
    return []
  }
}

function summarizeCommitFiles(files: Array<{ filename: string; status?: string; additions?: number; deletions?: number; patch?: string }> = []): string[] {
  return files.slice(0, 8).map((file) => {
    const counts = []
    if (typeof file.additions === 'number') counts.push(`+${file.additions}`)
    if (typeof file.deletions === 'number') counts.push(`-${file.deletions}`)
    const patchPreview = file.patch ? truncate(file.patch.replace(/[`]/g, ''), 180) : ''
    return [file.filename, file.status || 'modified', counts.join(' '), patchPreview].filter(Boolean).join(' | ')
  })
}

async function fetchGitHubJson<T>(url: string, accessToken: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TaskCenter',
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  const response = await fetch(url, {
    headers,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 180)}`)
  }

  return (await response.json()) as T
}

async function getGitHubConnection(
  env: EnvBindings,
  tenantId: string,
  userId: string
): Promise<GitHubConnection | null> {
  const connection = await env.DB.prepare(
    `SELECT id, access_token
     FROM service_connections
     WHERE tenant_id = ? AND user_id = ? AND service_type = 'github' AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`
  )
    .bind(tenantId, userId)
    .first<{ id: string; access_token: string } | null>()

  if (!connection) return null

  return {
    connectionId: connection.id,
    accessToken: (await decryptConnectionSecret(env, connection.access_token)) || '',
  }
}

async function getGitHubConnectionById(
  env: EnvBindings,
  tenantId: string,
  connectionId: string
): Promise<GitHubConnection | null> {
  const connection = await env.DB.prepare(
    `SELECT id, access_token
     FROM service_connections
     WHERE tenant_id = ? AND id = ? AND service_type = 'github' AND is_active = true
     LIMIT 1`
  )
    .bind(tenantId, connectionId)
    .first<{ id: string; access_token: string } | null>()

  if (!connection) return null

  return {
    connectionId: connection.id,
    accessToken: (await decryptConnectionSecret(env, connection.access_token)) || '',
  }
}

async function ensureGitHubRepoRecord(
  env: EnvBindings,
  input: {
    tenantId: string
    connectionId: string
    accessToken: string
    owner: string
    repo: string
  }
): Promise<GitHubRepoRecord> {
  const existing = await env.DB.prepare(
    `SELECT id, full_name
     FROM github_repos
     WHERE tenant_id = ? AND full_name = ?
     LIMIT 1`
  )
    .bind(input.tenantId, `${input.owner}/${input.repo}`)
    .first<{ id: string | null; full_name: string } | null>()

  let repo: {
    id: number
    name: string
    full_name: string
    owner: { login: string }
    description: string | null
    private: boolean
    stargazers_count: number
    forks_count: number
    open_issues_count: number
    updated_at: string
  }

  try {
    repo = await fetchGitHubJson<{
      id: number
      name: string
      full_name: string
      owner: { login: string }
      description: string | null
      private: boolean
      stargazers_count: number
      forks_count: number
      open_issues_count: number
      updated_at: string
    }>(`https://api.github.com/repos/${input.owner}/${input.repo}`, input.accessToken)
  } catch (error) {
    if (existing) {
      return { id: existing.id || newId('grepo'), fullName: existing.full_name }
    }
    throw error
  }

  const repoId = existing?.id || newId('grepo')

  if (existing) {
    await env.DB.prepare(
      `UPDATE github_repos
       SET id = COALESCE(id, ?),
           connection_id = ?,
           github_repo_id = ?,
           owner = ?,
           name = ?,
           description = ?,
           url = ?,
           private = ?,
           stars = ?,
           forks = ?,
           open_issues = ?,
           synced_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND full_name = ?`
    )
      .bind(
        repoId,
        input.connectionId,
        repo.id,
        repo.owner.login,
        repo.name,
        repo.description,
        `https://github.com/${repo.full_name}`,
        repo.private ? 1 : 0,
        repo.stargazers_count,
        repo.forks_count,
        repo.open_issues_count,
        input.tenantId,
        repo.full_name
      )
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO github_repos (
         id, connection_id, tenant_id, github_repo_id, owner, name, full_name, description, url, private, stars, forks, open_issues
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        repoId,
        input.connectionId,
        input.tenantId,
        repo.id,
        repo.owner.login,
        repo.name,
        repo.full_name,
        repo.description,
        `https://github.com/${repo.full_name}`,
        repo.private ? 1 : 0,
        repo.stargazers_count,
        repo.forks_count,
        repo.open_issues_count
      )
      .run()
  }

  await upsertAppMemoryEntry(env, {
    tenantId: input.tenantId,
    sourceApp: 'github',
    sourceType: 'repo',
    sourceKey: repo.full_name,
    title: repo.full_name,
    content: [
      repo.description || '',
      `stars:${repo.stargazers_count}`,
      `forks:${repo.forks_count}`,
      `open_issues:${repo.open_issues_count}`,
      `private:${repo.private}`,
    ].filter(Boolean).join('\n'),
    summary: repo.description || 'GitHub repository',
    metadata: { owner: repo.owner.login, updatedAt: repo.updated_at },
  }).catch(() => {})

  return { id: repoId, fullName: repo.full_name }
}

async function syncGitHubCommitsForRepo(
  env: EnvBindings,
  input: {
    tenantId: string
    connectionId: string
    repoId: string
    accessToken: string
    owner: string
    repo: string
    days: number
    limit?: number
  }
): Promise<SyncedGitHubCommit[]> {
  const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000).toISOString()
  let commits: GitHubCommitListItem[]

  try {
    commits = await fetchGitHubJson<GitHubCommitListItem[]>(
      `https://api.github.com/repos/${input.owner}/${input.repo}/commits?since=${encodeURIComponent(since)}&per_page=${Math.min(input.limit || 20, 50)}`,
      input.accessToken
    )
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('rate limit') || message.includes('403')) {
      const cached = await env.DB.prepare(
        `SELECT sha, message, author_name, author_email, committed_at, additions, deletions, extracted_tasks, extracted_epics, mentioned_issues
         FROM github_commits
         WHERE tenant_id = ? AND repo_id = ? AND committed_at >= ?
         ORDER BY committed_at DESC
         LIMIT ?`
      )
        .bind(input.tenantId, input.repoId, since, Math.min(input.limit || 20, 50))
        .all<{
          sha: string
          message: string
          author_name: string | null
          author_email: string | null
          committed_at: string
          additions: number
          deletions: number
          extracted_tasks: string | null
          extracted_epics: string | null
          mentioned_issues: string | null
        }>()

      if (cached.results.length > 0) {
        return cached.results.map((commit) => ({
          sha: commit.sha,
          message: commit.message,
          authorName: commit.author_name || 'Unknown',
          authorEmail: commit.author_email,
          authorLogin: null,
          committedAt: commit.committed_at,
          additions: commit.additions || 0,
          deletions: commit.deletions || 0,
          files: [],
          fileSummary: [],
          extracted: {
            tasks: parseJsonStringArray(commit.extracted_tasks),
            epics: parseJsonStringArray(commit.extracted_epics),
            issues: parseJsonStringArray(commit.mentioned_issues),
          },
        }))
      }
    }

    throw error
  }

  const detailedCommits = await Promise.all(
    commits.slice(0, input.limit || 20).map(async (commit) => {
      try {
        return await fetchGitHubJson<GitHubCommitDetail>(
          `https://api.github.com/repos/${input.owner}/${input.repo}/commits/${commit.sha}`,
          input.accessToken
        )
      } catch {
        return commit as GitHubCommitDetail
      }
    })
  )

  const processed: SyncedGitHubCommit[] = []

  for (const commit of detailedCommits) {
    const files = commit.files || []
    const extracted = extractWorkInsights(commit.commit.message, files.map((file) => file.filename))
    const fileSummary = summarizeCommitFiles(files)
    const commitId =
      (
        await env.DB.prepare(
          `SELECT id
           FROM github_commits
           WHERE repo_id = ? AND sha = ?
           LIMIT 1`
        )
          .bind(input.repoId, commit.sha)
          .first<{ id: string | null } | null>()
      )?.id || newId('gcommit')

    await env.DB.prepare(
      `INSERT INTO github_commits (
         id, connection_id, tenant_id, repo_id, sha, message, author_name, author_email, author_github_id,
         committed_at, additions, deletions, extracted_tasks, extracted_epics, mentioned_issues
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, sha) DO UPDATE SET
         id = COALESCE(github_commits.id, excluded.id),
         message = excluded.message,
         author_name = excluded.author_name,
         author_email = excluded.author_email,
         author_github_id = excluded.author_github_id,
         committed_at = excluded.committed_at,
         additions = excluded.additions,
         deletions = excluded.deletions,
         extracted_tasks = excluded.extracted_tasks,
         extracted_epics = excluded.extracted_epics,
         mentioned_issues = excluded.mentioned_issues`
    )
      .bind(
        commitId,
        input.connectionId,
        input.tenantId,
        input.repoId,
        commit.sha,
        commit.commit.message,
        commit.commit.author.name,
        commit.commit.author.email,
        commit.author?.id || null,
        commit.commit.author.date,
        commit.stats?.additions || 0,
        commit.stats?.deletions || 0,
        JSON.stringify(extracted.tasks),
        JSON.stringify(extracted.epics),
        JSON.stringify(extracted.issues)
      )
      .run()

    await upsertAppMemoryEntry(env, {
      tenantId: input.tenantId,
      sourceApp: 'github',
      sourceType: 'commit',
      sourceKey: `${input.owner}/${input.repo}:${commit.sha}`,
      title: `${input.owner}/${input.repo}@${commit.sha.slice(0, 7)}`,
      content: [
        commit.commit.message,
        `author:${commit.commit.author.name}`,
        `tasks:${extracted.tasks.join(' | ')}`,
        `epics:${extracted.epics.join(' | ')}`,
        `issues:${extracted.issues.join(' | ')}`,
        ...fileSummary,
      ].filter(Boolean).join('\n'),
      summary: commit.commit.message.split('\n')[0],
      metadata: { repo: `${input.owner}/${input.repo}`, committedAt: commit.commit.author.date },
    }).catch(() => {})

    processed.push({
      sha: commit.sha,
      message: commit.commit.message,
      authorName: commit.commit.author.name,
      authorEmail: commit.commit.author.email || null,
      authorLogin: commit.author?.login || null,
      committedAt: commit.commit.author.date,
      additions: commit.stats?.additions || 0,
      deletions: commit.stats?.deletions || 0,
      files: files.map((file) => file.filename),
      fileSummary,
      extracted,
    })
  }

  return processed
}

integrationsRoute.get('/catalog', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const integrations = await listIntegrationCatalogStatus(c.env, { tenantId, userId })
  return c.json({ integrations })
})

integrationsRoute.get('/runtime-tool-session', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const projectId = c.req.query('projectId') || undefined
  const selectedConnectorKeys = c.req.query('selectedConnectorKeys')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const session = await loadRuntimeToolSession(c.env, {
    tenantId,
    userId,
    projectId,
    selectedConnectorKeys,
  })

  return c.json({ session })
})

integrationsRoute.post('/catalog/:key/connect', zValidator('json', integrationConnectSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { key } = c.req.param()
  const payload = c.req.valid('json')
  const entry = getCatalogEntry(key)

  if (!entry) {
    return c.json({ error: 'integration_not_found' }, 404)
  }

  if (!entry.userConnectable || !entry.serviceType) {
    return c.json({ error: 'integration_not_user_connectable' }, 400)
  }

  if (entry.key === 'github') {
    return c.json({ error: 'use_github_oauth_flow' }, 400)
  }

  const missingRequiredField = entry.setupFields.find((field) => field.required && !(payload[field.key] || '').trim())
  if (missingRequiredField) {
    return c.json({ error: 'missing_required_field', field: missingRequiredField.key }, 400)
  }

  const serviceAccountId = payload.accountId || `${entry.key}:${userId}`
  const connectionId = newId('conn')
  const encryptedAccessToken = await encryptStoredSecret(c.env, payload.accessToken || null)
  const encryptedRefreshToken = await encryptStoredSecret(c.env, payload.refreshToken || null)

  await c.env.DB.prepare(
    `INSERT INTO service_connections (
       id, tenant_id, user_id, service_type, access_token, refresh_token, service_url,
       service_account_id, service_account_email, service_account_name, is_active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(tenant_id, service_type, service_account_id)
     DO UPDATE SET
       user_id = excluded.user_id,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       service_url = excluded.service_url,
       service_account_email = excluded.service_account_email,
       service_account_name = excluded.service_account_name,
       updated_at = datetime('now'),
       is_active = 1`
  )
    .bind(
      connectionId,
      tenantId,
      userId,
      entry.serviceType,
      encryptedAccessToken,
      encryptedRefreshToken,
      payload.serviceUrl || null,
      serviceAccountId,
      payload.accountEmail || null,
      payload.accountName || payload.accountEmail || null
    )
    .run()

  await upsertAppMemoryEntry(c.env, {
    tenantId,
    sourceApp: entry.key as Parameters<typeof upsertAppMemoryEntry>[1]['sourceApp'],
    sourceType: 'connection',
    sourceKey: serviceAccountId,
    title: `${entry.name} connection`,
    content: [
      `service:${entry.key}`,
      payload.accountName ? `account:${payload.accountName}` : '',
      payload.accountEmail ? `email:${payload.accountEmail}` : '',
      payload.serviceUrl ? `url:${payload.serviceUrl}` : '',
    ].filter(Boolean).join('\n'),
    summary: payload.accountName || payload.accountEmail || `${entry.name} connected`,
    metadata: { authKind: entry.authKind },
  }).catch(() => {})

  return c.json({ ok: true, connected: true })
})

integrationsRoute.post('/catalog/:key/disconnect', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { key } = c.req.param()
  const entry = getCatalogEntry(key)

  if (!entry?.serviceType) {
    return c.json({ error: 'integration_not_found' }, 404)
  }

  await c.env.DB.prepare(
    `UPDATE service_connections
     SET is_active = 0, updated_at = datetime('now')
     WHERE tenant_id = ? AND user_id = ? AND service_type = ? AND is_active = 1`
  )
    .bind(tenantId, userId, entry.serviceType)
    .run()

  return c.json({ ok: true, connected: false })
})

integrationsRoute.post('/admin/:key/config', zValidator('json', integrationAdminConfigSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')
  const { key } = c.req.param()
  const payload = c.req.valid('json')
  const entry = getCatalogEntry(key)

  if (!entry) {
    return c.json({ error: 'integration_not_found' }, 404)
  }

  if (!entry.adminConfigurable) {
    return c.json({ error: 'integration_not_admin_configurable' }, 400)
  }

  if (!isAdminRole(role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const missingRequiredField = entry.setupFields.find((field) => field.required && !String(payload.config[field.key] || '').trim())
  if (payload.status !== 'disabled' && missingRequiredField) {
    return c.json({ error: 'missing_required_field', field: missingRequiredField.key }, 400)
  }

  const summary =
    payload.summary ||
    (payload.status === 'disabled'
      ? `${entry.name} disabled`
      : String(payload.config.accountName || payload.config.accountId || `${entry.name} configured`))

  await c.env.DB.prepare(
    `INSERT INTO admin_integration_configs (
       id, tenant_id, integration_key, status, summary, config_json, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, integration_key)
     DO UPDATE SET
       status = excluded.status,
       summary = excluded.summary,
       config_json = excluded.config_json,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  )
    .bind(newId('aint'), tenantId, entry.key, payload.status, summary, JSON.stringify(payload.config), userId, Date.now(), Date.now())
    .run()

  await upsertAppMemoryEntry(c.env, {
    tenantId,
    sourceApp: entry.key as Parameters<typeof upsertAppMemoryEntry>[1]['sourceApp'],
    sourceType: 'workspace_config',
    sourceKey: entry.key,
    title: `${entry.name} workspace config`,
    content: [
      `status:${payload.status}`,
      summary,
      ...Object.entries(payload.config).map(([configKey, value]) => `${configKey}:${value}`),
    ].join('\n'),
    summary,
    metadata: { managedBy: 'admin' },
  }).catch(() => {})

  return c.json({ ok: true, status: payload.status })
})

integrationsRoute.get('/custom-connectors', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')

  const rows = await c.env.DB.prepare(
    `SELECT *
     FROM custom_connectors
     WHERE tenant_id = ?
       AND (user_id = ? OR access_scope = 'workspace' OR ? IN ('owner', 'admin'))
     ORDER BY access_scope = 'workspace' DESC, updated_at DESC`
  )
    .bind(tenantId, userId, role || '')
    .all<CustomConnectorRow>()

  return c.json({ connectors: rows.results.map(serializeCustomConnector) })
})

integrationsRoute.post('/custom-connectors', zValidator('json', customConnectorCreateSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')
  const payload = c.req.valid('json')

  if (payload.accessScope === 'workspace' && !isAdminRole(role)) {
    return c.json({ error: 'admin_required_for_workspace_connector' }, 403)
  }

  if (payload.connectorType === 'custom_api' && !payload.endpointUrl?.trim()) {
    return c.json({ error: 'endpoint_url_required' }, 400)
  }

  if (payload.connectorType === 'custom_mcp' && !payload.endpointUrl?.trim() && !payload.command?.trim()) {
    return c.json({ error: 'endpoint_or_command_required' }, 400)
  }

  if (payload.authMode === 'header' && !payload.headerName?.trim()) {
    return c.json({ error: 'header_name_required' }, 400)
  }

  const now = Date.now()
  const connectorId = newId('cc')
  const slug = slugifyConnectorName(payload.name)
  const encryptedAuthToken = await encryptStoredSecret(c.env, payload.authToken?.trim() || null)

  await c.env.DB.prepare(
    `INSERT INTO custom_connectors (
       id, tenant_id, user_id, connector_type, name, slug, description, status, access_scope,
       endpoint_url, command, transport, auth_mode, header_name, auth_token, config_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, connector_type, slug)
     DO UPDATE SET
       user_id = excluded.user_id,
       name = excluded.name,
       description = excluded.description,
       status = excluded.status,
       access_scope = excluded.access_scope,
       endpoint_url = excluded.endpoint_url,
       command = excluded.command,
       transport = excluded.transport,
       auth_mode = excluded.auth_mode,
       header_name = excluded.header_name,
       auth_token = COALESCE(NULLIF(excluded.auth_token, ''), custom_connectors.auth_token),
       config_json = excluded.config_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      connectorId,
      tenantId,
      userId,
      payload.connectorType,
      payload.name,
      slug,
      payload.description,
      payload.status,
      payload.accessScope,
      payload.endpointUrl?.trim() || null,
      payload.command?.trim() || null,
      payload.transport || (payload.connectorType === 'custom_mcp' ? 'http' : null),
      payload.authMode,
      payload.headerName?.trim() || null,
      encryptedAuthToken,
      JSON.stringify(payload.config || {}),
      now,
      now
    )
    .run()

  const saved = await c.env.DB.prepare(
    `SELECT * FROM custom_connectors
     WHERE tenant_id = ? AND connector_type = ? AND slug = ?
     LIMIT 1`
  )
    .bind(tenantId, payload.connectorType, slug)
    .first<CustomConnectorRow | null>()

  if (saved) {
    await upsertCustomConnectorMemory(c.env, {
      tenantId,
      connectorType: saved.connector_type,
      connectorId: saved.id,
      name: saved.name,
      description: saved.description,
      accessScope: saved.access_scope,
      status: saved.status,
      endpointUrl: saved.endpoint_url,
      command: saved.command,
      transport: saved.transport,
      authMode: saved.auth_mode,
      config: parseConnectorConfig(saved.config_json),
    }).catch(() => {})
  }

  return c.json({ connector: saved ? serializeCustomConnector(saved) : null }, 201)
})

integrationsRoute.put('/custom-connectors/:connectorId', zValidator('json', customConnectorUpdateSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')
  const connectorId = c.req.param('connectorId')
  const payload = c.req.valid('json')

  const existing = await c.env.DB.prepare(
    `SELECT * FROM custom_connectors WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, connectorId)
    .first<CustomConnectorRow | null>()

  if (!existing) {
    return c.json({ error: 'connector_not_found' }, 404)
  }

  if (existing.user_id !== userId && !isAdminRole(role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const nextScope = payload.accessScope || existing.access_scope
  if (nextScope === 'workspace' && !isAdminRole(role)) {
    return c.json({ error: 'admin_required_for_workspace_connector' }, 403)
  }

  const nextType = payload.connectorType || existing.connector_type
  const nextEndpoint = payload.endpointUrl !== undefined ? payload.endpointUrl.trim() : existing.endpoint_url || ''
  const nextCommand = payload.command !== undefined ? payload.command.trim() : existing.command || ''
  const nextAuthMode = payload.authMode || existing.auth_mode
  const nextHeaderName = payload.headerName !== undefined ? payload.headerName.trim() : existing.header_name || ''

  if (nextType === 'custom_api' && !nextEndpoint) {
    return c.json({ error: 'endpoint_url_required' }, 400)
  }

  if (nextType === 'custom_mcp' && !nextEndpoint && !nextCommand) {
    return c.json({ error: 'endpoint_or_command_required' }, 400)
  }

  if (nextAuthMode === 'header' && !nextHeaderName) {
    return c.json({ error: 'header_name_required' }, 400)
  }

  const nextName = payload.name?.trim() || existing.name
  const nextSlug = payload.name?.trim() ? slugifyConnectorName(payload.name) : existing.slug
  const nextDescription = payload.description?.trim() || existing.description
  const nextStatus = payload.status || existing.status
  const nextTransport = payload.transport || existing.transport || (nextType === 'custom_mcp' ? 'http' : null)
  const nextConfig = payload.config ? JSON.stringify(payload.config) : existing.config_json
  const nextAuthToken =
    payload.authToken !== undefined
      ? (await encryptStoredSecret(c.env, payload.authToken.trim() || null)) || existing.auth_token
      : existing.auth_token

  await c.env.DB.prepare(
    `UPDATE custom_connectors
     SET connector_type = ?, name = ?, slug = ?, description = ?, status = ?, access_scope = ?,
         endpoint_url = ?, command = ?, transport = ?, auth_mode = ?, header_name = ?, auth_token = ?, config_json = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(
      nextType,
      nextName,
      nextSlug,
      nextDescription,
      nextStatus,
      nextScope,
      nextEndpoint || null,
      nextCommand || null,
      nextTransport,
      nextAuthMode,
      nextHeaderName || null,
      nextAuthToken || null,
      nextConfig,
      Date.now(),
      tenantId,
      connectorId
    )
    .run()

  const updated = await c.env.DB.prepare(
    `SELECT * FROM custom_connectors WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, connectorId)
    .first<CustomConnectorRow | null>()

  if (updated) {
    await upsertCustomConnectorMemory(c.env, {
      tenantId,
      connectorType: updated.connector_type,
      connectorId: updated.id,
      name: updated.name,
      description: updated.description,
      accessScope: updated.access_scope,
      status: updated.status,
      endpointUrl: updated.endpoint_url,
      command: updated.command,
      transport: updated.transport,
      authMode: updated.auth_mode,
      config: parseConnectorConfig(updated.config_json),
    }).catch(() => {})
  }

  return c.json({ connector: updated ? serializeCustomConnector(updated) : null })
})

integrationsRoute.delete('/custom-connectors/:connectorId', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const role = c.get('role')
  const connectorId = c.req.param('connectorId')

  const existing = await c.env.DB.prepare(
    `SELECT * FROM custom_connectors WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, connectorId)
    .first<CustomConnectorRow | null>()

  if (!existing) {
    return c.json({ error: 'connector_not_found' }, 404)
  }

  if (existing.user_id !== userId && !isAdminRole(role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  await c.env.DB.prepare(
    `DELETE FROM custom_connectors WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenantId, connectorId)
    .run()

  await c.env.DB.prepare(
    `DELETE FROM app_memory_entries
     WHERE tenant_id = ? AND source_app = ? AND source_type = 'connector' AND source_key = ?`
  )
    .bind(tenantId, existing.connector_type, existing.id)
    .run()

  return c.json({ ok: true })
})

// ==================== GITHUB INTEGRATION ====================

// Exchange GitHub code for access token
integrationsRoute.post('/github/connect', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { code, state } = await c.req.json()
  
  const clientId = c.env.GITHUB_CLIENT_ID
  const clientSecret = c.env.GITHUB_CLIENT_SECRET
  
  try {
    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, state }),
    })
    const tokenData = await tokenRes.json() as { access_token: string; error?: string }
    
    if (tokenData.error) {
      return c.json({ error: tokenData.error }, 400)
    }
    
    // Get user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    })
    const userData = await userRes.json() as { id: number; login: string; email: string; name: string }
    
    const encryptedGitHubToken = await encryptStoredSecret(c.env, tokenData.access_token)

    // Store connection
    await c.env.DB.prepare(`
      INSERT INTO service_connections 
      (tenant_id, user_id, service_type, access_token, service_account_id, service_account_email, service_account_name, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, true)
      ON CONFLICT(tenant_id, service_type, service_account_id) 
      DO UPDATE SET access_token = ?, updated_at = datetime('now'), is_active = true
    `).bind(tenantId, userId, 'github', encryptedGitHubToken, String(userData.id), userData.email, userData.name, encryptedGitHubToken).run()
    
    return c.json({ connected: true, account: userData.login })
  } catch (err) {
    return c.json({ error: 'Failed to connect GitHub' }, 500)
  }
})

// Get user's GitHub repos
integrationsRoute.get('/github/repos', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  
  // Get connection
  const conn = await c.env.DB.prepare(`
    SELECT id, access_token FROM service_connections 
    WHERE tenant_id = ? AND user_id = ? AND service_type = 'github' AND is_active = true
    LIMIT 1
  `).bind(tenantId, userId).first()
  
  if (!conn) {
    return c.json({ error: 'GitHub not connected' }, 400)
  }
  
  try {
    const githubAccessToken = await decryptConnectionSecret(c.env, (conn as { access_token?: string | null }).access_token)
    const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: { Authorization: `Bearer ${githubAccessToken}`, Accept: 'application/vnd.github.v3+json' }
    })
    const repos = await res.json() as Array<{
      id: number
      name: string
      full_name: string
      owner: { login: string }
      description: string
      private: boolean
      stargazers_count: number
      forks_count: number
      open_issues_count: number
      updated_at: string
    }>
    
    // Sync to database
    for (const repo of repos) {
      await c.env.DB.prepare(`
        INSERT INTO github_repos (connection_id, tenant_id, github_repo_id, owner, name, full_name, description, url, private, stars, forks, open_issues)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, full_name) 
        DO UPDATE SET description = ?, private = ?, stars = ?, forks = ?, open_issues = ?, synced_at = datetime('now')
      `).bind(
        conn.id, tenantId, repo.id, repo.owner.login, repo.name, repo.full_name, 
        repo.description, `https://github.com/${repo.full_name}`, repo.private,
        repo.stargazers_count, repo.forks_count, repo.open_issues_count,
        repo.description, repo.private, repo.stargazers_count, repo.forks_count, repo.open_issues_count
      ).run()

      await upsertAppMemoryEntry(c.env, {
        tenantId,
        sourceApp: 'github',
        sourceType: 'repo',
        sourceKey: repo.full_name,
        title: repo.full_name,
        content: [
          repo.description || '',
          `stars:${repo.stargazers_count}`,
          `forks:${repo.forks_count}`,
          `open_issues:${repo.open_issues_count}`,
          `private:${repo.private}`,
        ].filter(Boolean).join('\n'),
        summary: repo.description || 'GitHub repository',
        metadata: { owner: repo.owner.login, updatedAt: repo.updated_at },
      }).catch(() => {})
    }
    
    return c.json({ repos: repos.map(r => ({ id: r.id, name: r.full_name, description: r.description, updated_at: r.updated_at })) })
  } catch (err) {
    return c.json({ error: 'Failed to fetch repos' }, 500)
  }
})

// Fetch commits for a repo with analysis
integrationsRoute.get('/github/repos/:owner/:repo/commits', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { owner, repo } = c.req.param()
  const days = parseInt(c.req.query('days') || '30')
  
  const conn = await c.env.DB.prepare(`
    SELECT sc.id, sc.access_token, gr.id as repo_id 
    FROM service_connections sc
    JOIN github_repos gr ON gr.connection_id = sc.id
    WHERE sc.tenant_id = ? AND sc.user_id = ? AND sc.service_type = 'github' 
    AND gr.full_name = ? AND sc.is_active = true
    LIMIT 1
  `).bind(tenantId, userId, `${owner}/${repo}`).first()
  
  if (!conn) {
    return c.json({ error: 'Repo not found or GitHub not connected' }, 400)
  }
  
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  
  try {
    const githubAccessToken = await decryptConnectionSecret(c.env, (conn as { access_token?: string | null }).access_token)
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=100`, {
      headers: { Authorization: `Bearer ${githubAccessToken}`, Accept: 'application/vnd.github.v3+json' }
    })
    const commits = await res.json() as Array<{
      sha: string
      commit: { message: string; author: { name: string; email: string; date: string } }
      author: { id: number; login: string } | null
      stats?: { additions: number; deletions: number }
      files?: Array<{ filename: string }>
    }>
    
    // Process and store commits
    const processed = []
    for (const commit of commits) {
      // Extract insights from commit message
      const extracted = extractWorkInsights(commit.commit.message, commit.files?.map(f => f.filename) || [])
      
      await c.env.DB.prepare(`
        INSERT INTO github_commits (
          connection_id, tenant_id, repo_id, sha, message, author_name, author_email, author_github_id,
          committed_at, additions, deletions, extracted_tasks, extracted_epics, mentioned_issues
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, sha) DO NOTHING
      `).bind(
        conn.id, tenantId, conn.repo_id, commit.sha, commit.commit.message,
        commit.commit.author.name, commit.commit.author.email, commit.author?.id || null,
        commit.commit.author.date, commit.stats?.additions || 0, commit.stats?.deletions || 0,
        JSON.stringify(extracted.tasks), JSON.stringify(extracted.epics), JSON.stringify(extracted.issues)
      ).run()

      await upsertAppMemoryEntry(c.env, {
        tenantId,
        sourceApp: 'github',
        sourceType: 'commit',
        sourceKey: `${owner}/${repo}:${commit.sha}`,
        title: `${owner}/${repo}@${commit.sha.slice(0, 7)}`,
        content: [
          commit.commit.message,
          `author:${commit.commit.author.name}`,
          `tasks:${extracted.tasks.join(' | ')}`,
          `epics:${extracted.epics.join(' | ')}`,
          `issues:${extracted.issues.join(' | ')}`,
        ].filter(Boolean).join('\n'),
        summary: commit.commit.message.split('\n')[0],
        metadata: { repo: `${owner}/${repo}`, committedAt: commit.commit.author.date },
      }).catch(() => {})
      
      processed.push({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author.name,
        date: commit.commit.author.date,
        extracted: extracted
      })
    }
    
    return c.json({ commits: processed, count: processed.length })
  } catch (err) {
    return c.json({ error: 'Failed to fetch commits' }, 500)
  }
})

integrationsRoute.post(
  '/github/projects/:projectId/progress-review',
  zValidator('json', githubProgressReviewSchema),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const role = c.get('role')
    const { projectId } = c.req.param()
    const { owner: requestedOwner, repo: requestedRepo, days = 14, autoApprove = false, autoApply = false } = c.req.valid('json')

    if ((autoApprove || autoApply) && !canModerateRole(role)) {
      return c.json({ error: 'forbidden', message: 'Only owners and admins can auto-approve or auto-apply progress reviews.' }, 403)
    }

    const project = await ensureProjectExists(c.env, tenantId, projectId)
    if (!project) {
      return c.json({ error: 'project_not_found' }, 404)
    }

    const linkedRepo = await c.env.DB.prepare(
      `SELECT connection_id, repo_full_name, repo_owner, repo_name, collaboration_mode, review_on_push
       FROM project_github_links
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{
        connection_id: string
        repo_full_name: string
        repo_owner: string
        repo_name: string
        collaboration_mode: string
        review_on_push: number
      } | null>()

    const owner = requestedOwner || linkedRepo?.repo_owner || linkedRepo?.repo_full_name.split('/')[0] || null
    const repo = requestedRepo || linkedRepo?.repo_name || linkedRepo?.repo_full_name.split('/')[1] || null

    if (!owner || !repo) {
      return c.json(
        {
          error: 'github_repo_required',
          message: 'Link a GitHub repository to this project during setup, or provide owner and repo when requesting a review.',
        },
        400
      )
    }

    const githubConnection =
      (linkedRepo?.connection_id ? await getGitHubConnectionById(c.env, tenantId, linkedRepo.connection_id) : null) ||
      (await getGitHubConnection(c.env, tenantId, userId))
    if (!githubConnection) {
      return c.json({ error: 'github_not_connected' }, 400)
    }

    try {
      const repoRecord = await ensureGitHubRepoRecord(c.env, {
        tenantId,
        connectionId: githubConnection.connectionId,
        accessToken: githubConnection.accessToken,
        owner,
        repo,
      })

      const syncedCommits = await syncGitHubCommitsForRepo(c.env, {
        tenantId,
        connectionId: githubConnection.connectionId,
        repoId: repoRecord.id,
        accessToken: githubConnection.accessToken,
        owner,
        repo,
        days,
        limit: 12,
      })

      if (syncedCommits.length === 0) {
        return c.json({
          ok: true,
          repo: repoRecord.fullName,
          syncedCommits: 0,
          summary: `No commits landed in ${repoRecord.fullName} in the last ${days} day(s), so there was nothing to review.`,
          review: {
            readyToShip: false,
            notes: ['No recent commits were found for this repository window.'],
            taskUpdates: [],
          },
          proposal: null,
        })
      }

      const [projectItems, projectMembers] = await Promise.all([
        c.env.DB.prepare(
          `SELECT id, kind, title, description, status, assignee_id, updated_at
           FROM items
           WHERE tenant_id = ? AND project_id = ?
           ORDER BY updated_at DESC, created_at DESC
           LIMIT 200`
        )
          .bind(tenantId, projectId)
          .all<{
            id: string
            kind: string
            title: string
            description: string | null
            status: string
            assignee_id: string | null
            updated_at: number
          }>(),
        c.env.DB.prepare(
          `SELECT
             u.id,
             COALESCE(u.name, u.email, u.id) AS name,
             u.email
           FROM project_member_assignments pma
           JOIN users u ON u.id = pma.member_id AND u.tenant_id = pma.tenant_id
           WHERE pma.tenant_id = ? AND pma.project_id = ?
           ORDER BY pma.updated_at DESC`
        )
          .bind(tenantId, projectId)
          .all<ProjectMember>(),
      ])

      const memberMatches = Array.from(
        new Map(
          syncedCommits
            .map((commit) => {
              const member = matchProjectMember(projectMembers.results, {
                name: commit.authorName,
                email: commit.authorEmail,
                login: commit.authorLogin,
              })
              if (!member) return null
              return [
                member.id,
                {
                  memberId: member.id,
                  memberName: member.name,
                  login: commit.authorLogin,
                  email: commit.authorEmail,
                  matchedFrom: commit.authorName,
                },
              ] as const
            })
            .filter((entry): entry is readonly [string, { memberId: string; memberName: string; login: string | null; email: string | null; matchedFrom: string }] => Boolean(entry))
        ).values()
      )

      const itemById = new Map(projectItems.results.map((item) => [item.id, item]))
      const itemByTitle = new Map(
        projectItems.results.map((item) => [normalizeIdentity(item.title), item])
      )

      const reviewPrompt = [
        'You are TaskCenter GitHub progress reviewer.',
        'Compare recent GitHub commits with board tasks and return only valid JSON.',
        'Rules:',
        '- Use only the listed task IDs or exact task titles when updating existing work.',
        '- Mark status as done only when the commit evidence strongly implies the task is actually completed.',
        '- Use review when code changed but QA, verification, or rollout confidence is incomplete.',
        '- If the evidence is thin, leave the task unchanged by omitting it.',
        '- If a contributor clearly owns related code, assign that task to their memberId when available.',
        '- Never invent member IDs.',
        '- If code introduced follow-up work, you may propose a new task with taskId null and a concrete title.',
        'Required JSON shape:',
        '{"summary":"string","readyToShip":true,"notes":["string"],"taskUpdates":[{"taskId":"string|null","title":"string","status":"todo|in_progress|review|done","assigneeMemberId":"string|null","reason":"string","confidence":"high|medium|low"}]}',
        `Project: ${project.name}`,
        `Project description: ${project.description || 'No description'}`,
        `Known project members:\n${projectMembers.results.length ? projectMembers.results.map((member) => `- ${member.id}: ${member.name}${member.email ? ` <${member.email}>` : ''}`).join('\n') : '- No project members assigned'}`,
        `Board items:\n${projectItems.results.length ? projectItems.results.map((item) => `- ${item.id} | ${item.kind} | ${item.title} | status:${normalizeTaskStatus(item.status)} | assignee:${item.assignee_id || 'unassigned'} | ${truncate(item.description || '', 120)}`).join('\n') : '- No board items yet'}`,
        `Matched GitHub authors to project members:\n${memberMatches.length ? memberMatches.map((match) => `- ${match.memberId}: ${match.memberName} <- ${match.login || match.email || match.matchedFrom}`).join('\n') : '- No confident author/member matches'}`,
        `Recent commits from ${repoRecord.fullName}:\n${syncedCommits
          .map((commit) =>
            [
              `- ${commit.sha.slice(0, 7)} by ${commit.authorName}${commit.authorLogin ? ` (@${commit.authorLogin})` : ''} on ${commit.committedAt}`,
              `  message: ${truncate(commit.message, 240)}`,
              `  diff: +${commit.additions} / -${commit.deletions}`,
              `  tasks: ${commit.extracted.tasks.join(' | ') || 'none'}`,
              `  issues: ${commit.extracted.issues.join(' | ') || 'none'}`,
              ...commit.fileSummary.map((line) => `  file: ${line}`),
            ].join('\n')
          )
          .join('\n')}`,
      ].join('\n')

      const aiResult = await generateTenantAiText(c.env, { tenantId, userId, userEmail }, {
        featureKey: 'integration.github_progress_review',
        system:
          'You audit GitHub progress against a project board. Be conservative, grounded, and return strict JSON only.',
        prompt: reviewPrompt,
        maxOutputTokens: 900,
        metadata: { projectId, repo: repoRecord.fullName, days, commitCount: syncedCommits.length },
      })

      const expectedReviewShape =
        '{"summary":"string","readyToShip":false,"notes":["string"],"taskUpdates":[{"taskId":"string|null","title":"string","status":"todo|in_progress|review|done","assigneeMemberId":"string|null","reason":"string","confidence":"high|medium|low"}]}'

      const parsed =
        parseJsonObject<{
          summary?: string
          readyToShip?: boolean
          notes?: string[]
          taskUpdates?: Array<{
            taskId?: string | null
            title?: string
            status?: string
            assigneeMemberId?: string | null
            reason?: string
            confidence?: 'high' | 'medium' | 'low'
          }>
        }>(aiResult.text) ||
        (await repairJsonObject<{
          summary?: string
          readyToShip?: boolean
          notes?: string[]
          taskUpdates?: Array<{
            taskId?: string | null
            title?: string
            status?: string
            assigneeMemberId?: string | null
            reason?: string
            confidence?: 'high' | 'medium' | 'low'
          }>
        }>(c.env, { tenantId, userId, userEmail }, {
          rawText: aiResult.text,
          shapeDescription: expectedReviewShape,
          metadata: { projectId, repo: repoRecord.fullName, mode: 'repair' },
        })) || {
          summary: truncate(aiResult.text, 260),
          readyToShip: false,
          notes: ['The GitHub review summary was returned in a messy format, so TaskCenter fell back to summary-only mode.'],
          taskUpdates: [],
        }

      const normalizedTaskUpdates = (parsed.taskUpdates || [])
        .map((update) => {
          const existingById = update.taskId ? itemById.get(update.taskId) : null
          const existingByTitle = !existingById && update.title ? itemByTitle.get(normalizeIdentity(update.title)) : null
          const matchedItem = existingById || existingByTitle || null
          const assigneeMemberId =
            update.assigneeMemberId && projectMembers.results.some((member) => member.id === update.assigneeMemberId)
              ? update.assigneeMemberId
              : null
          const confidence = update.confidence === 'high' || update.confidence === 'medium' || update.confidence === 'low'
            ? update.confidence
            : 'medium'
          const requestedStatus = normalizeTaskStatus(update.status)
          const status = requestedStatus === 'done' && confidence === 'low' ? 'review' : requestedStatus
          const title = matchedItem?.title || update.title?.trim() || null

          if (!title) return null

          return {
            taskId: matchedItem?.id || null,
            title,
            status,
            assigneeMemberId,
            reason: truncate(update.reason || 'Updated from recent GitHub progress evidence.', 220),
            confidence,
          }
        })
        .filter((update): update is { taskId: string | null; title: string; status: 'todo' | 'in_progress' | 'review' | 'done'; assigneeMemberId: string | null; reason: string; confidence: 'high' | 'medium' | 'low' } => Boolean(update))

      const actions = normalizedTaskUpdates.map((update) => ({
        type: 'task.upsert' as const,
        payload: {
          ...(update.taskId ? { id: update.taskId } : {}),
          title: update.title,
          status: update.status,
          assignees: update.assigneeMemberId ? [update.assigneeMemberId] : [],
        },
      }))

      const summary = parsed.summary?.trim() || `Reviewed ${syncedCommits.length} recent commit(s) from ${repoRecord.fullName}.`
      const notes = Array.isArray(parsed.notes) ? parsed.notes.map((note) => truncate(String(note), 220)).filter(Boolean) : []
      const containsNewTasks = normalizedTaskUpdates.some((update) => !update.taskId)
      const effectiveAutoApply = autoApply && !containsNewTasks

      if (autoApply && containsNewTasks) {
        notes.push('Auto-apply was skipped because the review proposed new tasks that still need human confirmation.')
      }

      let proposalId: string | null = null
      let proposalStatus: 'draft' | 'approved' | 'applied' | null = null

      if (actions.length > 0) {
        proposalId = newId('proposal')
        const now = Date.now()
        proposalStatus = effectiveAutoApply ? 'applied' : autoApprove ? 'approved' : 'draft'

        await c.env.DB.prepare(
          `INSERT INTO proposals (
            id, tenant_id, project_id, source, title, summary, status, impact_level, actions_json, diff_json,
            requested_by, approved_by, approved_at, rejected_by, rejected_at, applied_by, applied_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`
        )
          .bind(
            proposalId,
            tenantId,
            projectId,
            'integration',
            `GitHub progress review for ${repoRecord.fullName}`,
            summary,
            proposalStatus,
            normalizedTaskUpdates.some((update) => update.status === 'done') ? 'high' : 'medium',
            JSON.stringify(actions),
            JSON.stringify({
              repo: repoRecord.fullName,
              reviewedAt: new Date(now).toISOString(),
              matchedMembers: memberMatches,
              notes,
              taskUpdates: normalizedTaskUpdates,
              syncedCommits: syncedCommits.map((commit) => ({
                sha: commit.sha,
                authorName: commit.authorName,
                authorLogin: commit.authorLogin,
                committedAt: commit.committedAt,
              })),
              readyToShip: Boolean(parsed.readyToShip),
            }),
            userId,
            autoApprove || effectiveAutoApply ? userId : null,
            autoApprove || effectiveAutoApply ? now : null,
            effectiveAutoApply ? userId : null,
            effectiveAutoApply ? now : null,
            now,
            now
          )
          .run()

        await upsertAppMemoryEntry(c.env, {
          tenantId,
          projectId,
          sourceApp: 'taskcenter',
          sourceType: 'proposal',
          sourceKey: proposalId,
          title: `GitHub progress review for ${repoRecord.fullName}`,
          content: [summary, JSON.stringify(actions), JSON.stringify({ notes, taskUpdates: normalizedTaskUpdates })].join('\n'),
          summary: `${proposalStatus} proposal from GitHub progress review`,
          metadata: { status: proposalStatus, repo: repoRecord.fullName, readyToShip: Boolean(parsed.readyToShip) },
        }).catch(() => {})

        if (effectiveAutoApply) {
          await applyProposalActions(c.env, {
            tenantId,
            userId,
            projectId,
            actions,
          })
          await upsertProjectSearchIndex(c.env, {
            tenantId,
            projectId,
          })
        }
      }

      return c.json({
        ok: true,
        repo: repoRecord.fullName,
        syncedCommits: syncedCommits.length,
        summary,
        review: {
          readyToShip: Boolean(parsed.readyToShip),
          notes,
          taskUpdates: normalizedTaskUpdates,
        },
        matchedMembers: memberMatches,
        proposal: proposalId ? { id: proposalId, status: proposalStatus } : null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to review GitHub progress'
      return c.json({ error: 'github_progress_review_failed', message }, 500)
    }
  }
)

integrationsRoute.get(
  '/github/projects/:projectId/commits',
  zValidator('query', githubProjectCommitsQuerySchema),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const { projectId } = c.req.param()
    const { days = 14, memberId } = c.req.valid('query')

    const project = await ensureProjectExists(c.env, tenantId, projectId)
    if (!project) {
      return c.json({ error: 'project_not_found' }, 404)
    }

    const linkedRepo = await c.env.DB.prepare(
      `SELECT connection_id, repo_full_name, repo_owner, repo_name
       FROM project_github_links
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{ connection_id: string; repo_full_name: string; repo_owner: string; repo_name: string } | null>()

    if (!linkedRepo?.repo_owner || !linkedRepo?.repo_name) {
      return c.json(
        {
          error: 'github_repo_required',
          message: 'Connect a GitHub repository to this project before using project diffs or code review.',
        },
        400
      )
    }

    const githubConnection =
      (linkedRepo.connection_id ? await getGitHubConnectionById(c.env, tenantId, linkedRepo.connection_id) : null) ||
      (await getGitHubConnection(c.env, tenantId, userId))
    if (!githubConnection) {
      return c.json({ error: 'github_not_connected', message: 'GitHub access is required before TaskCenter can load project diffs.' }, 400)
    }

    const [repoRecord, projectMembers] = await Promise.all([
      ensureGitHubRepoRecord(c.env, {
        tenantId,
        connectionId: githubConnection.connectionId,
        accessToken: githubConnection.accessToken,
        owner: linkedRepo.repo_owner,
        repo: linkedRepo.repo_name,
      }),
      c.env.DB.prepare(
        `SELECT
           u.id,
           COALESCE(u.name, u.email, u.id) AS name,
           u.email
         FROM project_member_assignments pma
         JOIN users u ON u.id = pma.member_id AND u.tenant_id = pma.tenant_id
         WHERE pma.tenant_id = ? AND pma.project_id = ?
         ORDER BY pma.updated_at DESC`
      )
        .bind(tenantId, projectId)
        .all<ProjectMember>(),
    ])

    const syncedCommits = await syncGitHubCommitsForRepo(c.env, {
      tenantId,
      connectionId: githubConnection.connectionId,
      repoId: repoRecord.id,
      accessToken: githubConnection.accessToken,
      owner: linkedRepo.repo_owner,
      repo: linkedRepo.repo_name,
      days,
      limit: 30,
    })

    const commits = syncedCommits
      .map((commit) => {
        const matchedMember = matchProjectMember(projectMembers.results, {
          name: commit.authorName,
          email: commit.authorEmail,
          login: commit.authorLogin,
        })
        return {
          sha: commit.sha,
          message: commit.message,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          authorLogin: commit.authorLogin,
          committedAt: commit.committedAt,
          additions: commit.additions,
          deletions: commit.deletions,
          files: commit.files,
          fileSummary: commit.fileSummary,
          extracted: commit.extracted,
          matchedMember: matchedMember
            ? { id: matchedMember.id, name: matchedMember.name, email: matchedMember.email }
            : null,
        }
      })
      .filter((commit) => !memberId || commit.matchedMember?.id === memberId)

    return c.json({
      ok: true,
      repo: repoRecord.fullName,
      linked: true,
      commits,
      members: projectMembers.results,
    })
  }
)

integrationsRoute.get('/github/projects/:projectId/repo-runs', async (c) => {
  const tenantId = c.get('tenantId')
  const { projectId } = c.req.param()
  const project = await ensureProjectExists(c.env, tenantId, projectId)
  if (!project) {
    return c.json({ error: 'project_not_found' }, 404)
  }

  const runs = await c.env.DB.prepare(
    `SELECT id, repo_full_name, branch_name, base_branch, status, commit_message, pr_title, external_run_id,
            logs_json, result_json, error_message, created_at, updated_at, started_at, completed_at
     FROM project_repo_runs
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(tenantId, projectId)
    .all<{
      id: string
      repo_full_name: string
      branch_name: string
      base_branch: string
      status: string
      commit_message: string | null
      pr_title: string | null
      external_run_id: string | null
      logs_json: string | null
      result_json: string | null
      error_message: string | null
      created_at: number
      updated_at: number
      started_at: number | null
      completed_at: number | null
    }>()

  return c.json({
    runs: runs.results.map((run) => ({
      id: run.id,
      repoFullName: run.repo_full_name,
      branchName: run.branch_name,
      baseBranch: run.base_branch,
      status: run.status,
      commitMessage: run.commit_message,
      prTitle: run.pr_title,
      externalRunId: run.external_run_id,
      logs: run.logs_json ? JSON.parse(run.logs_json) : [],
      result: run.result_json ? JSON.parse(run.result_json) : null,
      errorMessage: run.error_message,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    })),
  })
})

integrationsRoute.post(
  '/github/projects/:projectId/repo-runs',
  zValidator('json', githubRepoRunCreateSchema),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const { projectId } = c.req.param()
    const payload = c.req.valid('json')

    const project = await ensureProjectExists(c.env, tenantId, projectId)
    if (!project) {
      return c.json({ error: 'project_not_found' }, 404)
    }

    const linkedRepo = await c.env.DB.prepare(
      `SELECT connection_id, repo_full_name, repo_owner, repo_name
       FROM project_github_links
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{ connection_id: string; repo_full_name: string; repo_owner: string; repo_name: string } | null>()

    if (!linkedRepo?.repo_owner || !linkedRepo?.repo_name) {
      return c.json({ error: 'github_repo_required', message: 'Connect a GitHub repository before starting repo runs.' }, 400)
    }

    const githubConnection =
      (linkedRepo.connection_id ? await getGitHubConnectionById(c.env, tenantId, linkedRepo.connection_id) : null) ||
      (await getGitHubConnection(c.env, tenantId, userId))
    if (!githubConnection?.accessToken) {
      return c.json({ error: 'github_not_connected', message: 'GitHub access is required before starting repo runs.' }, 400)
    }

    if (!c.env.REPO_RUNNER_URL || !c.env.REPO_RUNNER_SECRET) {
      return c.json(
        {
          error: 'repo_runner_not_configured',
          message: 'The repo runner is not configured yet. Set REPO_RUNNER_URL and REPO_RUNNER_SECRET first.',
        },
        503
      )
    }

    const now = Date.now()
    const runId = newId('run')
    const baseBranch = payload.baseBranch?.trim() || 'main'
    const branchName = payload.branchName?.trim() || `codex/${projectId.slice(-6)}-${now}`
    await c.env.DB.prepare(
      `INSERT INTO project_repo_runs (
        id, tenant_id, project_id, created_by, connection_id, repo_full_name, branch_name, base_branch,
        status, requested_files_json, build_commands_json, commit_message, pr_title, pr_body,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        runId,
        tenantId,
        projectId,
        userId,
        githubConnection.connectionId,
        linkedRepo.repo_full_name,
        branchName,
        baseBranch,
        JSON.stringify(payload.files),
        JSON.stringify(payload.buildCommands || []),
        payload.commitMessage,
        payload.prTitle,
        payload.prBody || null,
        now,
        now
      )
      .run()

    const callbackBase = c.env.PUBLIC_APP_URL || new URL(c.req.url).origin
    const callbackUrl = `${callbackBase.replace(/\/$/, '')}/api/runtime/github/runs/${runId}/callback`

    const runnerResponse = await fetch(new URL('/runs', c.env.REPO_RUNNER_URL).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-taskcenter-runner-secret': c.env.REPO_RUNNER_SECRET,
      },
      body: JSON.stringify({
        runId,
        callbackUrl,
        callbackSecret: c.env.REPO_RUNNER_SECRET,
        repoFullName: linkedRepo.repo_full_name,
        baseBranch,
        branchName,
        files: payload.files,
        buildCommands: payload.buildCommands || [],
        commitMessage: payload.commitMessage,
        prTitle: payload.prTitle,
        prBody: payload.prBody || '',
        githubAccessToken: githubConnection.accessToken,
      }),
    }).catch((error) => error)

    if (!(runnerResponse instanceof Response) || !runnerResponse.ok) {
      const message =
        runnerResponse instanceof Response
          ? await runnerResponse.text().catch(() => 'Runner request failed.')
          : runnerResponse instanceof Error
            ? runnerResponse.message
            : 'Runner request failed.'
      await c.env.DB.prepare(
        `UPDATE project_repo_runs SET status = 'failed', error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`
      )
        .bind(message.slice(0, 1200), Date.now(), Date.now(), runId)
        .run()
      return c.json({ error: 'repo_runner_dispatch_failed', message }, 502)
    }

    const runnerJson = (await runnerResponse.json().catch(() => null)) as { externalRunId?: string; accepted?: boolean } | null
    await c.env.DB.prepare(
      `UPDATE project_repo_runs
       SET status = 'dispatched', external_run_id = ?, updated_at = ?, started_at = ?
       WHERE id = ?`
    )
      .bind(runnerJson?.externalRunId || null, Date.now(), Date.now(), runId)
      .run()

    return c.json({
      ok: true,
      run: {
        id: runId,
        repoFullName: linkedRepo.repo_full_name,
        branchName,
        baseBranch,
        status: 'dispatched',
        externalRunId: runnerJson?.externalRunId || null,
      },
    })
  }
)

// Get contributors for assignment suggestions
integrationsRoute.get('/github/repos/:owner/:repo/contributors', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { owner, repo } = c.req.param()
  
  const conn = await c.env.DB.prepare(`
    SELECT sc.id, sc.access_token, gr.id as repo_id 
    FROM service_connections sc
    JOIN github_repos gr ON gr.connection_id = sc.id
    WHERE sc.tenant_id = ? AND sc.user_id = ? AND sc.service_type = 'github' 
    AND gr.full_name = ? AND sc.is_active = true
    LIMIT 1
  `).bind(tenantId, userId, `${owner}/${repo}`).first()
  
  if (!conn) {
    return c.json({ error: 'Repo not found' }, 400)
  }
  
  try {
    const githubAccessToken = await decryptConnectionSecret(c.env, (conn as { access_token?: string | null }).access_token)
    // Get contributors from GitHub API
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`, {
      headers: { Authorization: `Bearer ${githubAccessToken}` }
    })
    const contributors = await res.json() as Array<{
      id: number
      login: string
      avatar_url: string
      contributions: number
    }>
    
    // Get detailed user info and recent activity
    const detailedContributors = await Promise.all(
      contributors.slice(0, 20).map(async (contributor) => {
        // Get user's recent commits to analyze skills
        const commitsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?author=${contributor.login}&per_page=30`, {
          headers: { Authorization: `Bearer ${githubAccessToken}` }
        })
        const commits = await commitsRes.json() as Array<{ commit: { message: string }; files?: Array<{ filename: string }> }>
        
        // Analyze file patterns
        const filePatterns = analyzeFilePatterns(commits.flatMap(com => com.files?.map(f => f.filename) || []))
        const skills = extractSkillsFromCommits(commits.map(com => com.commit.message))
        
        // Store/update contributor
        await c.env.DB.prepare(`
          INSERT INTO github_contributors (
            connection_id, tenant_id, repo_id, github_user_id, login, avatar_url,
            commits_count, top_languages, top_directories, extracted_skills, last_commit_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id, login) DO UPDATE SET
            commits_count = ?, top_languages = ?, top_directories = ?, extracted_skills = ?, last_commit_at = ?
        `).bind(
          conn.id, tenantId, conn.repo_id, contributor.id, contributor.login, contributor.avatar_url,
          contributor.contributions, JSON.stringify(filePatterns.languages), JSON.stringify(filePatterns.directories),
          JSON.stringify(skills), commits[0]?.commit ? new Date().toISOString() : null,
          contributor.contributions, JSON.stringify(filePatterns.languages), JSON.stringify(filePatterns.directories),
          JSON.stringify(skills), commits[0]?.commit ? new Date().toISOString() : null
        ).run()

        await upsertAppMemoryEntry(c.env, {
          tenantId,
          sourceApp: 'github',
          sourceType: 'contributor',
          sourceKey: `${owner}/${repo}:${contributor.login}`,
          title: contributor.login,
          content: [
            `repo:${owner}/${repo}`,
            `contributions:${contributor.contributions}`,
            `skills:${skills.join(', ')}`,
            `languages:${filePatterns.languages.join(', ')}`,
            `directories:${filePatterns.directories.join(', ')}`,
          ].join('\n'),
          summary: `GitHub contributor for ${owner}/${repo}`,
          metadata: { repo: `${owner}/${repo}` },
        }).catch(() => {})
        
        return {
          login: contributor.login,
          contributions: contributor.contributions,
          skills,
          filePatterns
        }
      })
    )
    
    return c.json({ contributors: detailedContributors })
  } catch (err) {
    return c.json({ error: 'Failed to fetch contributors' }, 500)
  }
})

// ==================== JIRA INTEGRATION ====================

// Connect Jira (OAuth 2.0 or API token)
integrationsRoute.post('/jira/connect', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { access_token, service_url, account_id, account_email, account_name } = await c.req.json()
  
  try {
    const encryptedJiraToken = await encryptStoredSecret(c.env, access_token)
    await c.env.DB.prepare(`
      INSERT INTO service_connections 
      (tenant_id, user_id, service_type, access_token, service_url, service_account_id, service_account_email, service_account_name, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, true)
      ON CONFLICT(tenant_id, service_type, service_account_id) 
      DO UPDATE SET access_token = ?, service_url = ?, updated_at = datetime('now'), is_active = true
    `).bind(
      tenantId, userId, 'jira', encryptedJiraToken, service_url, account_id, account_email, account_name,
      encryptedJiraToken, service_url
    ).run()
    
    return c.json({ connected: true, account: account_name || account_email })
  } catch (err) {
    return c.json({ error: 'Failed to connect Jira' }, 500)
  }
})

// Get Jira projects
integrationsRoute.get('/jira/projects', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  
  const conn = await c.env.DB.prepare(`
    SELECT id, access_token, service_url FROM service_connections 
    WHERE tenant_id = ? AND user_id = ? AND service_type = 'jira' AND is_active = true
    LIMIT 1
  `).bind(tenantId, userId).first()
  
  if (!conn) {
    return c.json({ error: 'Jira not connected' }, 400)
  }
  
  try {
    const jiraAccessToken = await decryptConnectionSecret(c.env, (conn as { access_token?: string | null }).access_token)
    const res = await fetch(`${conn.service_url}/rest/api/3/project`, {
      headers: { Authorization: `Bearer ${jiraAccessToken}`, Accept: 'application/json' }
    })
    const projects = await res.json() as Array<{
      id: string
      key: string
      name: string
      description?: string
      projectTypeKey: string
      lead?: { accountId: string; displayName: string }
    }>
    
    // Sync to database
    for (const project of projects) {
      await c.env.DB.prepare(`
        INSERT INTO jira_projects (connection_id, tenant_id, jira_project_id, key, name, description, project_type, url, lead_account_id, lead_display_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, key) 
        DO UPDATE SET name = ?, description = ?, lead_account_id = ?, lead_display_name = ?, synced_at = datetime('now')
      `).bind(
        conn.id, tenantId, project.id, project.key, project.name, project.description || '',
        project.projectTypeKey, `${conn.service_url}/browse/${project.key}`,
        project.lead?.accountId || '', project.lead?.displayName || '',
        project.name, project.description || '', project.lead?.accountId || '', project.lead?.displayName || ''
      ).run()

      await upsertAppMemoryEntry(c.env, {
        tenantId,
        sourceApp: 'jira',
        sourceType: 'project',
        sourceKey: project.key,
        title: `${project.key}: ${project.name}`,
        content: [
          project.description || '',
          `projectType:${project.projectTypeKey}`,
          `lead:${project.lead?.displayName || ''}`,
        ].filter(Boolean).join('\n'),
        summary: project.description || 'Jira project',
        metadata: { key: project.key },
      }).catch(() => {})
    }
    
    return c.json({ projects: projects.map(p => ({ id: p.id, key: p.key, name: p.name })) })
  } catch (err) {
    return c.json({ error: 'Failed to fetch Jira projects' }, 500)
  }
})

// Get Jira issues with analysis
integrationsRoute.get('/jira/projects/:key/issues', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const { key } = c.req.param()
  const status = c.req.query('status') || 'In Progress'
  
  const conn = await c.env.DB.prepare(`
    SELECT sc.id, sc.access_token, sc.service_url, jp.id as project_id
    FROM service_connections sc
    JOIN jira_projects jp ON jp.connection_id = sc.id
    WHERE sc.tenant_id = ? AND sc.user_id = ? AND sc.service_type = 'jira' 
    AND jp.key = ? AND sc.is_active = true
    LIMIT 1
  `).bind(tenantId, userId, key).first()
  
  if (!conn) {
    return c.json({ error: 'Jira project not found' }, 400)
  }
  
  try {
    const jiraAccessToken = await decryptConnectionSecret(c.env, (conn as { access_token?: string | null }).access_token)
    // JQL query for issues
    const jql = `project = "${key}" ${status ? `AND status = "${status}"` : ''} ORDER BY updated DESC`
    const res = await fetch(`${conn.service_url}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=all`, {
      headers: { Authorization: `Bearer ${jiraAccessToken}`, Accept: 'application/json' }
    })
    const data = await res.json() as { issues: Array<{
      id: string
      key: string
      fields: {
        summary: string
        description?: { content?: Array<{ content?: Array<{ text?: string }> }> }
        status: { name: string; statusCategory?: { name: string } }
        priority?: { name: string }
        assignee?: { accountId: string; displayName: string; emailAddress?: string }
        reporter?: { accountId: string; displayName: string }
        issuetype: { name: string }
        parent?: { key: string; fields?: { summary: string } }
        customfield_10016?: number // story points
        timeestimate?: number
        timespent?: number
        created: string
        updated: string
        duedate?: string
        resolutiondate?: string
        sprint?: { name: string; id: string }
      }
    }> }
    
    const processed = []
    for (const issue of data.issues) {
      const f = issue.fields
      const description = extractTextFromJiraDoc(f.description)
      
      // Extract insights from description
      const extracted = extractRequirementsFromText(description)
      
      await c.env.DB.prepare(`
        INSERT INTO jira_issues (
          connection_id, tenant_id, project_id, jira_issue_id, key, issue_type, summary, description,
          status, status_category, priority, assignee_account_id, assignee_display_name,
          epic_key, epic_name, story_points, time_estimate_seconds, time_spent_seconds,
          created_at, updated_at, due_date, resolved_at, extracted_requirements, extracted_acceptance_criteria
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, key) DO UPDATE SET
          summary = ?, status = ?, status_category = ?, assignee_account_id = ?, assignee_display_name = ?,
          story_points = ?, time_spent_seconds = ?, updated_at = ?, resolved_at = ?, extracted_requirements = ?
      `).bind(
        conn.id, tenantId, conn.project_id, issue.id, issue.key, f.issuetype.name,
        f.summary, description, f.status.name, f.status.statusCategory?.name || '',
        f.priority?.name || '', f.assignee?.accountId || '', f.assignee?.displayName || '',
        f.parent?.key || '', f.parent?.fields?.summary || '',
        f.customfield_10016 || null, f.timeestimate || null, f.timespent || null,
        f.created, f.updated, f.duedate || null, f.resolutiondate || null,
        JSON.stringify(extracted.requirements), JSON.stringify(extracted.acceptanceCriteria),
        f.summary, f.status.name, f.status.statusCategory?.name || '', f.assignee?.accountId || '',
        f.assignee?.displayName || '', f.customfield_10016 || null, f.timespent || null,
        f.updated, f.resolutiondate || null, JSON.stringify(extracted.requirements)
      ).run()

      await upsertAppMemoryEntry(c.env, {
        tenantId,
        sourceApp: 'jira',
        sourceType: 'issue',
        sourceKey: issue.key,
        title: `${issue.key}: ${f.summary}`,
        content: [
          description,
          `type:${f.issuetype.name}`,
          `status:${f.status.name}`,
          `assignee:${f.assignee?.displayName || 'Unassigned'}`,
          `requirements:${extracted.requirements.join(' | ')}`,
          `acceptance:${extracted.acceptanceCriteria.join(' | ')}`,
        ].filter(Boolean).join('\n'),
        summary: `${f.issuetype.name} · ${f.status.name}`,
        metadata: { projectKey: key, updatedAt: f.updated },
      }).catch(() => {})
      
      processed.push({
        key: issue.key,
        summary: f.summary,
        type: f.issuetype.name,
        status: f.status.name,
        assignee: f.assignee?.displayName || 'Unassigned',
        storyPoints: f.customfield_10016,
        extracted
      })
    }
    
    return c.json({ issues: processed, count: processed.length })
  } catch (err) {
    return c.json({ error: 'Failed to fetch Jira issues' }, 500)
  }
})

// ==================== ANALYSIS ENDPOINTS ====================

// Generate planning context from all connected data
integrationsRoute.get('/planning-context', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  
  // Get all recent activity
  const [recentCommits, activeIssues, contributors] = await Promise.all([
    // Recent commits (last 30 days)
    c.env.DB.prepare(`
      SELECT gc.*, gr.full_name as repo_name
      FROM github_commits gc
      JOIN github_repos gr ON gr.id = gc.repo_id
      WHERE gc.tenant_id = ? AND gc.committed_at >= datetime('now', '-30 days')
      ORDER BY gc.committed_at DESC
      LIMIT 50
    `).bind(tenantId).all(),
    
    // Active Jira issues
    c.env.DB.prepare(`
      SELECT ji.*, jp.key as project_key, jp.name as project_name
      FROM jira_issues ji
      JOIN jira_projects jp ON jp.id = ji.project_id
      WHERE ji.tenant_id = ? AND ji.status_category IN ('To Do', 'In Progress')
      ORDER BY ji.updated_at DESC
      LIMIT 50
    `).bind(tenantId).all(),
    
    // Contributors with skills
    c.env.DB.prepare(`
      SELECT gc.login, gc.name, gc.email, gc.extracted_skills, gc.top_languages, 
             gc.commits_count, gc.last_commit_at
      FROM github_contributors gc
      JOIN service_connections sc ON sc.id = gc.connection_id
      WHERE sc.tenant_id = ? AND sc.is_active = true
      ORDER BY gc.commits_count DESC
    `).bind(tenantId).all()
  ])
  
  // Aggregate insights
  const techStack = extractTechStackFromCommits(recentCommits.results as Array<{ extracted_tasks?: string }>)
  const workloadByPerson = calculateWorkload(activeIssues.results as Array<{ assignee_display_name?: string; story_points?: number }>)
  
  const context = {
    summary: {
      activeRepos: [...new Set((recentCommits.results as Array<{ repo_name: string }>).map(c => c.repo_name))].length,
      commitsLast30Days: recentCommits.results.length,
      activeIssues: activeIssues.results.length,
      contributors: contributors.results.length
    },
    techStack,
    workloadByPerson,
    recentActivity: (recentCommits.results as Array<{ message: string; author_name: string; committed_at: string }>).slice(0, 10).map(c => ({
      what: c.message.substring(0, 80),
      who: c.author_name,
      when: c.committed_at
    })),
    suggestedAssignments: suggestAssignments(
      activeIssues.results as Array<{ issue_type: string; extracted_requirements?: string }>,
      contributors.results as Array<{ login: string; extracted_skills?: string }>
    )
  }
  
  return c.json(context)
})

// ==================== HELPER FUNCTIONS ====================

function extractWorkInsights(message: string, files: string[]): { tasks: string[]; epics: string[]; issues: string[] } {
  // Extract issue references like #123, PROJ-456
  const issueRefs = message.match(/#[\d]+|[A-Z]+-\d+/g) || []
  
  // Extract likely task descriptions from commit message
  const tasks = message.split('\n')
    .filter(line => line.trim().startsWith('- ') || line.trim().startsWith('* '))
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(line => line.length > 10)
  
  // Infer epic from file paths
  const directories = [...new Set(files.map(f => f.split('/')[0]).filter(d => !d.includes('.')))]
  
  return {
    tasks: tasks.length > 0 ? tasks : [message.split('\n')[0].substring(0, 100)],
    epics: directories,
    issues: issueRefs
  }
}

function analyzeFilePatterns(files: string[]): { languages: string[]; directories: string[] } {
  const extensions = files.map(f => f.split('.').pop()).filter(Boolean) as string[]
  const extCounts: Record<string, number> = {}
  extensions.forEach(ext => { extCounts[ext] = (extCounts[ext] || 0) + 1 })
  
  const languages = Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext]) => ext)
  
  const dirs = files.map(f => f.split('/')[0]).filter(d => d && !d.includes('.'))
  const dirCounts: Record<string, number> = {}
  dirs.forEach(d => { dirCounts[d] = (dirCounts[d] || 0) + 1 })
  
  const directories = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dir]) => dir)
  
  return { languages, directories }
}

function extractSkillsFromCommits(messages: string[]): string[] {
  const skills: Record<string, number> = {}
  const skillPatterns: Record<string, string[]> = {
    'API Design': ['api', 'endpoint', 'rest', 'graphql', 'swagger'],
    'Database': ['database', 'db', 'migration', 'schema', 'sql', 'postgres'],
    'Frontend': ['ui', 'component', 'react', 'vue', 'css', 'html'],
    'Testing': ['test', 'spec', 'jest', 'cypress', 'unit test'],
    'DevOps': ['deploy', 'docker', 'ci/cd', 'github actions', 'terraform'],
    'Security': ['auth', 'security', 'oauth', 'jwt', 'encrypt'],
    'Performance': ['optimize', 'cache', 'performance', 'speed', 'memory'],
    'Mobile': ['mobile', 'ios', 'android', 'react native', 'flutter']
  }
  
  messages.forEach(msg => {
    const lower = msg.toLowerCase()
    Object.entries(skillPatterns).forEach(([skill, patterns]) => {
      if (patterns.some(p => lower.includes(p))) {
        skills[skill] = (skills[skill] || 0) + 1
      }
    })
  })
  
  return Object.entries(skills)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([skill]) => skill)
}

function extractTextFromJiraDoc(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return ''
  const d = doc as { content?: Array<{ content?: Array<{ text?: string; content?: Array<{ text?: string }> }> }> }
  if (!d.content) return ''
  
  return d.content
    .flatMap(c => c.content || [])
    .flatMap(c => c.content || [])
    .map(c => c.text || '')
    .join(' ')
}

function extractRequirementsFromText(text: string): { requirements: string[]; acceptanceCriteria: string[] } {
  const lines = text.split('\n')
  
  const requirements = lines
    .filter(l => l.match(/^(must|should|needs? to|requirement)/i) || l.includes('shall'))
    .map(l => l.trim())
  
  const acceptanceCriteria = lines
    .filter(l => l.match(/^(given|when|then|acceptance|scenario)/i))
    .map(l => l.trim())
  
  return { requirements, acceptanceCriteria }
}

function extractTechStackFromCommits(commits: Array<{ extracted_tasks?: string }>): string[] {
  const stack: Record<string, number> = {}
  const keywords = ['react', 'vue', 'angular', 'node', 'python', 'go', 'rust', 'postgres', 'redis', 'docker', 'kubernetes', 'aws', 'gcp', 'azure']
  
  commits.forEach(c => {
    const text = (c.extracted_tasks || '').toLowerCase()
    keywords.forEach(kw => {
      if (text.includes(kw)) stack[kw] = (stack[kw] || 0) + 1
    })
  })
  
  return Object.entries(stack)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tech]) => tech)
}

function calculateWorkload(issues: Array<{ assignee_display_name?: string; story_points?: number }>): Record<string, { issues: number; storyPoints: number }> {
  const workload: Record<string, { issues: number; storyPoints: number }> = {}
  
  issues.forEach(issue => {
    const name = issue.assignee_display_name || 'Unassigned'
    if (!workload[name]) {
      workload[name] = { issues: 0, storyPoints: 0 }
    }
    workload[name].issues++
    workload[name].storyPoints += issue.story_points || 0
  })
  
  return workload
}

function suggestAssignments(
  issues: Array<{ issue_type: string; extracted_requirements?: string }>,
  contributors: Array<{ login: string; extracted_skills?: string }>
): Array<{ issueType: string; suggestedAssignees: string[]; reasoning: string }> {
  const assignments: Array<{ issueType: string; suggestedAssignees: string[]; reasoning: string }> = []
  
  const typeToSkill: Record<string, string[]> = {
    'Bug': ['Testing', 'API Design', 'Database'],
    'Story': ['Frontend', 'API Design'],
    'Task': ['DevOps', 'Database'],
    'Epic': ['API Design', 'Frontend', 'Database']
  }
  
  Object.entries(typeToSkill).forEach(([issueType, skills]) => {
    const matching = contributors.filter(c => {
      const cSkills = JSON.parse(c.extracted_skills || '[]') as string[]
      return skills.some(s => cSkills.includes(s))
    }).map(c => c.login)
    
    assignments.push({
      issueType,
      suggestedAssignees: matching.slice(0, 3),
      reasoning: `Based on skills: ${skills.join(', ')}`
    })
  })
  
  return assignments
}

export default integrationsRoute

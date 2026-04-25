import { newId } from './ids'
import type { EnvBindings } from './context'
import { getUsageSnapshot } from './usage'
import { generateTenantAiText } from '../agents/orchestrator'

type CompanyRow = {
  id: string
  tenant_id: string
  canonical_project_id: string | null
  name: string
  description: string | null
  status: string
  issue_prefix: string | null
  brand_color: string | null
  created_by: string
  created_at: number
  updated_at: number
}

type WorkstreamRow = {
  id: string
  tenant_id: string
  company_id: string
  project_id: string
  name: string
  description: string | null
  status: string
  is_default: number
  created_by: string
  created_at: number
  updated_at: number
  github_repo_full_name: string | null
  github_collaboration_mode: 'agent_build' | 'collaborative_review' | null
  github_review_on_push: number | null
}

export type CompanyRecord = {
  id: string
  name: string
  description: string | null
  status: string
  issuePrefix: string | null
  brandColor: string | null
  canonicalProjectId: string | null
  createdAt: number
  updatedAt: number
  workstreamCount: number
  threadCount: number
  executionCount: number
}

export type CompanyWorkstreamRecord = {
  id: string
  companyId: string
  projectId: string
  name: string
  description: string | null
  status: string
  isDefault: boolean
  githubRepoFullName: string | null
  githubCollaborationMode: 'agent_build' | 'collaborative_review' | null
  githubReviewOnPush: number | null
  createdAt: number
  updatedAt: number
}

type CompanyAgentRow = {
  id: string
  company_id: string
  user_id: string | null
  role_key: string
  title: string
  description: string | null
  wakeup_policy_json: string | null
  runtime_policy_json: string | null
  created_at: number
  updated_at: number
}

type CompanyGoalRow = {
  id: string
  company_id: string
  title: string
  description: string | null
  status: string
  created_at: number
  updated_at: number
}

type CompanyRoutineRow = {
  id: string
  company_id: string
  title: string
  description: string | null
  wakeup_type: string
  schedule_json: string | null
  status: string
  created_at: number
  updated_at: number
}

type CompanyApprovalRow = {
  id: string
  company_id: string
  source_type: string
  source_id: string | null
  status: string
  title: string
  summary: string | null
  payload_json: string | null
  requested_by: string
  decided_by: string | null
  decided_at: number | null
  created_at: number
  updated_at: number
}

type CompanyActivityRow = {
  id: string
  company_id: string
  project_id: string | null
  category: string
  severity: string
  message: string
  metadata_json: string | null
  created_at: number
}

type CompanyIssueRow = {
  id: string
  project_id: string
  project_name: string | null
  workstream_name: string | null
  kind: string
  title: string
  description: string | null
  status: string
  issue_key: string | null
  priority: string | null
  goal_id: string | null
  goal_title: string | null
  execution_mode: string
  assignee_id: string | null
  approver_id: string | null
  updated_at: number
}

function safeJsonParse<T>(input: string | null, fallback: T): T {
  if (!input) return fallback
  try {
    return JSON.parse(input) as T
  } catch {
    return fallback
  }
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
      markdown: `# ${companyName}

This company operates inside TaskCenter as a human-plus-agent delivery system.

## Mission model
- Companies own goals, issues, org structure, approvals, costs, and execution posture.
- Workstreams are the delivery surfaces for repo work, planning, reviews, and operations.
- Every issue should tie back to a real goal, workstream, or approval context.

## Operating rules
- Backend routes are the source of truth for durable state, execution, usage, and billing.
- Northstar stages proposals, pending actions, approvals, and execution sessions instead of silently mutating work.
- Conversation should stay attached to work objects: company, workstream, issue, approval, or execution session.
- Outputs matter more than prose. Prefer evidence, artifacts, checkpoints, and review posture over vague status language.

## Human and agent collaboration
- Humans can work directly in the product, through GitHub, or through Bridge on a local machine.
- Agents can prepare, continue, or take over work when the execution mode and approval policy allow it.
- Successful autonomous work should usually land in review, not done, unless explicit approval allows autonomous completion.

## UX stance
- Treat issues as the main unit of delivery work.
- Keep summaries short, then show deeper evidence, activity, and artifacts underneath.
- Prefer function-based navigation and operating views over generic messaging surfaces.
`,
      summary: 'Company mission, issue-first control-plane rules, and human-plus-agent operating model.',
    }
  }

  return {
    title: 'AGENTS.md',
    markdown: `# ${companyName} Agents

## Shared rules for every agent
- You are part of an operating company, not a standalone chatbot.
- Stay attached to the current company, workstream, issue, approval, or execution session whenever possible.
- Do not claim a durable change landed unless TaskCenter recorded it.
- Prefer issue-first behavior: clarify the issue, the owner, the goal, the evidence, and the next review boundary.
- If the work is larger than one response, break it into staged execution: plan, proposal, execution, review.
- Default to progressive disclosure:
  1. short operating summary
  2. concrete next actions or checkpoints
  3. evidence, logs, artifacts, or raw detail

## Roles

### CEO
- Reprioritizes based on company goals, approvals, costs, and blockers.
- Speaks in terms of outcomes, tradeoffs, and company posture.

### Operator
- Converts requests into workstreams, issues, proposals, assignments, and follow-up actions.
- Keeps the work graph clean and routed to the right human or agent.

### Reviewer
- Checks evidence before something is called complete.
- Looks for regressions, missing proof, ownership gaps, and review risk.

### Executor
- Launches approved work through Cloudflare execution or Bridge-backed local execution.
- Reports checkpoints, artifacts, and status honestly. Never oversell completion.

### Planner
- Breaks larger requests into reviewable scopes with dependencies and ownership.
- Uses goal -> workstream -> issue ancestry to keep work aligned.

## Runtime rules
- Prefer company- or work-attached threads over detached chat.
- Treat humans and agents as teammates with different strengths.
- Human work can continue locally and sync back through GitHub or Bridge.
- Agent work should be visible, reviewable, and evidence-backed.
`,
    summary: 'Role instructions for CEO/operator/reviewer/executor/planner with issue-first execution policy.',
  }
}

function defaultCompanyLeadership(companyId: string) {
  return [
    {
      roleKey: 'ceo',
      title: 'CEO',
      description: 'Keeps company goals, approvals, org posture, and delivery focus aligned.',
      wakeupPolicy: { mode: 'on_demand', scope: 'company', companyId },
      runtimePolicy: { defaultThreadScope: 'company', approvalsRequired: true, issueFirst: true, outputFirst: true },
    },
  ]
}

async function ensureDefaultCompanyLeadership(
  env: EnvBindings,
  input: { tenantId: string; companyId: string; createdBy: string; createdAt: number; updatedAt: number }
) {
  for (const agent of defaultCompanyLeadership(input.companyId)) {
    const existing = await env.DB.prepare(
      `SELECT id
       FROM company_agents
       WHERE tenant_id = ? AND company_id = ? AND role_key = ?
       LIMIT 1`
    )
      .bind(input.tenantId, input.companyId, agent.roleKey)
      .first<{ id: string } | null>()
    if (existing) continue

    await env.DB.prepare(
      `INSERT INTO company_agents (
        id, tenant_id, company_id, user_id, role_key, title, description, wakeup_policy_json, runtime_policy_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        newId('cagt'),
        input.tenantId,
        input.companyId,
        agent.roleKey,
        agent.title,
        agent.description,
        JSON.stringify(agent.wakeupPolicy),
        JSON.stringify(agent.runtimePolicy),
        input.createdBy,
        input.createdAt,
        input.updatedAt
      )
      .run()
  }
}

async function ensureInitialHireApproval(
  env: EnvBindings,
  input: { tenantId: string; companyId: string; requestedBy: string; createdAt: number; updatedAt: number }
) {
  const existing = await env.DB.prepare(
    `SELECT id
     FROM company_approvals
     WHERE tenant_id = ? AND company_id = ? AND source_type = 'agent_hire' AND title = ?
     LIMIT 1`
  )
    .bind(input.tenantId, input.companyId, 'Hire Agent: Founding Engineer')
    .first<{ id: string } | null>()
  if (existing) return

  await env.DB.prepare(
    `INSERT INTO company_approvals (
      id, tenant_id, company_id, source_type, source_id, status, title, summary, payload_json, requested_by, created_at, updated_at
    ) VALUES (?, ?, ?, 'agent_hire', NULL, 'pending', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('capr'),
      input.tenantId,
      input.companyId,
      'Hire Agent: Founding Engineer',
      'Pending hire requested by CEO.',
      JSON.stringify({
        roleKey: 'executor',
        title: 'Founding Engineer',
        provider: 'Codex',
        description: 'Builds and ships the first working slices of the product.',
        wakeupPolicy: { mode: 'on_demand', scope: 'execution', companyId: input.companyId },
        runtimePolicy: { executionModes: ['ai_assisted', 'ai_autonomous'], outputFirst: true, reviewOnSuccess: true },
      }),
      input.requestedBy,
      input.createdAt,
      input.updatedAt
    )
    .run()
}

async function ensureInstructionBundles(
  env: EnvBindings,
  input: { tenantId: string; companyId: string; companyName: string; createdBy: string; createdAt: number; updatedAt: number }
) {
  for (const bundleKey of ['company', 'agents']) {
    const bundle = defaultInstructionBundle(bundleKey, input.companyName)
    await env.DB.prepare(
      `INSERT INTO company_instruction_bundles (
        id, tenant_id, company_id, bundle_key, title, markdown, summary, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, bundle_key) DO NOTHING`
    )
      .bind(
        newId('cib'),
        input.tenantId,
        input.companyId,
        bundleKey,
        bundle.title,
        bundle.markdown,
        bundle.summary,
        input.createdBy,
        input.createdAt,
        input.updatedAt
      )
      .run()
  }
}

export async function recordCompanyActivity(
  env: EnvBindings,
  input: {
    tenantId: string
    companyId: string
    category: string
    message: string
    severity?: 'info' | 'warn' | 'error'
    projectId?: string | null
    metadata?: Record<string, unknown> | null
  }
) {
  await env.DB.prepare(
    `INSERT INTO company_activity (
      id, tenant_id, company_id, project_id, category, severity, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('cact'),
      input.tenantId,
      input.companyId,
      input.projectId ?? null,
      input.category,
      input.severity ?? 'info',
      input.message,
      JSON.stringify(input.metadata || {}),
      Date.now()
    )
    .run()

  // Fan out to /workspace listeners — best-effort, never blocks the write.
  try {
    const { publishCompanyEvent } = await import('./control-plane-live')
    await publishCompanyEvent(env, input.companyId, {
      kind: 'activity',
      category: input.category,
      severity: input.severity ?? 'info',
      message: input.message,
      projectId: input.projectId ?? null,
      metadata: input.metadata ?? null,
    })
  } catch {
    // ignore publish failures
  }
}

export async function ensureCompanyExists(env: EnvBindings, tenantId: string, companyId: string) {
  return env.DB.prepare(
    `SELECT *
     FROM companies
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, companyId)
    .first<CompanyRow | null>()
}

export async function getCompanyForProject(env: EnvBindings, tenantId: string, projectId: string) {
  return env.DB.prepare(
    `SELECT c.*
     FROM companies c
     JOIN projects p ON p.company_id = c.id AND p.tenant_id = c.tenant_id
     WHERE c.tenant_id = ? AND p.id = ?
     LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<CompanyRow | null>()
}

export async function listCompanies(env: EnvBindings, tenantId: string) {
  const result = await env.DB.prepare(
    `SELECT
       c.*,
       COUNT(DISTINCT cw.id) AS workstream_count,
       COUNT(DISTINCT at.id) AS thread_count,
       COUNT(DISTINCT es.id) AS execution_count
     FROM companies c
     LEFT JOIN company_workstreams cw ON cw.company_id = c.id AND cw.tenant_id = c.tenant_id
     LEFT JOIN assistant_threads at ON at.company_id = c.id AND at.tenant_id = c.tenant_id
     LEFT JOIN execution_sessions es ON es.company_id = c.id AND es.tenant_id = c.tenant_id
     WHERE c.tenant_id = ?
     GROUP BY c.id
     ORDER BY c.updated_at DESC`
  )
    .bind(tenantId)
    .all<CompanyRow & { workstream_count: number; thread_count: number; execution_count: number }>()

  return {
    companies: result.results.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      issuePrefix: row.issue_prefix,
      brandColor: row.brand_color,
      canonicalProjectId: row.canonical_project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      workstreamCount: Number(row.workstream_count || 0),
      threadCount: Number(row.thread_count || 0),
      executionCount: Number(row.execution_count || 0),
    })),
  }
}

export async function updateCompany(
  env: EnvBindings,
  input: {
    tenantId: string
    companyId: string
    name?: string
    description?: string | null
    brandColor?: string | null
  }
) {
  const existing = await env.DB.prepare(
    `SELECT id, tenant_id, canonical_project_id, name, description, status, issue_prefix, brand_color, created_at, updated_at
     FROM companies
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(input.tenantId, input.companyId)
    .first<CompanyRow | null>()

  if (!existing) return null

  const nextName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : existing.name
  const nextDescription =
    input.description === undefined ? existing.description : (input.description?.trim() || null)
  const nextBrandColor =
    input.brandColor === undefined ? existing.brand_color : (input.brandColor?.trim() || null)
  const now = Date.now()

  await env.DB.prepare(
    `UPDATE companies
     SET name = ?, description = ?, brand_color = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(nextName, nextDescription, nextBrandColor, now, input.tenantId, input.companyId)
    .run()

  return env.DB.prepare(
    `SELECT id, tenant_id, canonical_project_id, name, description, status, issue_prefix, brand_color, created_at, updated_at
     FROM companies
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(input.tenantId, input.companyId)
    .first<CompanyRow | null>()
}

export async function getCompanyDashboard(env: EnvBindings, tenantId: string, companyId: string) {
  const company = await ensureCompanyExists(env, tenantId, companyId)
  if (!company) return null

  const [workstreams, items, proposals, threads, executions, pendingApprovals] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM company_workstreams
       WHERE tenant_id = ? AND company_id = ?`
    )
      .bind(tenantId, companyId)
      .first<{ count: number } | null>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_items,
         SUM(CASE WHEN i.status IN ('todo', 'planned') THEN 1 ELSE 0 END) AS todo_items,
         SUM(CASE WHEN i.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_items,
         SUM(CASE WHEN i.status = 'review' THEN 1 ELSE 0 END) AS review_items,
         SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END) AS done_items
       FROM items i
       JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
       WHERE i.tenant_id = ? AND p.company_id = ?`
    )
      .bind(tenantId, companyId)
      .first<{
        total_items: number | null
        todo_items: number | null
        in_progress_items: number | null
        review_items: number | null
        done_items: number | null
      } | null>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM proposals pr
       JOIN projects p ON p.id = pr.project_id AND p.tenant_id = pr.tenant_id
       WHERE pr.tenant_id = ? AND p.company_id = ?`
    )
      .bind(tenantId, companyId)
      .first<{ count: number } | null>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM assistant_threads
       WHERE tenant_id = ? AND company_id = ?`
    )
      .bind(tenantId, companyId)
      .first<{ count: number } | null>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_sessions,
         SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS live_sessions
       FROM execution_sessions
       WHERE tenant_id = ? AND company_id = ?`
    )
      .bind(tenantId, companyId)
      .first<{ total_sessions: number | null; live_sessions: number | null } | null>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM assistant_pending_actions
       WHERE tenant_id = ? AND company_id = ? AND status = 'pending'`
    )
      .bind(tenantId, companyId)
      .first<{ count: number } | null>(),
  ])

  return {
    company: {
      id: company.id,
      name: company.name,
      description: company.description,
      status: company.status,
      issuePrefix: company.issue_prefix,
      brandColor: company.brand_color,
      canonicalProjectId: company.canonical_project_id,
      createdAt: company.created_at,
      updatedAt: company.updated_at,
    },
    summary: {
      workstreams: Number(workstreams?.count || 0),
      items: {
        total: Number(items?.total_items || 0),
        todo: Number(items?.todo_items || 0),
        inProgress: Number(items?.in_progress_items || 0),
        review: Number(items?.review_items || 0),
        done: Number(items?.done_items || 0),
      },
      proposals: Number(proposals?.count || 0),
      threads: Number(threads?.count || 0),
      executionSessions: Number(executions?.total_sessions || 0),
      liveExecutionSessions: Number(executions?.live_sessions || 0),
      pendingActions: Number(pendingApprovals?.count || 0),
    },
  }
}

export async function listCompanyWorkstreams(env: EnvBindings, tenantId: string, companyId: string) {
  const result = await env.DB.prepare(
    `SELECT
       cw.*,
       pgl.repo_full_name AS github_repo_full_name,
       pgl.collaboration_mode AS github_collaboration_mode,
       pgl.review_on_push AS github_review_on_push
     FROM company_workstreams cw
     JOIN projects p ON p.id = cw.project_id AND p.tenant_id = cw.tenant_id
     LEFT JOIN project_github_links pgl ON pgl.project_id = p.id AND pgl.tenant_id = p.tenant_id
     WHERE cw.tenant_id = ? AND cw.company_id = ?
     ORDER BY cw.is_default DESC, cw.updated_at DESC`
  )
    .bind(tenantId, companyId)
    .all<WorkstreamRow>()

  return {
    workstreams: result.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      projectId: row.project_id,
      name: row.name,
      description: row.description,
      status: row.status,
      isDefault: Boolean(row.is_default),
      githubRepoFullName: row.github_repo_full_name,
      githubCollaborationMode: row.github_collaboration_mode,
      githubReviewOnPush: row.github_review_on_push,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

export async function listCompanyInstructionBundles(env: EnvBindings, tenantId: string, companyId: string) {
  const result = await env.DB.prepare(
    `SELECT id, bundle_key, title, markdown, summary, created_at, updated_at
     FROM company_instruction_bundles
     WHERE tenant_id = ? AND company_id = ?
     ORDER BY bundle_key ASC`
  )
    .bind(tenantId, companyId)
    .all<{
      id: string
      bundle_key: string
      title: string
      markdown: string
      summary: string | null
      created_at: number
      updated_at: number
    }>()

  return {
    bundles: result.results.map((row) => ({
      id: row.id,
      bundleKey: row.bundle_key,
      title: row.title,
      markdown: row.markdown,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

export async function listCompanyIssues(env: EnvBindings, tenantId: string, companyId: string) {
  const result = await env.DB.prepare(
    `SELECT
       i.id,
       i.project_id,
       p.name AS project_name,
       cw.name AS workstream_name,
       i.kind,
       i.title,
       i.description,
       i.status,
       i.issue_key,
       i.priority,
       i.goal_id,
       cg.title AS goal_title,
       i.execution_mode,
       i.assignee_id,
       i.approver_id,
       i.updated_at
     FROM items i
     JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
     LEFT JOIN company_workstreams cw ON cw.project_id = p.id AND cw.tenant_id = p.tenant_id
     LEFT JOIN company_goals cg ON cg.id = i.goal_id AND cg.tenant_id = i.tenant_id
     WHERE i.tenant_id = ? AND p.company_id = ?
     ORDER BY i.updated_at DESC
     LIMIT 100`
  )
    .bind(tenantId, companyId)
    .all<CompanyIssueRow>()

  return {
    issues: result.results.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      workstreamName: row.workstream_name,
      kind: row.kind,
      title: row.title,
      description: row.description,
      status: row.status,
      issueKey: row.issue_key,
      priority: row.priority,
      goalId: row.goal_id,
      goalTitle: row.goal_title,
      executionMode: row.execution_mode,
      assigneeId: row.assignee_id,
      approverId: row.approver_id,
      updatedAt: row.updated_at,
    })),
  }
}

export async function listCompanyGoals(env: EnvBindings, tenantId: string, companyId: string) {
  const result = await env.DB.prepare(
    `SELECT id, company_id, title, description, status, created_at, updated_at
     FROM company_goals
     WHERE tenant_id = ? AND company_id = ?
     ORDER BY updated_at DESC`
  )
    .bind(tenantId, companyId)
    .all<CompanyGoalRow>()

  return {
    goals: result.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

export async function listCompanyAgents(env: EnvBindings, tenantId: string, companyId: string) {
  const company = await ensureCompanyExists(env, tenantId, companyId)
  if (!company) return { agents: [] }

  await ensureDefaultCompanyLeadership(env, {
    tenantId,
    companyId,
    createdBy: company.created_by,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const result = await env.DB.prepare(
    `SELECT id, company_id, user_id, role_key, title, description, wakeup_policy_json, runtime_policy_json, created_at, updated_at
     FROM company_agents
     WHERE tenant_id = ? AND company_id = ?
     ORDER BY created_at ASC`
  )
    .bind(tenantId, companyId)
    .all<CompanyAgentRow>()

  return {
    agents: result.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      userId: row.user_id,
      roleKey: row.role_key,
      title: row.title,
      description: row.description,
      wakeupPolicy: safeJsonParse<Record<string, unknown> | null>(row.wakeup_policy_json, null),
      runtimePolicy: safeJsonParse<Record<string, unknown> | null>(row.runtime_policy_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

export async function listCompanyRoutines(env: EnvBindings, tenantId: string, companyId: string) {
  const result = await env.DB.prepare(
    `SELECT id, company_id, title, description, wakeup_type, schedule_json, status, created_at, updated_at
     FROM company_routines
     WHERE tenant_id = ? AND company_id = ?
     ORDER BY updated_at DESC`
  )
    .bind(tenantId, companyId)
    .all<CompanyRoutineRow>()

  return {
    routines: result.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      title: row.title,
      description: row.description,
      wakeupType: row.wakeup_type,
      schedule: safeJsonParse<Record<string, unknown> | null>(row.schedule_json, null),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

export async function listCompanyApprovals(env: EnvBindings, tenantId: string, companyId: string) {
  const company = await ensureCompanyExists(env, tenantId, companyId)
  if (!company) return { approvals: [], pendingActions: [] }

  await ensureInitialHireApproval(env, {
    tenantId,
    companyId,
    requestedBy: company.created_by,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const [approvals, pendingActions] = await Promise.all([
    env.DB.prepare(
      `SELECT id, company_id, source_type, source_id, status, title, summary, payload_json, requested_by, decided_by, decided_at, created_at, updated_at
       FROM company_approvals
       WHERE tenant_id = ? AND company_id = ?
       ORDER BY updated_at DESC`
    )
      .bind(tenantId, companyId)
      .all<CompanyApprovalRow>(),
    env.DB.prepare(
      `SELECT id, kind, status, title, payload_json, created_by, updated_at
       FROM assistant_pending_actions
       WHERE tenant_id = ? AND company_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`
    )
      .bind(tenantId, companyId)
      .all<{
        id: string
        kind: string
        status: string
        title: string
        payload_json: string | null
        created_by: string
        updated_at: number
      }>(),
  ])

  return {
    approvals: approvals.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      status: row.status,
      title: row.title,
      summary: row.summary,
      payload: safeJsonParse<Record<string, unknown> | null>(row.payload_json, null),
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      source: 'company_approval',
    })),
    pendingActions: pendingActions.results.map((row) => ({
      id: row.id,
      sourceType: row.kind,
      status: row.status,
      title: row.title,
      payload: safeJsonParse<Record<string, unknown> | null>(row.payload_json, null),
      requestedBy: row.created_by,
      updatedAt: row.updated_at,
      source: 'assistant_pending_action',
    })),
  }
}

export async function listCompanyActivity(env: EnvBindings, tenantId: string, companyId: string) {
  const result = await env.DB.prepare(
    `SELECT id, company_id, project_id, category, severity, message, metadata_json, created_at
     FROM company_activity
     WHERE tenant_id = ? AND company_id = ?
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(tenantId, companyId)
    .all<CompanyActivityRow>()

  return {
    activity: result.results.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      projectId: row.project_id,
      category: row.category,
      severity: row.severity,
      message: row.message,
      metadata: safeJsonParse<Record<string, unknown> | null>(row.metadata_json, null),
      createdAt: row.created_at,
    })),
  }
}

export async function getCompanyCosts(env: EnvBindings, tenantId: string, companyId: string) {
  const [usage, liveExecution, subscription] = await Promise.all([
    getUsageSnapshot(env, tenantId, null),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_sessions,
         SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS live_sessions,
         SUM(CASE WHEN transport = 'bridge_cli' THEN 1 ELSE 0 END) AS bridge_sessions,
         SUM(CASE WHEN transport = 'cloud' THEN 1 ELSE 0 END) AS cloud_sessions
       FROM execution_sessions
       WHERE tenant_id = ? AND company_id = ?`
    )
      .bind(tenantId, companyId)
      .first<{
        total_sessions: number | null
        live_sessions: number | null
        bridge_sessions: number | null
        cloud_sessions: number | null
      } | null>(),
    env.DB.prepare(
      `SELECT plan_key, status, current_period_end
       FROM billing_subscriptions
       WHERE tenant_id = ? AND status IN ('trialing', 'active')
       ORDER BY updated_at DESC
       LIMIT 1`
    )
      .bind(tenantId)
      .first<{
        plan_key: string
        status: string
        current_period_end: number | null
      } | null>(),
  ])

  return {
    companyId,
    subscription: subscription
      ? {
          planKey: subscription.plan_key,
          status: subscription.status,
          billingCycle: null,
          currentPeriodStart: null,
          currentPeriodEnd: subscription.current_period_end,
        }
      : null,
    usage,
    execution: {
      totalSessions: Number(liveExecution?.total_sessions || 0),
      liveSessions: Number(liveExecution?.live_sessions || 0),
      bridgeSessions: Number(liveExecution?.bridge_sessions || 0),
      cloudSessions: Number(liveExecution?.cloud_sessions || 0),
    },
  }
}

export async function exportCompanySnapshot(env: EnvBindings, tenantId: string, companyId: string) {
  const company = await ensureCompanyExists(env, tenantId, companyId)
  if (!company) return null

  const [workstreams, instructions, issues, goals, agents, routines, approvals, activity] = await Promise.all([
    listCompanyWorkstreams(env, tenantId, companyId),
    listCompanyInstructionBundles(env, tenantId, companyId),
    listCompanyIssues(env, tenantId, companyId),
    listCompanyGoals(env, tenantId, companyId),
    listCompanyAgents(env, tenantId, companyId),
    listCompanyRoutines(env, tenantId, companyId),
    listCompanyApprovals(env, tenantId, companyId),
    listCompanyActivity(env, tenantId, companyId),
  ])

  return {
    version: 1,
    exportedAt: Date.now(),
    company: {
      id: company.id,
      name: company.name,
      description: company.description,
      status: company.status,
      issuePrefix: company.issue_prefix,
      brandColor: company.brand_color,
    },
    workstreams: workstreams.workstreams,
    instructions: instructions.bundles,
    issues: issues.issues,
    goals: goals.goals,
    agents: agents.agents,
    routines: routines.routines,
    approvals: approvals.approvals,
    pendingActions: approvals.pendingActions,
    activity: activity.activity,
  }
}

export async function importCompanySnapshot(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    name?: string | null
    snapshot: Record<string, unknown>
  }
) {
  const snapshotCompany = (input.snapshot.company as Record<string, unknown> | undefined) || {}
  const created = await createCompanyWithDefaultWorkstream(env, {
    tenantId: input.tenantId,
    userId: input.userId,
    name: (input.name || (typeof snapshotCompany.name === 'string' ? snapshotCompany.name : '') || 'Imported Company').trim(),
    description: typeof snapshotCompany.description === 'string' ? snapshotCompany.description : null,
  })

  const companyId = created.companyId
  const now = Date.now()
  const instructions = Array.isArray(input.snapshot.instructions) ? input.snapshot.instructions : []
  const goals = Array.isArray(input.snapshot.goals) ? input.snapshot.goals : []
  const routines = Array.isArray(input.snapshot.routines) ? input.snapshot.routines : []

  for (const bundle of instructions) {
    if (!bundle || typeof bundle !== 'object') continue
    const entry = bundle as Record<string, unknown>
    const bundleKey = typeof entry.bundleKey === 'string' ? entry.bundleKey : null
    const title = typeof entry.title === 'string' ? entry.title : null
    const markdown = typeof entry.markdown === 'string' ? entry.markdown : null
    if (!bundleKey || !title || !markdown) continue
    await env.DB.prepare(
      `INSERT INTO company_instruction_bundles (
        id, tenant_id, company_id, bundle_key, title, markdown, summary, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, bundle_key) DO UPDATE SET title = excluded.title, markdown = excluded.markdown, summary = excluded.summary, updated_at = excluded.updated_at`
    )
      .bind(newId('cib'), input.tenantId, companyId, bundleKey, title, markdown, typeof entry.summary === 'string' ? entry.summary : null, input.userId, now, now)
      .run()
  }

  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') continue
    const entry = goal as Record<string, unknown>
    if (typeof entry.title !== 'string' || !entry.title.trim()) continue
    await env.DB.prepare(
      `INSERT INTO company_goals (
        id, tenant_id, company_id, title, description, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(newId('goal'), input.tenantId, companyId, entry.title.trim(), typeof entry.description === 'string' ? entry.description : null, typeof entry.status === 'string' ? entry.status : 'active', input.userId, now, now)
      .run()
  }

  for (const routine of routines) {
    if (!routine || typeof routine !== 'object') continue
    const entry = routine as Record<string, unknown>
    if (typeof entry.title !== 'string' || !entry.title.trim()) continue
    await env.DB.prepare(
      `INSERT INTO company_routines (
        id, tenant_id, company_id, title, description, wakeup_type, schedule_json, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        newId('crtn'),
        input.tenantId,
        companyId,
        entry.title.trim(),
        typeof entry.description === 'string' ? entry.description : null,
        typeof entry.wakeupType === 'string' ? entry.wakeupType : 'automation',
        JSON.stringify((entry.schedule as Record<string, unknown> | null) || null),
        typeof entry.status === 'string' ? entry.status : 'active',
        input.userId,
        now,
        now
      )
      .run()
  }

  await ensureDefaultCompanyLeadership(env, {
    tenantId: input.tenantId,
    companyId,
    createdBy: input.userId,
    createdAt: now,
    updatedAt: now,
  })

  await recordCompanyActivity(env, {
    tenantId: input.tenantId,
    companyId,
    category: 'company_import',
    message: 'Imported a company control-plane snapshot.',
    metadata: { sourceVersion: input.snapshot.version ?? null },
  })

  return created
}

export async function wakeCompanyAgent(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    agentId: string
    reason?: string | null
    targetType?: string | null
    targetId?: string | null
  }
) {
  const agent = await env.DB.prepare(
    `SELECT id, company_id, user_id, role_key, title, description, wakeup_policy_json, runtime_policy_json
     FROM company_agents
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(input.tenantId, input.agentId)
    .first<{
      id: string
      company_id: string
      user_id: string | null
      role_key: string
      title: string
      description: string | null
      wakeup_policy_json: string | null
      runtime_policy_json: string | null
    } | null>()

  if (!agent) return null

  const liveSession = await env.DB.prepare(
    `SELECT id, status, title
     FROM execution_sessions
     WHERE tenant_id = ? AND company_id = ? AND status IN ('queued', 'running')
     ORDER BY updated_at DESC
     LIMIT 1`
  )
    .bind(input.tenantId, agent.company_id)
    .first<{ id: string; status: string; title: string } | null>()

  if (liveSession) {
    return {
      ok: true,
      coalesced: true,
      agent: { id: agent.id, companyId: agent.company_id, roleKey: agent.role_key, title: agent.title },
      liveSession,
    }
  }

  // Pull agent inbox: assigned items + pending company approvals
  const [assignedItems, pendingApprovals] = await Promise.all([
    agent.user_id
      ? env.DB.prepare(
          `SELECT id, title, status, priority FROM items
           WHERE tenant_id = ? AND assignee_id = ? AND status NOT IN ('done')
           ORDER BY updated_at DESC LIMIT 10`
        )
          .bind(input.tenantId, agent.user_id)
          .all<{ id: string; title: string; status: string; priority: string | null }>()
      : Promise.resolve({ results: [] as Array<{ id: string; title: string; status: string; priority: string | null }> }),
    env.DB.prepare(
      `SELECT id, title, source_type, summary FROM company_approvals
       WHERE tenant_id = ? AND company_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT 5`
    )
      .bind(input.tenantId, agent.company_id)
      .all<{ id: string; title: string; source_type: string; summary: string | null }>(),
  ])

  const runtimePolicy = safeJsonParse<Record<string, unknown>>(agent.runtime_policy_json, {})
  const inboxSummary = [
    assignedItems.results.length
      ? `Assigned issues: ${assignedItems.results.map((i) => `${i.title} (${i.status})`).join(', ')}`
      : 'No assigned issues.',
    pendingApprovals.results.length
      ? `Pending approvals: ${pendingApprovals.results.map((a) => a.title).join(', ')}`
      : 'No pending approvals.',
  ].join('\n')

  const rolePrompts: Record<string, string> = {
    ceo: 'You are the CEO agent. Review company health, pending approvals, and delivery posture. Summarize the company state and identify the next priority decision.',
    executor: 'You are the Executor agent. Review your assigned issues and execution sessions. Identify the next concrete work unit to begin or unblock.',
    planner: 'You are the Planner agent. Review open issues and epics. Identify planning gaps and propose the next sprint decomposition.',
    reviewer: 'You are the Reviewer agent. Review recent work output and open pull requests. Identify what needs review or verification.',
    operator: 'You are the Operator agent. Review system health, routine status, and integration state. Identify anomalies to escalate.',
  }

  const systemPrompt = [
    rolePrompts[agent.role_key] ?? `You are the ${agent.title} agent. Review your current context and generate a concise heartbeat summary.`,
    `Runtime policy: ${JSON.stringify(runtimePolicy)}`,
    `Your inbox:\n${inboxSummary}`,
    `Wake reason: ${input.reason ?? 'on_demand'}`,
    input.targetType ? `Target: ${input.targetType} ${input.targetId ?? ''}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  let heartbeatText = `${agent.title} heartbeat: no active tasks.`
  try {
    const result = await generateTenantAiText(
      env,
      { tenantId: input.tenantId, userId: input.userId },
      {
        featureKey: 'agent.heartbeat',
        system: systemPrompt,
        prompt: `Generate a concise heartbeat summary (3-5 bullet points) covering: current state, next priority action, any blockers or escalations needed, and a confidence level.`,
        maxOutputTokens: 600,
      }
    )
    heartbeatText = result.text
  } catch {
    // fall through to default
  }

  await recordCompanyActivity(env, {
    tenantId: input.tenantId,
    companyId: agent.company_id,
    category: 'agent_heartbeat',
    message: heartbeatText,
    metadata: {
      agentId: agent.id,
      roleKey: agent.role_key,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
    },
  })

  return {
    ok: true,
    coalesced: false,
    agent: { id: agent.id, companyId: agent.company_id, roleKey: agent.role_key, title: agent.title },
    heartbeat: heartbeatText,
  }
}

export async function approveCompanyApproval(
  env: EnvBindings,
  input: { tenantId: string; actorId: string; approvalId: string; companyId: string }
) {
  const row = await env.DB.prepare(
    `SELECT id, source_type, status, payload_json
     FROM company_approvals
     WHERE tenant_id = ? AND company_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(input.tenantId, input.companyId, input.approvalId)
    .first<{ id: string; source_type: string; status: string; payload_json: string | null } | null>()

  if (!row || row.status !== 'pending') throw new Error('Approval not found or already decided.')
  const now = Date.now()

  let hiredAgentId: string | null = null
  if (row.source_type === 'agent_hire') {
    const payload = safeJsonParse<{
      roleKey: string
      title: string
      description?: string
      provider?: string
      wakeupPolicy?: Record<string, unknown>
      runtimePolicy?: Record<string, unknown>
    }>(row.payload_json, { roleKey: 'executor', title: 'Agent' })

    const agentId = newId('cagt')
    hiredAgentId = agentId
    await env.DB.prepare(
      `INSERT INTO company_agents (
        id, tenant_id, company_id, user_id, role_key, title, description, wakeup_policy_json, runtime_policy_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        agentId,
        input.tenantId,
        input.companyId,
        payload.roleKey,
        payload.title,
        payload.description ?? null,
        JSON.stringify(payload.wakeupPolicy ?? {}),
        JSON.stringify(payload.runtimePolicy ?? {}),
        input.actorId,
        now,
        now
      )
      .run()

    try {
      const { publishCompanyEvent } = await import('./control-plane-live')
      await publishCompanyEvent(env, input.companyId, { kind: 'agent.hired', agentId })
    } catch {
      // ignore publish failures
    }
  } else if (row.source_type === 'project_member_invite') {
    const payload = safeJsonParse<{ memberId?: string }>(row.payload_json, {})
    if (payload.memberId) {
      const { activateProjectMemberFromApproval } = await import('./project-members')
      await activateProjectMemberFromApproval(env, {
        tenantId: input.tenantId,
        memberId: payload.memberId,
      })
    }
  }

  await env.DB.prepare(
    `UPDATE company_approvals
     SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(input.actorId, now, now, input.tenantId, input.approvalId)
    .run()

  await recordCompanyActivity(env, {
    tenantId: input.tenantId,
    companyId: input.companyId,
    category: 'approval_decided',
    message: `Approval approved by ${input.actorId}.`,
    metadata: { approvalId: input.approvalId, decision: 'approved' },
  })

  return { ok: true, approvalId: input.approvalId }
}

export async function rejectCompanyApproval(
  env: EnvBindings,
  input: { tenantId: string; actorId: string; approvalId: string; companyId: string; reason?: string }
) {
  const row = await env.DB.prepare(
    `SELECT id, status FROM company_approvals
     WHERE tenant_id = ? AND company_id = ? AND id = ? LIMIT 1`
  )
    .bind(input.tenantId, input.companyId, input.approvalId)
    .first<{ id: string; status: string } | null>()

  if (!row || row.status !== 'pending') throw new Error('Approval not found or already decided.')
  const now = Date.now()

  await env.DB.prepare(
    `UPDATE company_approvals
     SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(input.actorId, now, now, input.tenantId, input.approvalId)
    .run()

  await recordCompanyActivity(env, {
    tenantId: input.tenantId,
    companyId: input.companyId,
    category: 'approval_decided',
    message: `Approval rejected: ${input.reason ?? 'no reason given'}.`,
    metadata: { approvalId: input.approvalId, decision: 'rejected', reason: input.reason ?? null },
  })

  return { ok: true, approvalId: input.approvalId }
}

export async function createCompanyWithDefaultWorkstream(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    name: string
    description?: string | null
    githubRepoFullName?: string | null
  }
) {
  const now = Date.now()
  const companyId = newId('cmp')
  const projectId = newId('proj')
  const workstreamId = newId('cws')
  const name = input.name.trim()
  const description = input.description?.trim() || null

  await env.DB.prepare(
    `INSERT INTO companies (
      id, tenant_id, canonical_project_id, name, description, status, issue_prefix, brand_color, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, 'active', ?, ?, ?, ?, ?)`
  )
    .bind(
      companyId,
      input.tenantId,
      name,
      description,
      buildIssuePrefix(name, companyId),
      buildBrandColor(companyId),
      input.userId,
      now,
      now
    )
    .run()

  await env.DB.prepare(
    `INSERT INTO projects (
      id, tenant_id, company_id, name, description, workstream_key, is_default_workstream, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'default', 1, ?, ?, ?)`
  )
    .bind(projectId, input.tenantId, companyId, name, description, input.userId, now, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO company_workstreams (
      id, tenant_id, company_id, project_id, name, description, status, is_default, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
  )
    .bind(workstreamId, input.tenantId, companyId, projectId, name, description, input.userId, now, now)
    .run()

  await env.DB.prepare(
    `UPDATE companies
     SET canonical_project_id = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(projectId, now, input.tenantId, companyId)
    .run()

  await env.DB.prepare(
    `INSERT INTO company_members (
      id, tenant_id, company_id, user_id, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'owner', ?, ?)
    ON CONFLICT(company_id, user_id) DO NOTHING`
  )
    .bind(newId('cmpm'), input.tenantId, companyId, input.userId, now, now)
    .run()

  // Seed a default company-level goal so downstream flows (onboarding,
  // routines, projects that link to a goal) always have a target to point at.
  const defaultGoalId = newId('goal')
  await env.DB.prepare(
    `INSERT INTO company_goals (
      id, tenant_id, company_id, title, description, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  )
    .bind(
      defaultGoalId,
      input.tenantId,
      companyId,
      `Primary goal for ${name}`,
      description ?? `Default company-level goal for ${name}. Rename or edit from Goals.`,
      input.userId,
      now,
      now
    )
    .run()

  await ensureInstructionBundles(env, {
    tenantId: input.tenantId,
    companyId,
    companyName: name,
    createdBy: input.userId,
    createdAt: now,
    updatedAt: now,
  })

  await ensureDefaultCompanyLeadership(env, {
    tenantId: input.tenantId,
    companyId,
    createdBy: input.userId,
    createdAt: now,
    updatedAt: now,
  })

  await ensureInitialHireApproval(env, {
    tenantId: input.tenantId,
    companyId,
    requestedBy: input.userId,
    createdAt: now,
    updatedAt: now,
  })

  await recordCompanyActivity(env, {
    tenantId: input.tenantId,
    companyId,
    projectId,
    category: 'company_created',
    message: `Created company ${name} with its default workstream.`,
    metadata: { workstreamId, projectId },
  })

  return {
    companyId,
    projectId,
    workstreamId,
  }
}

export async function createCompanyWorkstream(
  env: EnvBindings,
  input: {
    tenantId: string
    userId: string
    companyId: string
    name: string
    description?: string | null
  }
) {
  const now = Date.now()
  const projectId = newId('proj')
  const workstreamId = newId('cws')
  const name = input.name.trim()
  const description = input.description?.trim() || null

  await env.DB.prepare(
    `INSERT INTO projects (
      id, tenant_id, company_id, name, description, workstream_key, is_default_workstream, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(projectId, input.tenantId, input.companyId, name, description, name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48) || 'workstream', input.userId, now, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO company_workstreams (
      id, tenant_id, company_id, project_id, name, description, status, is_default, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`
  )
    .bind(workstreamId, input.tenantId, input.companyId, projectId, name, description, input.userId, now, now)
    .run()

  await env.DB.prepare(
    `UPDATE companies
     SET updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(now, input.tenantId, input.companyId)
    .run()

  await recordCompanyActivity(env, {
    tenantId: input.tenantId,
    companyId: input.companyId,
    projectId,
    category: 'workstream_created',
    message: `Created workstream ${name}.`,
    metadata: { workstreamId, projectId },
  })

  return { workstreamId, projectId }
}

import { newId } from './ids'
import type { EnvBindings, RequestContext } from './context'
import { ensureProjectExists } from './projects'
import { getUsageSnapshot } from './usage'

export type InvestigationMode =
  | 'bug_repro'
  | 'failing_check'
  | 'push_review'
  | 'billing_drift'
  | 'integration_failure'
  | 'agent_misroute'

type DebugContext = Pick<RequestContext, 'tenantId' | 'userId' | 'userEmail'>

function summarizeDiagnosis(input: {
  mode: InvestigationMode
  repoLinked: boolean
  billingConfigured: boolean
  connectedIntegrations: string[]
  recentErrorCount: number
}) {
  if ((input.mode === 'push_review' || input.mode === 'failing_check') && !input.repoLinked) {
    return 'This investigation is blocked on a linked GitHub repository. Connect a repo before expecting diff-aware review or failing-check diagnosis.'
  }
  if (input.mode === 'billing_drift' && !input.billingConfigured) {
    return 'Billing drift cannot be reconciled safely until Stripe secrets and live price ids are configured for this workspace.'
  }
  if (input.mode === 'integration_failure' && input.connectedIntegrations.length === 0) {
    return 'No active integrations are connected for this workspace, so the failure is likely configuration or expectation drift rather than a downstream service outage.'
  }
  if (input.recentErrorCount > 0) {
    return `Recent runtime errors were found (${input.recentErrorCount}). Start with those before guessing at a product-level explanation.`
  }
  return 'The workspace has enough context to investigate, but the current evidence is thin. Treat this as a guided triage session and gather logs, repo state, and recent user intent before applying a fix.'
}

export async function createDebugInvestigation(
  env: EnvBindings,
  context: DebugContext,
  input: {
    projectId: string
    mode: InvestigationMode
    summary: string
    evidenceSources?: string[]
    linkedProposalId?: string | null
    linkedRunId?: string | null
    screenContext?: Record<string, unknown> | null
  }
) {
  const project = await ensureProjectExists(env, context.tenantId, input.projectId)
  if (!project) {
    throw new Error(`Project ${input.projectId} was not found for this workspace.`)
  }

  const [githubLink, recentErrors, connectedIntegrations, usageSnapshot] = await Promise.all([
    env.DB.prepare(
      `SELECT repo_full_name
       FROM project_github_links
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(context.tenantId, input.projectId)
      .first<{ repo_full_name: string } | null>(),
    env.DB.prepare(
      `SELECT route_key, category, message, created_at
       FROM app_runtime_events
       WHERE tenant_id = ? AND project_id = ? AND severity = 'error'
       ORDER BY created_at DESC
       LIMIT 5`
    )
      .bind(context.tenantId, input.projectId)
      .all<{ route_key: string; category: string; message: string; created_at: number }>(),
    env.DB.prepare(
      `SELECT DISTINCT service_type
       FROM service_connections
       WHERE tenant_id = ? AND is_active = true
       ORDER BY service_type ASC`
    )
      .bind(context.tenantId)
      .all<{ service_type: string }>(),
    getUsageSnapshot(env, context.tenantId, context.userId).catch(() => null),
  ])

  const repoLinked = Boolean(githubLink?.repo_full_name)
  const connectedServiceTypes = connectedIntegrations.results.map((row) => row.service_type)
  const billingConfigured = Boolean(
    env.STRIPE_SECRET_KEY &&
      env.STRIPE_PRICE_PRO_MONTHLY &&
      env.STRIPE_PRICE_PRO_YEARLY &&
      env.STRIPE_PRICE_TEAM_MONTHLY &&
      env.STRIPE_PRICE_TEAM_YEARLY &&
      env.STRIPE_WEBHOOK_SECRET
  )
  const diagnosis = summarizeDiagnosis({
    mode: input.mode,
    repoLinked,
    billingConfigured,
    connectedIntegrations: connectedServiceTypes,
    recentErrorCount: recentErrors.results.length,
  })

  const sessionId = newId('dbg')
  const now = Date.now()
  const evidenceSources = Array.from(new Set(input.evidenceSources?.filter(Boolean) || ['project_state', 'runtime_errors', 'usage']))
  const artifactPayload = {
    repoLinked,
    repoFullName: githubLink?.repo_full_name || null,
    connectedIntegrations: connectedServiceTypes,
    usage: usageSnapshot,
    recentErrors: recentErrors.results,
    screenContext: input.screenContext || null,
  }

  await env.DB.prepare(
    `INSERT INTO debug_sessions (
      id, tenant_id, project_id, created_by, mode, status, summary, evidence_sources_json,
      linked_proposal_id, linked_run_id, diagnosis, final_recommendation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      context.tenantId,
      input.projectId,
      context.userId,
      input.mode,
      input.summary,
      JSON.stringify(evidenceSources),
      input.linkedProposalId ?? null,
      input.linkedRunId ?? null,
      diagnosis,
      'Gather the linked evidence, confirm the failure mode, then decide whether to create a proposal, run a repo review, or escalate to a human owner.',
      now,
      now
    )
    .run()

  const steps = [
    {
      id: newId('dbgstep'),
      name: 'collect_context',
      status: 'completed',
      output: {
        summary: 'Collected repo linkage, integration health, runtime errors, and usage posture.',
        repoLinked,
        connectedIntegrations: connectedServiceTypes,
      },
      stderr: null,
      stdout: diagnosis,
    },
    {
      id: newId('dbgstep'),
      name: 'diagnose',
      status: 'completed',
      output: {
        diagnosis,
        recentErrorCount: recentErrors.results.length,
      },
      stderr: null,
      stdout: 'Diagnosis assembled from current workspace evidence.',
    },
  ]

  for (const [index, step] of steps.entries()) {
    await env.DB.prepare(
      `INSERT INTO debug_steps (
        id, session_id, tenant_id, step_order, step_name, status, input_payload_json, output_payload_json,
        stdout, stderr, exit_code, stack_trace, files_touched_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        step.id,
        sessionId,
        context.tenantId,
        index + 1,
        step.name,
        step.status,
        JSON.stringify({ mode: input.mode, evidenceSources }),
        JSON.stringify(step.output),
        step.stdout,
        step.stderr,
        0,
        null,
        JSON.stringify([]),
        now,
        now
      )
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO debug_artifacts (
      id, session_id, tenant_id, artifact_type, title, content_json, created_at
    ) VALUES (?, ?, ?, 'workspace_snapshot', ?, ?, ?)`
  )
    .bind(newId('dbgartifact'), sessionId, context.tenantId, 'Workspace snapshot', JSON.stringify(artifactPayload), now)
    .run()

  if (input.mode === 'push_review' && repoLinked) {
    await env.DB.prepare(
      `INSERT INTO repo_review_sessions (
        id, tenant_id, project_id, debug_session_id, repo_full_name, review_mode, summary, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'push_review', ?, 'open', ?, ?)`
    )
      .bind(newId('review'), context.tenantId, input.projectId, sessionId, githubLink?.repo_full_name || null, input.summary, now, now)
      .run()
  }

  return getDebugSessionDetails(env, context.tenantId, sessionId)
}

export async function getDebugSessionDetails(env: EnvBindings, tenantId: string, sessionId: string) {
  const session = await env.DB.prepare(
    `SELECT *
     FROM debug_sessions
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, sessionId)
    .first<Record<string, unknown> | null>()

  if (!session) return null

  const [steps, artifacts, repoReview] = await Promise.all([
    env.DB.prepare(
      `SELECT *
       FROM debug_steps
       WHERE tenant_id = ? AND session_id = ?
       ORDER BY step_order ASC, created_at ASC`
    )
      .bind(tenantId, sessionId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT *
       FROM debug_artifacts
       WHERE tenant_id = ? AND session_id = ?
       ORDER BY created_at ASC`
    )
      .bind(tenantId, sessionId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT *
       FROM repo_review_sessions
       WHERE tenant_id = ? AND debug_session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
      .bind(tenantId, sessionId)
      .first<Record<string, unknown> | null>(),
  ])

  return {
    session,
    steps: steps.results,
    artifacts: artifacts.results,
    repoReviewSession: repoReview,
  }
}

export async function listProjectDebugSessions(env: EnvBindings, tenantId: string, projectId: string) {
  const [sessions, repoReviewSessions] = await Promise.all([
    env.DB.prepare(
      `SELECT id, mode, status, summary, diagnosis, created_at, updated_at
       FROM debug_sessions
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 50`
    )
      .bind(tenantId, projectId)
      .all<{
        id: string
        mode: InvestigationMode
        status: string
        summary: string
        diagnosis?: string | null
        created_at: number
        updated_at: number
      }>(),
    env.DB.prepare(
      `SELECT id, debug_session_id, repo_full_name, review_mode, summary, status, created_at, updated_at
       FROM repo_review_sessions
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 50`
    )
      .bind(tenantId, projectId)
      .all<{
        id: string
        debug_session_id?: string | null
        repo_full_name: string
        review_mode: string
        summary?: string | null
        status: string
        created_at: number
        updated_at: number
      }>(),
  ])

  return {
    sessions: sessions.results.map((session) => ({
      id: session.id,
      mode: session.mode,
      status: session.status,
      summary: session.summary,
      diagnosis: session.diagnosis ?? null,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    })),
    repoReviewSessions: repoReviewSessions.results.map((session) => ({
      id: session.id,
      debugSessionId: session.debug_session_id ?? null,
      repoFullName: session.repo_full_name,
      reviewMode: session.review_mode,
      summary: session.summary ?? null,
      status: session.status,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    })),
  }
}

export async function retryDebugSessionStep(
  env: EnvBindings,
  context: DebugContext,
  input: { sessionId: string; stepId: string }
) {
  const step = await env.DB.prepare(
    `SELECT id, session_id, step_order, step_name
     FROM debug_steps
     WHERE tenant_id = ? AND session_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(context.tenantId, input.sessionId, input.stepId)
    .first<{ id: string; session_id: string; step_order: number; step_name: string } | null>()

  if (!step) {
    throw new Error('Debug step not found.')
  }

  const retriedStepId = newId('dbgstep')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO debug_steps (
      id, session_id, tenant_id, step_order, step_name, status, input_payload_json, output_payload_json,
      stdout, stderr, exit_code, stack_trace, files_touched_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      retriedStepId,
      input.sessionId,
      context.tenantId,
      step.step_order,
      `${step.step_name}:retry`,
      JSON.stringify({ retriedFrom: step.id }),
      JSON.stringify({ note: 'Retried without mutating project state. Use this to re-run evidence collection after new context arrives.' }),
      'Retried evidence collection step.',
      null,
      0,
      null,
      JSON.stringify([]),
      now,
      now
    )
    .run()

  await env.DB.prepare(`UPDATE debug_sessions SET updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .bind(now, context.tenantId, input.sessionId)
    .run()

  return getDebugSessionDetails(env, context.tenantId, input.sessionId)
}

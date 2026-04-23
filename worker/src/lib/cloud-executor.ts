import type { EnvBindings } from './context'
import { generateTenantAiText } from '../agents/orchestrator'
import { buildProjectRagContext } from './project-rag'

type CloudExecutionSession = {
  id: string
  tenant_id: string
  project_id: string | null
  item_id: string | null
  mode: string
  title: string
  summary: string
  metadata_json: string | null
}

export async function executeCloudSession(
  env: EnvBindings,
  input: { tenantId: string; userId: string; sessionId: string }
): Promise<void> {
  const session = await env.DB.prepare(
    `SELECT id, tenant_id, project_id, item_id, mode, title, summary, metadata_json
     FROM execution_sessions
     WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(input.tenantId, input.sessionId)
    .first<CloudExecutionSession | null>()

  if (!session) return

  await env.DB.prepare(
    `UPDATE execution_sessions SET status = 'running', updated_at = ? WHERE tenant_id = ? AND id = ?`
  ).bind(Date.now(), input.tenantId, input.sessionId).run()

  await insertCloudEvent(env, input.tenantId, input.sessionId, 'status_change', 'running', 'Cloud execution started.')

  try {
    const ragContext = session.project_id
      ? await buildProjectRagContext(env, {
          tenantId: input.tenantId,
          projectId: session.project_id,
          query: session.title,
          maxSnippets: 8,
        }).catch(() => null)
      : null

    const modePrompts: Record<string, string> = {
      implementation: 'You are an AI engineer. Implement the requested feature or task. Produce concrete code, file changes, or implementation steps.',
      review: 'You are a code reviewer. Review the work described and provide specific, actionable feedback.',
      debug: 'You are a debugging specialist. Diagnose the issue described and provide a root cause analysis and fix.',
      planning: 'You are a technical planner. Break down the objective into concrete, ordered implementation tasks.',
    }

    const systemPrompt = [
      modePrompts[session.mode] ?? 'You are a technical AI agent. Complete the requested task.',
      ragContext ? `Project context:\n${ragContext.promptContext}` : null,
      `Task: ${session.title}`,
      `Details: ${session.summary}`,
    ]
      .filter(Boolean)
      .join('\n\n')

    const result = await generateTenantAiText(
      env,
      { tenantId: input.tenantId, userId: input.userId },
      {
        featureKey: 'agent.execution',
        system: systemPrompt,
        prompt: `Execute the task: ${session.title}\n\n${session.summary}`,
        maxOutputTokens: 4000,
      }
    )

    await insertCloudEvent(env, input.tenantId, input.sessionId, 'output', 'running', result.text)

    await env.DB.prepare(
      `UPDATE execution_sessions SET status = 'completed', updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(Date.now(), input.tenantId, input.sessionId).run()

    await insertCloudEvent(env, input.tenantId, input.sessionId, 'status_change', 'completed', 'Cloud execution completed.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution failed.'
    await env.DB.prepare(
      `UPDATE execution_sessions SET status = 'failed', updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(Date.now(), input.tenantId, input.sessionId).run()
    await insertCloudEvent(env, input.tenantId, input.sessionId, 'error', 'failed', message)
  }
}

async function insertCloudEvent(
  env: EnvBindings,
  tenantId: string,
  sessionId: string,
  eventType: string,
  status: string,
  message: string
) {
  const id = `esevt_${crypto.randomUUID().replace(/-/g, '')}`
  await env.DB.prepare(
    `INSERT INTO execution_session_events (id, tenant_id, session_id, event_type, status, message, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(id, tenantId, sessionId, eventType, status, message, Date.now())
    .run()
}

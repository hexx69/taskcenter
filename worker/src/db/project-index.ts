type EnvBindings = {
  DB: D1Database
}

function parseJsonLines(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed
          .map((entry) => {
            if (typeof entry === 'string') return entry.trim()
            if (entry && typeof entry === 'object') return JSON.stringify(entry)
            return String(entry).trim()
          })
          .filter(Boolean)
      : []
  } catch {
    return []
  }
}

export async function upsertProjectSearchIndex(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId: string
    extraTexts?: string[]
  }
) {
  const { tenantId, projectId, extraTexts = [] } = input

  const project = await env.DB.prepare(
    `SELECT name, description
     FROM projects
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<{ name: string; description: string | null }>()

  if (!project) return

  const items = await env.DB.prepare(
    `SELECT kind, title, description
     FROM items
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY updated_at DESC
     LIMIT 300`
  )
    .bind(tenantId, projectId)
    .all<{ kind: string; title: string; description: string | null }>()

  const recentMessages = await env.DB.prepare(
    `SELECT content
     FROM agent_messages
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY created_at DESC
     LIMIT 40`
  )
    .bind(tenantId, projectId)
    .all<{ content: string }>()

  const planningContexts = await env.DB.prepare(
    `SELECT plan_intent, onboarding_answers_json, qualifying_answers_json, markdown_bundle
     FROM planning_contexts
     WHERE tenant_id = ? AND (project_id = ? OR selected_project_id = ?)
     ORDER BY created_at DESC
     LIMIT 12`
  )
    .bind(tenantId, projectId, projectId)
    .all<{
      plan_intent: string
      onboarding_answers_json: string
      qualifying_answers_json: string
      markdown_bundle: string | null
    }>()

  const proposals = await env.DB.prepare(
    `SELECT title, summary, status, actions_json
     FROM proposals
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY updated_at DESC
     LIMIT 20`
  )
    .bind(tenantId, projectId)
    .all<{ title: string; summary: string | null; status: string; actions_json: string }>()

  const itemCount = items.results.length
  const epicCount = items.results.filter((item) => item.kind === 'epic').length

  const contentParts = [
    project.name,
    project.description ?? '',
    ...items.results.flatMap((item) => [item.title, item.description ?? '']),
    ...planningContexts.results.flatMap((context) => [
      context.plan_intent,
      ...parseJsonLines(context.onboarding_answers_json),
      ...parseJsonLines(context.qualifying_answers_json),
      context.markdown_bundle ?? '',
    ]),
    ...proposals.results.flatMap((proposal) => [
      proposal.title,
      proposal.summary ?? '',
      proposal.status,
      ...parseJsonLines(proposal.actions_json),
    ]),
    ...recentMessages.results.map((msg) => msg.content),
    ...extraTexts,
  ]

  const content = contentParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 20000)

  await env.DB.prepare(
    `INSERT INTO project_search_index (
      tenant_id,
      project_id,
      content,
      item_count,
      epic_count,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, project_id)
    DO UPDATE SET
      content = excluded.content,
      item_count = excluded.item_count,
      epic_count = excluded.epic_count,
      updated_at = excluded.updated_at`
  )
    .bind(tenantId, projectId, content, itemCount, epicCount, Date.now())
    .run()
}

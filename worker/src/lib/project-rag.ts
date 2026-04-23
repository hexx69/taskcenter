type EnvBindings = {
  DB: D1Database
}

type RagSource = 'project' | 'item' | 'planning_context' | 'proposal' | 'message' | 'search_index' | 'app_memory' | 'memory_doc'

type RagSnippet = {
  source: RagSource
  label: string
  excerpt: string
  score: number
  createdAt?: number
}

export type ProjectRagResult = {
  promptContext: string
  snippets: Array<Pick<RagSnippet, 'source' | 'label' | 'excerpt'>>
  counts: {
    items: number
    planningContexts: number
    proposals: number
    messages: number
    appMemoryEntries: number
    memoryDocs: number
  }
}

function tokenizeQuery(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 12)
}

function scoreText(text: string, queryTokens: string[], recencyWeight = 0): number {
  const normalized = text.toLowerCase()
  if (!normalized.trim()) return recencyWeight
  if (queryTokens.length === 0) return normalized.length > 0 ? 1 + recencyWeight : recencyWeight

  let score = 0
  for (const token of queryTokens) {
    if (normalized.includes(token)) {
      score += token.length >= 7 ? 5 : 3
    }
  }
  return score + recencyWeight
}

function compactWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function truncate(input: string, limit = 320): string {
  if (input.length <= limit) return input
  return `${input.slice(0, Math.max(0, limit - 3)).trim()}...`
}

function parseJsonArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map((entry) => compactWhitespace(String(entry))).filter(Boolean) : []
  } catch {
    return []
  }
}

function buildPromptContext(projectName: string, snippets: RagSnippet[]): string {
  if (snippets.length === 0) {
    return `Project context summary for "${projectName}":\n- No retrieved snippets were available. Rely only on explicit conversation history and avoid inventing project state.`
  }

  return [
    `Project context summary for "${projectName}":`,
    ...snippets.map((snippet) => `- [${snippet.source}] ${snippet.label}: ${snippet.excerpt}`),
  ].join('\n')
}

export async function buildProjectRagContext(
  env: EnvBindings,
  input: {
    tenantId: string
    projectId: string
    query: string
    maxSnippets?: number
  }
): Promise<ProjectRagResult> {
  const { tenantId, projectId, query, maxSnippets = 6 } = input
  const queryTokens = tokenizeQuery(query)

  const project = await env.DB.prepare(
    `SELECT name, description
     FROM projects
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<{ name: string; description: string | null } | null>()

  const [
    itemsResult,
    contextsResult,
    proposalsResult,
    messagesResult,
    indexResult,
    appMemoryResult,
    memoryDocsResult,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, kind, title, description, status, updated_at
       FROM items
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC
       LIMIT 120`
    )
      .bind(tenantId, projectId)
      .all<{ id: string; kind: string; title: string; description: string | null; status: string; updated_at: number }>(),
    env.DB.prepare(
      `SELECT id, plan_intent, onboarding_answers_json, qualifying_answers_json, markdown_bundle, created_at
       FROM planning_contexts
       WHERE tenant_id = ? AND (project_id = ? OR selected_project_id = ?)
       ORDER BY created_at DESC
       LIMIT 12`
    )
      .bind(tenantId, projectId, projectId)
      .all<{
        id: string
        plan_intent: string
        onboarding_answers_json: string
        qualifying_answers_json: string
        markdown_bundle: string | null
        created_at: number
      }>(),
    env.DB.prepare(
      `SELECT id, title, summary, status, actions_json, updated_at
       FROM proposals
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC
       LIMIT 20`
    )
      .bind(tenantId, projectId)
      .all<{
        id: string
        title: string
        summary: string | null
        status: string
        actions_json: string
        updated_at: number
      }>(),
    env.DB.prepare(
      `SELECT role, content, created_at
       FROM agent_messages
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY created_at DESC
       LIMIT 20`
    )
      .bind(tenantId, projectId)
      .all<{ role: string; content: string; created_at: number }>(),
    env.DB.prepare(
      `SELECT content, updated_at
       FROM project_search_index
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{ content: string; updated_at: number } | null>(),
    env.DB.prepare(
      `SELECT source_app, source_type, source_key, title, content, summary, updated_at
       FROM app_memory_entries
       WHERE tenant_id = ? AND (project_id = ? OR project_id IS NULL)
       ORDER BY updated_at DESC
       LIMIT 80`
    )
      .bind(tenantId, projectId)
      .all<{
        source_app: string
        source_type: string
        source_key: string
        title: string
        content: string
        summary: string | null
        updated_at: number
      }>(),
    env.DB.prepare(
      `SELECT layer_key, title, markdown, summary, updated_at
       FROM project_memory_docs
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC`
    )
      .bind(tenantId, projectId)
      .all<{
        layer_key: string
        title: string
        markdown: string
        summary: string | null
        updated_at: number
      }>(),
  ])

  const snippets: RagSnippet[] = []
  const projectText = compactWhitespace([project?.name || '', project?.description || ''].filter(Boolean).join(' - '))
  if (projectText) {
    snippets.push({
      source: 'project',
      label: 'Project brief',
      excerpt: truncate(projectText, 260),
      score: scoreText(projectText, queryTokens, 6),
    })
  }

  for (const item of itemsResult.results) {
    const text = compactWhitespace(`${item.kind} ${item.title} ${item.description || ''} ${item.status || ''}`)
    const score = scoreText(text, queryTokens, 3)
    if (score <= 0) continue
    snippets.push({
      source: 'item',
      label: `${item.kind}: ${item.title}`,
      excerpt: truncate(compactWhitespace(`${item.description || item.status || 'No extra detail recorded.'}`)),
      score,
      createdAt: item.updated_at,
    })
  }

  for (const context of contextsResult.results) {
    const onboarding = parseJsonArray(context.onboarding_answers_json).slice(0, 3).join(' | ')
    const qualifying = parseJsonArray(context.qualifying_answers_json).slice(0, 2).join(' | ')
    const text = compactWhitespace(
      [context.plan_intent, onboarding, qualifying, context.markdown_bundle || ''].filter(Boolean).join(' ')
    )
    const score = scoreText(text, queryTokens, 4)
    if (score <= 0) continue
    snippets.push({
      source: 'planning_context',
      label: 'Planning context',
      excerpt: truncate(compactWhitespace([context.plan_intent, onboarding, qualifying].filter(Boolean).join(' | '))),
      score,
      createdAt: context.created_at,
    })
  }

  for (const proposal of proposalsResult.results) {
    const actionCount = parseJsonArray(proposal.actions_json).length
    const text = compactWhitespace(`${proposal.title} ${proposal.summary || ''} ${proposal.status}`)
    const score = scoreText(text, queryTokens, proposal.status === 'applied' ? 4 : 2)
    if (score <= 0) continue
    snippets.push({
      source: 'proposal',
      label: `Proposal (${proposal.status})`,
      excerpt: truncate(compactWhitespace(`${proposal.title}${proposal.summary ? ` - ${proposal.summary}` : ''}${actionCount ? ` - ${actionCount} recorded action(s)` : ''}`)),
      score,
      createdAt: proposal.updated_at,
    })
  }

  for (const message of messagesResult.results) {
    const text = compactWhitespace(message.content)
    const score = scoreText(text, queryTokens, message.role === 'user' ? 2 : 1)
    if (score <= 0) continue
    snippets.push({
      source: 'message',
      label: `Recent ${message.role} message`,
      excerpt: truncate(text),
      score,
      createdAt: message.created_at,
    })
  }

  if (indexResult?.content) {
    const score = scoreText(indexResult.content, queryTokens, 1)
    if (score > 0) {
      snippets.push({
        source: 'search_index',
        label: 'Indexed project memory',
        excerpt: truncate(compactWhitespace(indexResult.content), 360),
        score,
        createdAt: indexResult.updated_at,
      })
    }
  }

  for (const doc of memoryDocsResult.results) {
    const text = compactWhitespace([doc.title, doc.summary || '', doc.markdown].filter(Boolean).join(' '))
    const recencyBoost =
      doc.layer_key === 'active_context' ? 6 : doc.layer_key === 'delivery' ? 5 : doc.layer_key === 'workflow' ? 4 : 3
    const score = scoreText(text, queryTokens, recencyBoost)
    if (score <= 0) continue
    snippets.push({
      source: 'memory_doc',
      label: `Memory layer: ${doc.layer_key}`,
      excerpt: truncate(compactWhitespace(doc.summary || doc.markdown), 340),
      score,
      createdAt: doc.updated_at,
    })
  }

  for (const entry of appMemoryResult.results) {
    const text = compactWhitespace(`${entry.title} ${entry.summary || ''} ${entry.content}`)
    const score = scoreText(text, queryTokens, entry.source_app === 'taskcenter' ? 2 : 3)
    if (score <= 0) continue
    snippets.push({
      source: 'app_memory',
      label: `${entry.source_app} ${entry.source_type}: ${entry.title}`,
      excerpt: truncate(compactWhitespace(entry.summary || entry.content), 320),
      score,
      createdAt: entry.updated_at,
    })
  }

  const ranked = snippets
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return (right.createdAt || 0) - (left.createdAt || 0)
    })
    .reduce<RagSnippet[]>((acc, snippet) => {
      const duplicate = acc.some(
        (existing) =>
          existing.source === snippet.source &&
          existing.label === snippet.label
      )
      if (!duplicate) acc.push(snippet)
      return acc
    }, [])
    .slice(0, Math.max(2, maxSnippets))

  return {
    promptContext: buildPromptContext(project?.name || projectId, ranked),
    snippets: ranked.map((snippet) => ({
      source: snippet.source,
      label: snippet.label,
      excerpt: snippet.excerpt,
    })),
    counts: {
      items: itemsResult.results.length,
      planningContexts: contextsResult.results.length,
      proposals: proposalsResult.results.length,
      messages: messagesResult.results.length,
      appMemoryEntries: appMemoryResult.results.length,
      memoryDocs: memoryDocsResult.results.length,
    },
  }
}

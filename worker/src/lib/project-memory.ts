import { newId } from './ids'
import { upsertAppMemoryEntry } from './app-memory'

type EnvBindings = {
  DB: D1Database
}

export const PROJECT_MEMORY_LAYER_ORDER = ['foundation', 'workflow', 'active_context', 'delivery'] as const

export type ProjectMemoryLayerKey = (typeof PROJECT_MEMORY_LAYER_ORDER)[number]

export type ProjectMemoryDocRecord = {
  id: string
  project_id: string
  layer_key: ProjectMemoryLayerKey
  title: string
  markdown: string
  summary: string | null
  source_context_json: string | null
  created_at: number
  updated_at: number
}

type MemoryDocDraft = {
  layerKey: ProjectMemoryLayerKey
  title: string
  markdown: string
  summary: string
  sourceContext: Record<string, unknown>
}

function compact(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function truncate(input: string, limit = 220): string {
  const normalized = compact(input)
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`
}

function parseJsonArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map((entry) => compact(String(entry))).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function formatList(items: string[], empty = '- None recorded yet.'): string {
  if (items.length === 0) return empty
  return items.map((item) => `- ${item}`).join('\n')
}

function formatOptionalLine(label: string, value?: string | null): string {
  return `- ${label}: ${value && value.trim() ? value.trim() : 'Not captured yet'}`
}

export async function listProjectMemoryDocs(
  env: EnvBindings,
  input: { tenantId: string; projectId: string }
): Promise<ProjectMemoryDocRecord[]> {
  const result = await env.DB.prepare(
    `SELECT id, project_id, layer_key, title, markdown, summary, source_context_json, created_at, updated_at
     FROM project_memory_docs
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY CASE layer_key
       WHEN 'foundation' THEN 1
       WHEN 'workflow' THEN 2
       WHEN 'active_context' THEN 3
       WHEN 'delivery' THEN 4
       ELSE 99
     END ASC, updated_at DESC`
  )
    .bind(input.tenantId, input.projectId)
    .all<ProjectMemoryDocRecord>()

  return result.results
}

async function buildProjectMemoryDrafts(
  env: EnvBindings,
  input: { tenantId: string; projectId: string }
): Promise<MemoryDocDraft[]> {
  const { tenantId, projectId } = input
  const [
    project,
    itemsResult,
    planningContext,
    proposalResult,
    githubLink,
    recentMessages,
    projectMembers,
    projectMemoryEntry,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, description, created_at, updated_at
       FROM projects
       WHERE tenant_id = ? AND id = ?
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{ id: string; name: string; description: string | null; created_at: number; updated_at: number } | null>(),
    env.DB.prepare(
      `SELECT kind, title, description, status, assignee_id, updated_at
       FROM items
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC
       LIMIT 120`
    )
      .bind(tenantId, projectId)
      .all<{
        kind: string
        title: string
        description: string | null
        status: string
        assignee_id: string | null
        updated_at: number
      }>(),
    env.DB.prepare(
      `SELECT id, plan_intent, execution_mode, onboarding_answers_json, qualifying_answers_json, markdown_bundle, created_at
       FROM planning_contexts
       WHERE tenant_id = ? AND (project_id = ? OR selected_project_id = ?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
      .bind(tenantId, projectId, projectId)
      .first<{
        id: string
        plan_intent: string
        execution_mode: string
        onboarding_answers_json: string
        qualifying_answers_json: string
        markdown_bundle: string | null
        created_at: number
      } | null>(),
    env.DB.prepare(
      `SELECT id, title, summary, status, impact_level, actions_json, updated_at
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
        impact_level: string
        actions_json: string
        updated_at: number
      }>(),
    env.DB.prepare(
      `SELECT repo_full_name, collaboration_mode, review_on_push
       FROM project_github_links
       WHERE tenant_id = ? AND project_id = ?
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{ repo_full_name: string; collaboration_mode: string | null; review_on_push: number | null } | null>(),
    env.DB.prepare(
      `SELECT role, content, created_at
       FROM agent_messages
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY created_at DESC
       LIMIT 8`
    )
      .bind(tenantId, projectId)
      .all<{ role: string; content: string; created_at: number }>(),
    env.DB.prepare(
      `SELECT member_id
       FROM project_member_assignments
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC`
    )
      .bind(tenantId, projectId)
      .all<{ member_id: string }>(),
    env.DB.prepare(
      `SELECT metadata_json
       FROM app_memory_entries
       WHERE tenant_id = ? AND project_id = ? AND source_app = 'taskcenter' AND source_type = 'project'
       ORDER BY updated_at DESC
       LIMIT 1`
    )
      .bind(tenantId, projectId)
      .first<{ metadata_json: string | null } | null>(),
  ])

  if (!project) {
    return []
  }

  const items = itemsResult.results
  const proposalRows = proposalResult.results
  const epics = items.filter((item) => item.kind === 'epic')
  const tasks = items.filter((item) => item.kind === 'task' || item.kind === 'story' || item.kind === 'feature' || item.kind === 'story_point')
  const taskStatusCounts = {
    todo: tasks.filter((item) => item.status === 'todo' || item.status === 'planned').length,
    inProgress: tasks.filter((item) => item.status === 'in_progress').length,
    review: tasks.filter((item) => item.status === 'review').length,
    done: tasks.filter((item) => item.status === 'done').length,
  }
  const draftProposals = proposalRows.filter((proposal) => proposal.status === 'draft').length
  const approvedProposals = proposalRows.filter((proposal) => proposal.status === 'approved').length
  const appliedProposals = proposalRows.filter((proposal) => proposal.status === 'applied').length

  const onboardingAnswers = parseJsonArray(planningContext?.onboarding_answers_json)
  const qualifyingAnswers = parseJsonArray(planningContext?.qualifying_answers_json)
  const planningBundlePreview = truncate(planningContext?.markdown_bundle || '', 700)
  const recentUserIntent = recentMessages.results
    .slice()
    .reverse()
    .filter((row) => row.role === 'user')
    .slice(-3)
    .map((row) => truncate(row.content, 180))
  const recentAssistantCarryForward = recentMessages.results
    .slice()
    .reverse()
    .filter((row) => row.role === 'assistant')
    .slice(-2)
    .map((row) => truncate(row.content, 180))

  const latestAppliedProposal = proposalRows.find((proposal) => proposal.status === 'applied')
  const projectMetadata = parseJson<Record<string, unknown>>(projectMemoryEntry?.metadata_json, {})
  const assignedMemberIds = projectMembers.results.map((row) => row.member_id).filter(Boolean)
  const ownershipMode = String(projectMetadata.ownershipMode || (assignedMemberIds.length > 0 ? 'collaborative' : 'agent_first'))
  const assignmentMode = String(projectMetadata.assignmentMode || 'auto_assign')
  const recentOpenProposals = proposalRows
    .filter((proposal) => proposal.status === 'draft' || proposal.status === 'approved')
    .slice(0, 4)
    .map((proposal) => `${proposal.title} (${proposal.status}, ${proposal.impact_level})`)

  const topEpics = epics
    .slice(0, 6)
    .map((epic) => `${epic.title}${epic.description ? ` - ${truncate(epic.description, 120)}` : ''}`)
  const activeTasks = tasks
    .filter((task) => task.status === 'in_progress' || task.status === 'review')
    .slice(0, 8)
    .map((task) => `${task.title} (${task.status}${task.assignee_id ? `, assignee ${task.assignee_id}` : ''})`)
  const nextTasks = tasks
    .filter((task) => task.status === 'todo' || task.status === 'planned')
    .slice(0, 8)
    .map((task) => `${task.title} (${task.status})`)

  return [
    {
      layerKey: 'foundation',
      title: 'Project Foundation',
      summary: truncate([project.name, project.description || '', planningContext?.plan_intent || ''].filter(Boolean).join(' - '), 220),
      sourceContext: {
        projectId,
        projectName: project.name,
        githubRepoFullName: githubLink?.repo_full_name || null,
        collaborationMode: githubLink?.collaboration_mode || 'agent_build',
      },
      markdown: [
        `# ${project.name}`,
        '',
        '## Mission',
        project.description?.trim() || 'Mission not captured yet.',
        '',
        '## Core Brief',
        formatOptionalLine('Primary planning intent', planningContext?.plan_intent),
        formatOptionalLine('Execution mode', planningContext?.execution_mode),
        formatOptionalLine('GitHub repo', githubLink?.repo_full_name),
        formatOptionalLine('Collaboration mode', githubLink?.collaboration_mode || 'agent_build'),
        formatOptionalLine('Review on push', githubLink ? (githubLink.review_on_push ? 'Enabled' : 'Disabled') : 'Disabled'),
        formatOptionalLine('Ownership model', ownershipMode),
        formatOptionalLine('Assignment mode', assignmentMode),
        formatOptionalLine('Assigned project members', assignedMemberIds.length ? assignedMemberIds.join(', ') : ownershipMode === 'agent_first' ? 'None - agents lead the first pass' : 'None recorded yet'),
        '',
        '## What The Agent Should Remember',
        formatList(onboardingAnswers.slice(0, 6), '- No onboarding answers captured yet.'),
        '',
        '## Key Qualification Signals',
        formatList(qualifyingAnswers.slice(0, 6), '- No qualifying answers captured yet.'),
      ].join('\n'),
    },
    {
      layerKey: 'workflow',
      title: 'Workflow Stack',
      summary: truncate(
        [
          planningContext?.plan_intent || 'No planning context yet',
          `${epics.length} epics`,
          `${tasks.length} work items`,
          `${draftProposals} draft proposals`,
        ].join(' - '),
        220
      ),
      sourceContext: {
        planningContextId: planningContext?.id || null,
        epicCount: epics.length,
        taskCount: tasks.length,
        proposalCount: proposalRows.length,
      },
      markdown: [
        '# Workflow Stack',
        '',
        '## Layer Model',
        '- Foundation: the durable brief, repo posture, and planning intent.',
        '- Workflow: how work should move from planning to proposal to applied state.',
        '- Active Context: what is currently in flight and what the agent should pick up next.',
        '- Delivery: proof of applied changes, review posture, and completion gates.',
        '',
        '## Current Planning Inputs',
        planningContext
          ? [
              `- Planning intent: ${planningContext.plan_intent}`,
              `- Execution mode: ${planningContext.execution_mode}`,
              planningBundlePreview ? `- Markdown bundle preview: ${planningBundlePreview}` : null,
            ]
              .filter(Boolean)
              .join('\n')
          : '- No planning context saved yet.',
        '',
        '## Existing Board Structure',
        `- Epics: ${epics.length}`,
        `- Work items: ${tasks.length}`,
        `- Status mix: ${taskStatusCounts.todo} todo/planned, ${taskStatusCounts.inProgress} in progress, ${taskStatusCounts.review} review, ${taskStatusCounts.done} done`,
        '',
        '## Top Epics',
        formatList(topEpics, '- No epics created yet.'),
      ].join('\n'),
    },
    {
      layerKey: 'active_context',
      title: 'Active Context',
      summary: truncate(
        [
          activeTasks[0] || 'No active tasks',
          recentUserIntent[0] || '',
          recentOpenProposals[0] || '',
        ].filter(Boolean).join(' - '),
        220
      ),
      sourceContext: {
        activeTaskCount: activeTasks.length,
        openProposalCount: recentOpenProposals.length,
        recentMessageCount: recentMessages.results.length,
      },
      markdown: [
        '# Active Context',
        '',
        '## In Flight Now',
        formatList(activeTasks, '- No active tasks are currently marked in progress or review.'),
        '',
        '## Next Up',
        formatList(nextTasks, '- No queued tasks captured yet.'),
        '',
        '## Open Proposals',
        formatList(recentOpenProposals, '- No draft or approved proposals waiting right now.'),
        '',
        '## Recent User Intent',
        formatList(recentUserIntent, '- No recent user chat captured yet.'),
        '',
        '## Recent Assistant Carry Forward',
        formatList(recentAssistantCarryForward, '- No assistant carry-forward captured yet.'),
      ].join('\n'),
    },
    {
      layerKey: 'delivery',
      title: 'Delivery And Evidence',
      summary: truncate(
        [
          latestAppliedProposal ? `Latest applied proposal: ${latestAppliedProposal.title}` : 'No applied proposal yet',
          githubLink?.repo_full_name ? `Repo: ${githubLink.repo_full_name}` : 'No repo linked',
        ].join(' - '),
        220
      ),
      sourceContext: {
        draftProposals,
        approvedProposals,
        appliedProposals,
        latestAppliedProposalId: latestAppliedProposal?.id || null,
      },
      markdown: [
        '# Delivery And Evidence',
        '',
        '## Proposal State',
        `- Draft proposals: ${draftProposals}`,
        `- Approved proposals: ${approvedProposals}`,
        `- Applied proposals: ${appliedProposals}`,
        '',
        '## Latest Applied Change',
        latestAppliedProposal
          ? formatList(
              [
                latestAppliedProposal.title,
                latestAppliedProposal.summary || 'No summary recorded.',
                `${parseJson<unknown[]>(latestAppliedProposal.actions_json, []).length} action(s) in payload`,
              ],
              '- No applied proposal yet.'
            )
          : '- No applied proposal yet.',
        '',
        '## Completion And Review Posture',
        formatOptionalLine('Linked repo', githubLink?.repo_full_name),
        formatOptionalLine('Collaboration mode', githubLink?.collaboration_mode || 'agent_build'),
        formatOptionalLine('Review on push', githubLink ? (githubLink.review_on_push ? 'Enabled' : 'Disabled') : 'Disabled'),
        '- Agents should treat applied proposals and board state as durable truth.',
        '- In collaborative work, review-ready or done claims should be backed by repo evidence or explicit user confirmation.',
      ].join('\n'),
    },
  ]
}

export async function refreshProjectMemoryDocs(
  env: EnvBindings,
  input: { tenantId: string; projectId: string }
): Promise<ProjectMemoryDocRecord[]> {
  const now = Date.now()
  const drafts = await buildProjectMemoryDrafts(env, input)
  const records: ProjectMemoryDocRecord[] = []

  for (const draft of drafts) {
    const existing = await env.DB.prepare(
      `SELECT id, created_at
       FROM project_memory_docs
       WHERE tenant_id = ? AND project_id = ? AND layer_key = ?
       LIMIT 1`
    )
      .bind(input.tenantId, input.projectId, draft.layerKey)
      .first<{ id: string; created_at: number } | null>()

    const id = existing?.id || newId('pmem')
    const createdAt = existing?.created_at || now

    await env.DB.prepare(
      `INSERT INTO project_memory_docs (
         id, tenant_id, project_id, layer_key, title, markdown, summary, source_context_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, project_id, layer_key)
       DO UPDATE SET
         title = excluded.title,
         markdown = excluded.markdown,
         summary = excluded.summary,
         source_context_json = excluded.source_context_json,
         updated_at = excluded.updated_at`
    )
      .bind(
        id,
        input.tenantId,
        input.projectId,
        draft.layerKey,
        draft.title,
        draft.markdown,
        draft.summary,
        JSON.stringify(draft.sourceContext),
        createdAt,
        now
      )
      .run()

    await upsertAppMemoryEntry(env, {
      tenantId: input.tenantId,
      projectId: input.projectId,
      sourceApp: 'taskcenter',
      sourceType: 'project_memory_doc',
      sourceKey: draft.layerKey,
      title: draft.title,
      content: draft.markdown,
      summary: draft.summary,
      metadata: { layerKey: draft.layerKey, sourceContext: draft.sourceContext },
    })

    records.push({
      id,
      project_id: input.projectId,
      layer_key: draft.layerKey,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      source_context_json: JSON.stringify(draft.sourceContext),
      created_at: createdAt,
      updated_at: now,
    })
  }

  return records
}

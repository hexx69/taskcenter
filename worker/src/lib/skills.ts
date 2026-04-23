import { newId } from './ids'
import type { EnvBindings, RequestContext } from './context'

export type WorkspaceSkillStatus = 'active' | 'suggested' | 'archived'
export type WorkspaceSkillSource = 'manual' | 'auto_created' | 'auto_suggested' | 'bundled'

export type WorkspaceSkillRecord = {
  id: string
  tenant_id: string
  name: string
  slug: string
  description: string
  instructions: string
  status: WorkspaceSkillStatus
  source: WorkspaceSkillSource
  pattern_key: string | null
  usage_count: number
  created_by: string
  created_at: number
  updated_at: number
}

const BUNDLED_WORKSPACE_SKILLS: Array<{
  name: string
  slug: string
  description: string
  instructions: string
}> = [
  {
    name: 'paperclip',
    slug: 'paperclip',
    description: 'Built-in control-plane coordination skill for issue work, approvals, comments, and heartbeat-style execution.',
    instructions: `# Paperclip Skill

Use this bundled skill when an agent needs to coordinate work through the control plane instead of doing the domain work directly.

## Core operating rules

1. Work in short heartbeats. Wake up, inspect assignments, do useful work, update state, and exit.
2. Always identify the company, assigned issue, and approval context before acting.
3. Prioritize in-progress work first, then todo work. Do not steal work already owned by another actor.
4. Always communicate durable state changes through backend-backed issue comments, status updates, approvals, and linked runs.
5. Treat approval follow-up as first-class work. If an approval resolves a task, close or update the issue instead of leaving the state ambiguous.

## Standard workflow

1. Confirm identity, company, and current run context.
2. Review inbox and assigned issues.
3. Checkout or claim the current issue before doing work.
4. Read compact issue context and only fetch the full thread when needed.
5. Execute the work.
6. Update issue status, write a useful comment, and record blockers explicitly.

## Coordination standard

- Comments explain what changed, why, and what should happen next.
- Status updates must reflect reality, not optimism.
- If blocked, mark the issue blocked before exiting.
- If approvals or governance gates apply, escalate instead of pretending the action is already allowed.
`,
  },
  {
    name: 'paperclip-create-agent',
    slug: 'paperclip-create-agent',
    description: 'Governance-aware hiring and agent creation workflow with role design, reporting line, runtime config, and approval submission.',
    instructions: `# Paperclip Create Agent

Use this skill when the task is to hire or define a new agent.

## Workflow

1. Confirm company context and permissions before drafting the hire.
2. Inspect existing agent roles so the new hire fits the operating org.
3. Choose the correct reporting line and role title.
4. Define adapter/runtime posture, capabilities, wakeup behavior, and day-one skills.
5. Link the hire to the source issue or business request when applicable.
6. Submit the hire as an approval-backed request instead of mutating the org silently.

## Required output

- role / title / purpose
- reports-to relationship
- runtime and wakeup policy
- required skills
- business justification
- linked issue or planning context

## Governance rule

If the user lacks permission to create the role directly, escalate through CEO or board approval rather than bypassing hiring flow.
`,
  },
  {
    name: 'paperclip-create-plugin',
    slug: 'paperclip-create-plugin',
    description: 'Plugin scaffolding and authoring skill for trusted worker/UI plugins, with manifest, worker, UI, and verification expectations.',
    instructions: `# Create a Paperclip Plugin

Use this skill when the work is to create, scaffold, or document a plugin.

## Preferred workflow

1. Start from the scaffold path rather than writing plugin boilerplate from scratch.
2. Define the manifest, worker, UI entry, and tests together.
3. Keep the UI self-contained and capability-scoped.
4. Use only supported worker/runtime capabilities.
5. Verify the plugin can be installed and surfaced correctly in the host product.

## Checklist

- manifest defines only required capabilities
- worker routes are minimal and explicit
- UI stays same-origin and self-contained
- tests cover the expected install/runtime path
- docs explain what the plugin does and how it should be used
`,
  },
  {
    name: 'para-memory-files',
    slug: 'para-memory-files',
    description: 'PARA-style file memory system for durable context, daily notes, operating patterns, and structured recall.',
    instructions: `# PARA Memory Files

Use this skill whenever the system needs to store or recall durable memory.

## Three layers

1. Knowledge graph: structured entities with durable facts.
2. Daily notes: chronological raw timeline of what happened.
3. Tacit knowledge: how the user or company operates.

## Rules

- Durable facts go into structured memory, not only chat.
- Repeated references should be promoted into entities.
- Never delete facts casually; supersede them when context changes.
- Capture user and company operating patterns separately from event logs.

## Best use

Use this for recurring execution patterns, company knowledge, important decisions, and project context that should survive across sessions.
`,
  },
]

async function ensureBundledWorkspaceSkills(env: EnvBindings, tenantId: string) {
  const existingCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM workspace_skills
     WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .first<{ count: number | null } | null>()

  if ((existingCount?.count || 0) > 0) return

  const now = Date.now()
  for (const skill of BUNDLED_WORKSPACE_SKILLS) {
    await env.DB.prepare(
      `INSERT INTO workspace_skills (
        id, tenant_id, name, slug, description, instructions, status, source, pattern_key, usage_count, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'bundled', NULL, 0, 'system', ?, ?)
      ON CONFLICT(tenant_id, slug)
      DO UPDATE SET
        description = excluded.description,
        instructions = excluded.instructions,
        source = excluded.source,
        updated_at = excluded.updated_at`
    )
      .bind(newId('skill'), tenantId, skill.name, skill.slug, skill.description, skill.instructions, now, now)
      .run()
  }
}

export function slugifySkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill'
}

export function normalizeSkillPattern(input: string): string {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b\d+\b/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function compact(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function buildSkillNameFromMessage(message: string): string {
  const cleaned = compact(message)
    .replace(/^(please|can you|could you|help me|i need|make sure|always|every time)\s+/i, '')
    .slice(0, 80)
  const words = cleaned.split(' ').filter(Boolean).slice(0, 5)
  const label = words.join(' ')
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Workflow Skill'
}

function buildSkillDescription(message: string) {
  const summary = compact(message).slice(0, 160)
  return `Reusable workflow for requests like: ${summary}`
}

function buildSkillInstructions(message: string) {
  const summary = compact(message)
  return [
    `Use this skill when the request matches or strongly resembles: "${summary}".`,
    'Workflow:',
    '1. Confirm only the missing critical inputs. Do not re-interview the user for things already implied by the repeated request.',
    '2. Reuse connected integrations, existing board context, and workspace memory before inventing a new process.',
    '3. Return a concise execution plan, concrete next actions, likely owners, and blockers.',
    '4. If the request affects tasks or project state, prefer durable backend-backed updates over temporary chat-only suggestions.',
    '5. If approvals, secrets, or admin-managed integrations are involved, call that out explicitly instead of pretending permissions are a personality trait.',
  ].join('\n')
}

export async function listWorkspaceSkills(
  env: EnvBindings,
  tenantId: string,
  status?: WorkspaceSkillStatus[]
) {
  await ensureBundledWorkspaceSkills(env, tenantId)
  const statuses = status && status.length > 0 ? status : null
  const query = statuses
    ? `SELECT * FROM workspace_skills WHERE tenant_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY status = 'active' DESC, usage_count DESC, updated_at DESC`
    : `SELECT * FROM workspace_skills WHERE tenant_id = ? ORDER BY status = 'active' DESC, usage_count DESC, updated_at DESC`
  const bindings = statuses ? [tenantId, ...statuses] : [tenantId]
  return env.DB.prepare(query).bind(...bindings).all<WorkspaceSkillRecord>()
}

export async function getWorkspaceSkillsByIds(env: EnvBindings, tenantId: string, skillIds: string[]) {
  if (!skillIds.length) {
    return { results: [] as WorkspaceSkillRecord[] }
  }

  return env.DB.prepare(
    `SELECT * FROM workspace_skills
     WHERE tenant_id = ? AND id IN (${skillIds.map(() => '?').join(', ')})
     ORDER BY status = 'active' DESC, usage_count DESC, updated_at DESC`
  )
    .bind(tenantId, ...skillIds)
    .all<WorkspaceSkillRecord>()
}

export async function createWorkspaceSkill(
  env: EnvBindings,
  context: Pick<RequestContext, 'tenantId' | 'userId'>,
  input: {
    name: string
    description: string
    instructions: string
    status?: WorkspaceSkillStatus
    source?: WorkspaceSkillSource
    patternKey?: string | null
  }
) {
  const now = Date.now()
  const skillId = newId('skill')
  const slug = slugifySkillName(input.name)
  await env.DB.prepare(
    `INSERT INTO workspace_skills (
      id, tenant_id, name, slug, description, instructions, status, source, pattern_key, usage_count, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(tenant_id, slug)
    DO UPDATE SET
      description = excluded.description,
      instructions = excluded.instructions,
      status = excluded.status,
      source = excluded.source,
      pattern_key = COALESCE(excluded.pattern_key, workspace_skills.pattern_key),
      updated_at = excluded.updated_at`
  )
    .bind(
      skillId,
      context.tenantId,
      input.name,
      slug,
      input.description,
      input.instructions,
      input.status || 'active',
      input.source || 'manual',
      input.patternKey || null,
      context.userId,
      now,
      now
    )
    .run()

  const row = await env.DB.prepare(
    `SELECT * FROM workspace_skills WHERE tenant_id = ? AND slug = ? LIMIT 1`
  )
    .bind(context.tenantId, slug)
    .first<WorkspaceSkillRecord | null>()

  return row
}

export async function incrementSkillUsage(env: EnvBindings, tenantId: string, skillIds: string[]) {
  if (!skillIds.length) return
  await env.DB.prepare(
    `UPDATE workspace_skills
     SET usage_count = usage_count + 1, updated_at = ?
     WHERE tenant_id = ? AND id IN (${skillIds.map(() => '?').join(', ')})`
  )
    .bind(Date.now(), tenantId, ...skillIds)
    .run()
}

export async function maybeCreateSkillFromRequest(
  env: EnvBindings,
  context: Pick<RequestContext, 'tenantId' | 'userId'>,
  input: {
    projectId: string
    message: string
  }
): Promise<{ skill: WorkspaceSkillRecord; reason: string } | null> {
  const patternKey = normalizeSkillPattern(input.message)
  if (patternKey.length < 24) return null

  const now = Date.now()
  const existingPattern = await env.DB.prepare(
    `SELECT id, request_count, suggested_skill_id
     FROM skill_request_patterns
     WHERE tenant_id = ? AND pattern_key = ?
     LIMIT 1`
  )
    .bind(context.tenantId, patternKey)
    .first<{ id: string; request_count: number; suggested_skill_id: string | null } | null>()

  if (existingPattern) {
    await env.DB.prepare(
      `UPDATE skill_request_patterns
       SET request_count = request_count + 1,
           example_request = ?,
           last_seen_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
      .bind(input.message, now, now, existingPattern.id)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO skill_request_patterns (
         id, tenant_id, project_id, pattern_key, example_request, request_count, created_at, updated_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
      .bind(newId('skpat'), context.tenantId, input.projectId, patternKey, input.message, now, now, now)
      .run()
  }

  const refreshed = await env.DB.prepare(
    `SELECT id, request_count, suggested_skill_id
     FROM skill_request_patterns
     WHERE tenant_id = ? AND pattern_key = ?
     LIMIT 1`
  )
    .bind(context.tenantId, patternKey)
    .first<{ id: string; request_count: number; suggested_skill_id: string | null } | null>()

  if (!refreshed || refreshed.suggested_skill_id) return null

  const explicitSkillIntent = /\b(make|turn|save|remember).{0,40}\bskill\b/i.test(input.message)
  const importantSignal = /\b(always|every time|important|repeat|repeatedly|standardize|template)\b/i.test(input.message)
  if (!explicitSkillIntent && !importantSignal && refreshed.request_count < 3) {
    return null
  }

  const skill = await createWorkspaceSkill(env, context, {
    name: buildSkillNameFromMessage(input.message),
    description: buildSkillDescription(input.message),
    instructions: buildSkillInstructions(input.message),
    status: explicitSkillIntent ? 'active' : 'suggested',
    source: explicitSkillIntent ? 'auto_created' : 'auto_suggested',
    patternKey,
  })

  if (!skill) return null

  await env.DB.prepare(
    `UPDATE skill_request_patterns
     SET suggested_skill_id = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(skill.id, Date.now(), refreshed.id)
    .run()

  return {
    skill,
    reason: explicitSkillIntent
      ? 'Created because the user explicitly asked to save this as a reusable skill.'
      : `Suggested because similar requests appeared ${refreshed.request_count} times.`,
  }
}

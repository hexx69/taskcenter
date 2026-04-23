import { generateText, streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { newId } from '../lib/ids'
import { resolveAllowedOpenRouterModels } from '../lib/model-catalog'
import { buildNorthstarRuntimePrompt, type ProjectAgentRuntimeContext, summarizeNorthstarHistory } from '../lib/northstar'
import { upsertProjectSearchIndex } from '../db/project-index'
import { buildProjectRagContext } from '../lib/project-rag'
import { listProjectMemoryDocs, refreshProjectMemoryDocs } from '../lib/project-memory'
import { ensureProjectExists } from '../lib/projects'
import { getWorkspaceSkillsByIds, incrementSkillUsage, maybeCreateSkillFromRequest } from '../lib/skills'
import { loadRuntimeToolSession } from '../lib/tool-registry'
import { assertUsageAllowed, recordUsageEvent, type UsageFeatureKey } from '../lib/usage'
import { decryptStoredSecret } from '../lib/secrets'
import { createDebugInvestigation, type InvestigationMode } from '../lib/debug'
import type {
  AgentAction,
  AgentName,
  AgentModelConfig,
  AgentModelProvider,
  AgentRunRecord,
  AgentRunStatus,
  AgentStepInput,
  AgentUsageWarning,
  CreateAgentRunInput,
} from './types'

type EnvBindings = {
  DB: D1Database
  AUTH_SESSION_SECRET?: string
  SECRET_ENCRYPTION_KEY?: string
  OPENAI_API_KEY?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  GATEWAY_BASE_URL?: string
  OPENROUTER_GATEWAY_TOKEN?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
}

export function extractAgentActions(input: string): AgentAction[] {
  const normalizeAction = (item: unknown): AgentAction | null => {
    if (!item || typeof item !== 'object') return null
    const maybe = item as { type?: string; payload?: unknown }
    if (!maybe.type || !maybe.payload || typeof maybe.payload !== 'object') return null

    if (maybe.type === 'task.upsert') {
      const payload = maybe.payload as {
        id?: string
        title?: string
        name?: string
        description?: string
        status?: string
        assignees?: string[]
        tags?: string[]
      }
      const title = payload.title || payload.name
      const normalizedStatus =
        payload.status === 'done' || payload.status === 'review' || payload.status === 'in_progress'
          ? payload.status
          : 'todo'
      if (!title) return null
      return {
        type: 'task.upsert',
        payload: {
          id: payload.id,
          title,
          status: normalizedStatus,
          assignees: payload.assignees,
          tags: payload.tags,
        },
      }
    }

    if (maybe.type === 'task.assign') {
      const payload = maybe.payload as {
        taskId?: string
        itemId?: string
        id?: string
        assigneeId?: string
        memberId?: string
        userId?: string
      }
      const taskId = payload.taskId || payload.itemId || payload.id
      const assigneeId = payload.assigneeId || payload.memberId || payload.userId
      if (!taskId || !assigneeId) return null
      return {
        type: 'task.assign',
        payload: {
          taskId,
          assigneeId,
        },
      }
    }

    if (maybe.type === 'epic.upsert') {
      const payload = maybe.payload as { id?: string; title?: string; name?: string; objective?: string }
      const title = payload.title || payload.name
      if (!title) return null
      return {
        type: 'epic.upsert',
        payload: {
          id: payload.id,
          title,
          objective: payload.objective,
        },
      }
    }

    if (maybe.type === 'member.assign') {
      const payload = maybe.payload as { memberId?: string }
      if (!payload.memberId) return null
      return {
        type: 'member.assign',
        payload: {
          memberId: payload.memberId,
        },
      }
    }

    if (maybe.type === 'repo.run') {
      const payload = maybe.payload as {
        baseBranch?: string
        branchName?: string
        commitMessage?: string
        prTitle?: string
        prBody?: string
        buildCommands?: string[]
        files?: Array<{ path?: string; content?: string }>
      }
      if (!payload.commitMessage || !payload.prTitle || !Array.isArray(payload.files) || payload.files.length === 0) {
        return null
      }
      const files = payload.files
        .filter((file): file is { path: string; content: string } => Boolean(file?.path))
        .map((file) => ({ path: file.path, content: file.content || '' }))
      if (files.length === 0) return null
      return {
        type: 'repo.run',
        payload: {
          baseBranch: payload.baseBranch,
          branchName: payload.branchName,
          commitMessage: payload.commitMessage,
          prTitle: payload.prTitle,
          prBody: payload.prBody,
          buildCommands: Array.isArray(payload.buildCommands) ? payload.buildCommands.filter(Boolean) : undefined,
          files,
        },
      }
    }

    return null
  }

  const parseCandidate = (candidate: string): AgentAction[] => {
    try {
      const parsed = JSON.parse(candidate) as unknown
      const actions = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown[] }).actions)
          ? (parsed as { actions: unknown[] }).actions
          : null

      if (!actions) return []
      return actions.map((item) => normalizeAction(item)).filter((item): item is AgentAction => Boolean(item))
    } catch {
      return []
    }
  }

  const trimmed = input.trim()
  const candidates = [trimmed]
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) candidates.push(fencedMatch[1].trim())

  for (const candidate of candidates) {
    const parsedActions = parseCandidate(candidate)
    if (parsedActions.length > 0) {
      return parsedActions
    }

    const embeddedMatches = candidate.match(/\{"actions":\[[\s\S]*?\]\}/g) || []
    const combinedActions = embeddedMatches.flatMap((match) => parseCandidate(match))
    if (combinedActions.length > 0) {
      return combinedActions
    }
  }

  return []
}

function detectInvestigationMode(message: string): InvestigationMode | null {
  const normalized = message.trim().toLowerCase()
  if (!normalized) return null
  if (/\b(review|pr|pull request|latest push|recent push|commit|diff)\b/.test(normalized)) {
    return 'push_review'
  }
  if (/\b(failing check|failed check|ci|pipeline|build failed|test failed)\b/.test(normalized)) {
    return 'failing_check'
  }
  if (/\b(billing|checkout|subscription|invoice|stripe)\b/.test(normalized) && /\b(drift|wrong|broken|fail|issue|reconcile)\b/.test(normalized)) {
    return 'billing_drift'
  }
  if (/\b(integration|github|jira|connector|oauth|sync)\b/.test(normalized) && /\b(broken|failed|issue|error|not working)\b/.test(normalized)) {
    return 'integration_failure'
  }
  if (/\b(route|routing|misrout|wrong agent|wrong tool)\b/.test(normalized)) {
    return 'agent_misroute'
  }
  if (/\b(debug|debugger|investigate|fix|broken|error|failure|why is|why did|not working)\b/.test(normalized)) {
    return 'bug_repro'
  }
  return null
}

type Context = {
  tenantId: string
  userId: string
  userEmail?: string | null
}

async function ensureProjectMemoryAvailable(env: EnvBindings, tenantId: string, projectId: string) {
  const existing = await listProjectMemoryDocs(env, { tenantId, projectId }).catch(() => [])
  if (existing.length > 0) return existing
  return refreshProjectMemoryDocs(env, { tenantId, projectId }).catch(() => [])
}

type StepBlueprint = {
  agentName: AgentName
  input: AgentStepInput
  systemPrompt: string
  modelConfig?: AgentModelConfig
  maxOutputTokens?: number
}

type ResolvedModelTarget = {
  provider: AgentModelProvider
  model: string
  apiKey: string
  baseURL?: string
  headers?: Record<string, string>
}

type StoredAdminApiKeyRow = {
  secret: string
  model: string
}

type StoredAgentConfigRow = {
  name: string
  prompt: string
  model: string
  provider: AgentModelProvider
}

type ProjectOperatingProfile = {
  projectName: string
  memberCount: number
  rosterText: string
  githubRepoFullName: string | null
  githubCollaborationMode: 'agent_build' | 'collaborative_review' | 'collaborative_needs_repo'
  githubReviewOnPush: boolean
  connectedIntegrations: string[]
  adminManagedIntegrations: string[]
  pendingAdminIntegrations: string[]
}

const OPENROUTER_DEFAULT_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/fd39fc50879a94e5f06cf5c9b48549d4/taskcenter/openrouter/v1'
const GATEWAY_DEFAULT_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/fd39fc50879a94e5f06cf5c9b48549d4/taskcenter/compat'
const GATEWAY_DEFAULT_MODEL = 'best-free'
const GATEWAY_MODEL_CANDIDATES = [GATEWAY_DEFAULT_MODEL] as const

const OPENROUTER_FREE_MODEL_CANDIDATES = [
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-2.0-flash-thinking-exp:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemma-3-27b-it:free',
] as const

const OPENROUTER_FAST_FREE_CANDIDATES = [
  'google/gemini-2.0-flash-exp:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'google/gemma-3-27b-it:free',
  'deepseek/deepseek-chat-v3-0324:free',
] as const

const OPENROUTER_REASONING_FREE_CANDIDATES = [
  'google/gemini-2.0-flash-thinking-exp:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
] as const

function isOpenRouterAutoModel(model?: string | null): boolean {
  if (!model) return true
  const normalized = model.trim().toLowerCase()
  return [
    'auto',
    'free',
    'best-free',
    'auto/free',
    'openrouter:auto',
    'openrouter:free',
    'openrouter/best-free',
  ].includes(normalized)
}

function isOpenRouterFastFreeModel(model?: string | null): boolean {
  if (!model) return false
  return ['fast-free', 'openrouter:fast-free', 'openrouter/fast-free'].includes(model.trim().toLowerCase())
}

function isOpenRouterReasoningFreeModel(model?: string | null): boolean {
  if (!model) return false
  return ['reasoning-free', 'openrouter:reasoning-free', 'openrouter/reasoning-free'].includes(model.trim().toLowerCase())
}

function resolveOpenRouterBaseUrl(env: EnvBindings): string {
  return env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL
}

function resolveGatewayBaseUrl(env: EnvBindings): string {
  return env.GATEWAY_BASE_URL || GATEWAY_DEFAULT_BASE_URL
}

function isWorkersAiModel(model?: string | null): boolean {
  return Boolean(model?.trim().startsWith('workers-ai/'))
}

function buildOpenRouterCandidates(model?: string | null): string[] {
  if (isOpenRouterAutoModel(model)) {
    return [...OPENROUTER_FREE_MODEL_CANDIDATES]
  }

  if (isOpenRouterFastFreeModel(model)) {
    const prioritized = new Set<string>(OPENROUTER_FAST_FREE_CANDIDATES)
    return [...OPENROUTER_FAST_FREE_CANDIDATES, ...OPENROUTER_FREE_MODEL_CANDIDATES.filter((candidate) => !prioritized.has(candidate))]
  }

  if (isOpenRouterReasoningFreeModel(model)) {
    const prioritized = new Set<string>(OPENROUTER_REASONING_FREE_CANDIDATES)
    return [...OPENROUTER_REASONING_FREE_CANDIDATES, ...OPENROUTER_FREE_MODEL_CANDIDATES.filter((candidate) => !prioritized.has(candidate))]
  }

  const normalized = model?.trim()
  if (!normalized) {
    return [...OPENROUTER_FREE_MODEL_CANDIDATES]
  }

  const remainder = OPENROUTER_FREE_MODEL_CANDIDATES.filter((candidate) => candidate !== normalized)
  return [normalized, ...remainder]
}

async function buildOpenRouterCandidatesWithCatalog(env: EnvBindings, model?: string | null): Promise<string[]> {
  const discovered = await resolveAllowedOpenRouterModels(env, model).catch(() => [])
  return discovered.length > 0 ? discovered : buildOpenRouterCandidates(model)
}

function composeStructuredAgentPrompt(basePrompt: string, lines: string[]): string {
  return [basePrompt.trim(), ...lines].join('\n')
}

function buildProjectModeSummary(profile: ProjectOperatingProfile): string {
  return JSON.stringify({
    projectName: profile.projectName,
    memberCount: profile.memberCount,
    githubRepoFullName: profile.githubRepoFullName,
    collaborationMode: profile.githubCollaborationMode,
    reviewOnPush: profile.githubReviewOnPush,
    connectedIntegrations: profile.connectedIntegrations,
    adminManagedIntegrations: profile.adminManagedIntegrations,
    pendingAdminIntegrations: profile.pendingAdminIntegrations,
  })
}

function buildStepBlueprints(
  input: CreateAgentRunInput,
  storedConfigs: Partial<Record<AgentName, StoredAgentConfigRow>>,
  profile: ProjectOperatingProfile
): StepBlueprint[] {
  const normalizedPrompt = input.prompt.trim()
  const resolveAgentConfig = (
    agentName: AgentName,
    defaultPrompt: string,
    contractLines: string[],
    fallbackModel: string
  ) => {
    const stored = storedConfigs[agentName]
    const prompt = composeStructuredAgentPrompt(stored?.prompt || defaultPrompt, contractLines)
    if (!stored) {
      return {
        prompt,
        modelConfig: {
          provider: agentName === 'task_decomposer' ? 'gateway' : 'gateway',
          model: fallbackModel,
        } satisfies AgentModelConfig,
      }
    }
    return {
      prompt,
      modelConfig: {
        provider: stored.provider,
        model: stored.model,
      } satisfies AgentModelConfig,
    }
  }

  const planningAgent = resolveAgentConfig(
    'planning_analyst',
    'You are TaskCenter Planning Analyst. Turn ambiguous requests into a grounded project brief that downstream agents can safely act on.',
    [
      'Return only valid JSON. No markdown. No prose before or after the JSON.',
      'Your output is the canonical planning brief for downstream TaskCenter sub-agents.',
      'Required JSON shape:',
      '{"requestType":"new_build"|"iteration"|"review"|"bugfix","summary":"string","objectives":["string"],"constraints":["string"],"assumptions":["string"],"risks":["string"],"dependencies":["string"],"deliverables":["string"],"successCriteria":["string"],"repoSignals":["string"],"collaborationSignals":["string"],"openQuestions":["string"]}',
      'Rules:',
      '- Prefer concrete product and engineering language.',
      '- Infer the safest assumption when the user is underspecified, and put it in assumptions.',
      '- Use repoSignals for anything that suggests GitHub, an existing codebase, commits, pull requests, diffs, CI, or review.',
      '- Use collaborationSignals for anything that suggests teammates, assignees, reviewers, or shared ownership.',
      '- Keep arrays short, high-signal, and free of filler.',
      '- Never invent launch success, integrations, analytics, or completed work.',
    ],
    'best-free'
  )
  const repoStrategistAgent = resolveAgentConfig(
    'repo_strategist',
    'You are TaskCenter Repo Strategist. Decide when GitHub access is optional, required, or blocking, and define the review posture for collaborative work.',
    [
      'Return only valid JSON.',
      'Required JSON shape:',
      '{"deliveryMode":"agent_build"|"collaborative_review"|"collaborative_needs_repo","githubPolicy":{"repoRequired":true|false,"reason":"string","linkedRepoExpectation":"string","reviewTrigger":"push"|"manual"|"none"},"evidenceSources":["string"],"handoffStrategy":["string"],"blockingIssues":["string"]}',
      'Rules:',
      '- If the project has active collaborators, existing code, or repo/diff/commit language, prefer collaborative_review or collaborative_needs_repo.',
      '- collaborative_needs_repo means teammates are involved but GitHub access is missing or not linked yet.',
      '- agent_build is only for greenfield or solo execution where the AI can scaffold and push later.',
      '- Require evidence from repo activity before recommending status changes based on implementation progress.',
      '- Do not claim that review can be automated unless a repo or push-based workflow exists.',
    ],
    'best-free'
  )
  const integrationSpecialistAgent = resolveAgentConfig(
    'integration_specialist',
    'You are TaskCenter Integration Specialist. Decide which integrations matter for this project, who must configure them, and which blockers are operational versus optional.',
    [
      'Return only valid JSON.',
      'Required JSON shape:',
      '{"recommendedIntegrations":[{"key":"string","name":"string","status":"ready"|"needs_user_connect"|"needs_admin_config"|"optional","owner":"user"|"admin","reason":"string","supports":["string"]}],"automationOpportunities":["string"],"blockedBy":["string"]}',
      'Rules:',
      '- Prefer GitHub for collaborative code review, Jira for issue intake, and Slack/webhooks/Zapier/Make/Pipedream for routing updates when relevant.',
      '- Use needs_admin_config for workspace-managed analytics or any integration that should not depend on a random teammate pasting secrets into the void.',
      '- Do not recommend integrations that are irrelevant to the request just to cosplay as an ecosystem.',
      '- automationOpportunities should be short, practical, and tied to the board or review flow.',
      '- blockedBy should call out missing admin setup, missing tokens, or missing repo linkage plainly.',
    ],
    'best-free'
  )
  const decomposerAgent = resolveAgentConfig(
    'task_decomposer',
    'You are TaskCenter Task Decomposer. Break approved work into durable epics, stories, and tasks that can survive real implementation instead of collapsing into vague motivational wallpaper.',
    [
      'Return only valid JSON. No markdown. No prose before or after the JSON.',
      'Required JSON shape:',
      '{"summary":"string","epics":[{"title":"string","objective":"string","stories":[{"title":"string","tasks":[{"title":"string","status":"todo","tags":["string"],"doneCriteria":["string"]}]}]}],"dependencies":[{"from":"string","to":"string","reason":"string"}]}',
      'Rules:',
      '- Prefer 2-5 epics max.',
      '- Each story should group one coherent slice of implementation or review work.',
      '- Each task must be small, actionable, implementation-oriented, and have concrete doneCriteria.',
      '- Allowed task status values: todo, in_progress, review, done. Default to todo.',
      '- Tags should describe function such as frontend, backend, api, auth, billing, ai, admin, docs, qa, infra, review.',
      '- Do not create fake owners, dates, estimates, or imaginary repos.',
    ],
    'fast-free'
  )
  const assignmentAgent = resolveAgentConfig(
    'assignment_router',
    'You are TaskCenter Assignment Router. Match work to the right executor: AI, human, or hybrid handoff.',
    [
      'Return only valid JSON.',
      'Required JSON shape:',
      '{"routing":[{"workItem":"string","lane":"ai"|"human"|"hybrid","idealOwner":"string","reason":"string","confidence":"high"|"medium"|"low","evidenceRequired":["string"]}],"humanReviewRequired":["string"]}',
      'Rules:',
      '- Route drafting, structured analysis, boilerplate implementation, and repeatable review preparation to ai when safe.',
      '- Route approvals, secrets, billing, legal, design signoff, and ambiguous product calls to human unless explicitly scoped.',
      '- Use hybrid when AI can prepare or review but a human should confirm or finish.',
      '- If collaborative review mode is active, prefer humans for final merge approval and status transitions to done.',
      '- Be conservative with confidence and evidenceRequired.',
    ],
    'best-free'
  )
  const codeReviewerAgent = resolveAgentConfig(
    'code_reviewer',
    'You are TaskCenter Code Reviewer. Define what evidence and checks are required before work can move to review or done.',
    [
      'Return only valid JSON.',
      'Required JSON shape:',
      '{"reviewPlan":{"style":"push_diff_review"|"manual_review","summary":"string"},"reviewChecks":[{"name":"string","why":"string","requiredEvidence":["string"]}],"doneTransitionRules":[{"status":"review"|"done","when":"string","reason":"string"}],"autoProgressGuards":["string"],"humanApprovalRequired":["string"]}',
      'Rules:',
      '- Prefer push_diff_review when a linked GitHub repo or commit-based workflow is present.',
      '- reviewChecks should resemble a practical CodeRabbit or Greptile review checklist: changed scope, regression risk, tests, security, migration risk, and missing follow-through.',
      '- doneTransitionRules must require evidence, not vibes and certainly not corporate astrology.',
      '- autoProgressGuards should prevent false completion when evidence is partial, stale, or disconnected from board items.',
      '- Use humanApprovalRequired for anything that still needs an explicit reviewer or owner decision.',
    ],
    'reasoning-free'
  )
  const executionAgent = resolveAgentConfig(
    'execution_planner',
    'You are TaskCenter Execution Planner. Synthesize the upstream outputs into a realistic sequence of work, review, and completion gates.',
    [
      'Return only valid JSON.',
      'Required JSON shape:',
      '{"milestones":[{"title":"string","outcome":"string","checkpoints":["string"]}],"criticalPath":["string"],"nextActions":["string"],"recoveryPlan":["string"]}',
      'Rules:',
      '- Order milestones so dependencies, repo access, and review gates make sense.',
      '- Checkpoints should be approval or verification gates, not vague status updates.',
      '- nextActions should be the immediate 3-5 steps after planning.',
      '- recoveryPlan should describe what to do when GitHub is missing, evidence is incomplete, or a collaborator push does not cleanly map to board progress.',
    ],
    'fast-free'
  )
  return [
    {
      agentName: 'planning_analyst',
      input: {
        summary: 'Analyze the request and extract a grounded planning brief',
        payload: {
          prompt: normalizedPrompt,
          projectOperatingProfile: buildProjectModeSummary(profile),
        },
      },
      systemPrompt: planningAgent.prompt,
      modelConfig: planningAgent.modelConfig,
      maxOutputTokens: 700,
    },
    {
      agentName: 'repo_strategist',
      input: {
        summary: 'Decide delivery mode, GitHub requirements, and review posture',
        payload: {
          source: 'planning_analyst',
          projectOperatingProfile: buildProjectModeSummary(profile),
        },
      },
      systemPrompt: repoStrategistAgent.prompt,
      modelConfig: repoStrategistAgent.modelConfig,
      maxOutputTokens: 500,
    },
    {
      agentName: 'integration_specialist',
      input: {
        summary: 'Recommend the right integrations, setup owners, and automation hooks',
        payload: {
          source: 'repo_strategist',
          projectOperatingProfile: buildProjectModeSummary(profile),
        },
      },
      systemPrompt: integrationSpecialistAgent.prompt,
      modelConfig: integrationSpecialistAgent.modelConfig,
      maxOutputTokens: 650,
    },
    {
      agentName: 'task_decomposer',
      input: {
        summary: 'Create an execution-ready epic, story, and task breakdown',
        payload: {
          source: 'integration_specialist',
          requestedTask: input.requestedTask ?? null,
        },
      },
      systemPrompt: decomposerAgent.prompt,
      modelConfig: decomposerAgent.modelConfig,
      maxOutputTokens: 900,
    },
    {
      agentName: 'assignment_router',
      input: {
        summary: 'Map tasks to AI vs human execution lanes',
        payload: {
          requestedTask: input.requestedTask ?? null,
          source: 'task_decomposer',
          projectOperatingProfile: buildProjectModeSummary(profile),
        },
      },
      systemPrompt: assignmentAgent.prompt,
      modelConfig: assignmentAgent.modelConfig,
      maxOutputTokens: 650,
    },
    {
      agentName: 'code_reviewer',
      input: {
        summary: 'Define review checks, evidence thresholds, and safe done rules',
        payload: {
          source: 'assignment_router',
          projectOperatingProfile: buildProjectModeSummary(profile),
        },
      },
      systemPrompt: codeReviewerAgent.prompt,
      modelConfig: codeReviewerAgent.modelConfig,
      maxOutputTokens: 800,
    },
    {
      agentName: 'execution_planner',
      input: {
        summary: 'Build execution order, checkpoints, and recovery plan',
        payload: {
          source: 'code_reviewer',
          projectOperatingProfile: buildProjectModeSummary(profile),
        },
      },
      systemPrompt: executionAgent.prompt,
      modelConfig: executionAgent.modelConfig,
      maxOutputTokens: 700,
    },
  ]
}

async function loadStoredAgentConfigs(env: EnvBindings, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT name, prompt, model, provider
     FROM admin_agent_configs
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY sort_order ASC, updated_at DESC`
  )
    .bind(tenantId)
    .all<StoredAgentConfigRow>()

  const byAgentName: Partial<Record<AgentName, StoredAgentConfigRow>> = {}
  for (const row of rows.results) {
    const normalized = row.name.trim().toLowerCase()
    if (normalized === 'orchestrator') continue
    if (normalized === 'planning analyst') byAgentName.planning_analyst = row
    if (normalized === 'repo strategist') byAgentName.repo_strategist = row
    if (normalized === 'integration specialist') byAgentName.integration_specialist = row
    if (normalized === 'task decomposer') byAgentName.task_decomposer = row
    if (normalized === 'assignment router') byAgentName.assignment_router = row
    if (normalized === 'code reviewer') byAgentName.code_reviewer = row
    if (normalized === 'execution planner') byAgentName.execution_planner = row
  }
  return byAgentName
}

async function loadStoredOrchestratorPrompt(env: EnvBindings, tenantId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT prompt
     FROM admin_agent_configs
     WHERE tenant_id = ? AND is_active = 1 AND LOWER(name) = 'orchestrator'
     ORDER BY sort_order ASC, updated_at DESC
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ prompt: string } | null>()

  return row?.prompt || null
}

async function resolveStoredApiKey(
  env: EnvBindings,
  tenantId: string,
  provider: AgentModelProvider,
  preferredModel?: string
): Promise<string | null> {
  const result = await env.DB.prepare(
    `SELECT secret, model
     FROM admin_api_keys
     WHERE tenant_id = ? AND provider = ? AND is_active = 1
     ORDER BY CASE WHEN model = ? THEN 0 ELSE 1 END, updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(tenantId, provider, preferredModel || '')
    .first<StoredAdminApiKeyRow>()

  return result?.secret ? decryptStoredSecret(env, result.secret) : null
}

async function resolveDefaultModelConfig(env: EnvBindings, tenantId: string): Promise<AgentModelConfig | undefined> {
  const runtimeConfig = await env.DB.prepare(
    `SELECT primary_provider, primary_model, fallback_provider, fallback_model
     FROM admin_runtime_config
     WHERE tenant_id = ?
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{
      primary_provider: AgentModelProvider
      primary_model: string
      fallback_provider: AgentModelProvider | null
      fallback_model: string | null
    } | null>()

  if (runtimeConfig) {
    return {
      provider: runtimeConfig.primary_provider,
      model: runtimeConfig.primary_model,
      fallbackProvider: runtimeConfig.fallback_provider || undefined,
      fallbackModel: runtimeConfig.fallback_model || undefined,
    }
  }

  const adminDefault = await env.DB.prepare(
    `SELECT provider, model
     FROM admin_api_keys
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{ provider: AgentModelProvider; model: string } | null>()

  if (adminDefault) {
    return {
      provider: adminDefault.provider,
      model: adminDefault.model,
    }
  }

  if (env.OPENROUTER_GATEWAY_TOKEN) {
    return { provider: 'gateway', model: GATEWAY_DEFAULT_MODEL, fallbackProvider: 'gateway', fallbackModel: 'fast-free' }
  }

  if (env.OPENROUTER_API_KEY) {
    return { provider: 'openrouter', model: 'best-free' }
  }

  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return { provider: 'gemini', model: 'gemini-2.0-flash' }
  }

  if (env.OPENAI_API_KEY) {
    return { provider: 'openai', model: 'gpt-4o-mini' }
  }

  if (env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }
  }

  return undefined
}

async function resolveApiKey(
  env: EnvBindings,
  tenantId: string,
  provider: AgentModelProvider,
  preferredModel?: string,
  inlineApiKey?: string
): Promise<string | null> {
  if (inlineApiKey) return inlineApiKey

  const storedApiKey = await resolveStoredApiKey(env, tenantId, provider, preferredModel)
  if (storedApiKey) return storedApiKey

  const envMap: Record<AgentModelProvider, string> = {
    gateway: 'OPENROUTER_GATEWAY_TOKEN',
    gemini: 'GOOGLE_GENERATIVE_AI_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  }
  const envKey = envMap[provider]
  const resolved = ((env as unknown as Record<string, string | undefined>)[envKey] || null)
  if (resolved) return resolved
  if (provider === 'openrouter') {
    return env.OPENROUTER_GATEWAY_TOKEN || null
  }
  return null
}

async function resolveModelTargets(env: EnvBindings, tenantId: string, config?: AgentModelConfig): Promise<{
  primary: ResolvedModelTarget[]
  fallback: ResolvedModelTarget[]
}> {
  const effectiveConfig = config || (await resolveDefaultModelConfig(env, tenantId))
  const primaryProvider = effectiveConfig?.provider ?? 'gateway'
  const primaryModel = effectiveConfig?.model || GATEWAY_DEFAULT_MODEL
  const primaryKey = await resolveApiKey(env, tenantId, primaryProvider, primaryModel, config?.apiKey)

  const fallbackProvider = effectiveConfig?.fallbackProvider
  const fallbackModel = effectiveConfig?.fallbackModel
  const fallbackKey = fallbackProvider
    ? await resolveApiKey(env, tenantId, fallbackProvider, fallbackModel, effectiveConfig?.fallbackApiKey)
    : null

  const buildTargets = async (
    provider: AgentModelProvider | undefined,
    model: string | undefined,
    apiKey: string | null
  ): Promise<ResolvedModelTarget[]> => {
    if (!provider || !apiKey) return []

    if (provider === 'gateway') {
      const normalized = model?.trim()
      const useWorkersAi = isWorkersAiModel(normalized)
      const candidates = useWorkersAi
        ? normalized
          ? [normalized, ...GATEWAY_MODEL_CANDIDATES.filter((candidate) => candidate !== normalized)]
          : [...GATEWAY_MODEL_CANDIDATES]
        : await buildOpenRouterCandidatesWithCatalog(env, normalized || GATEWAY_DEFAULT_MODEL)
      const baseURL = useWorkersAi ? resolveGatewayBaseUrl(env) : resolveOpenRouterBaseUrl(env)
      return candidates.map((candidate) => ({
        provider,
        model: candidate,
        apiKey,
        baseURL,
      }))
    }

    if (provider === 'openrouter') {
      const baseURL = resolveOpenRouterBaseUrl(env)
      const candidates = await buildOpenRouterCandidatesWithCatalog(env, model)
      return candidates.map((candidate) => ({
        provider,
        model: candidate,
        apiKey,
        baseURL,
      }))
    }

    if (!model) return []

    return [
      {
        provider,
        model,
        apiKey,
      },
    ]
  }

  return {
    primary: await buildTargets(primaryProvider, primaryModel, primaryKey),
    fallback: await buildTargets(fallbackProvider, fallbackModel, fallbackKey),
  }
}

async function logAgentUsage(
  env: EnvBindings,
  context: Context,
  input: {
    actionType: string
    agentName: string
    projectId: string
    projectName?: string
    status: 'success' | 'error' | 'pending'
    modelName?: string
    provider?: string
    tokensInput?: number
    tokensOutput?: number
    requestPreview?: string
    responsePreview?: string
    errorMessage?: string
    responseTimeMs?: number
    metadata?: Record<string, unknown>
  }
) {
  await env.DB.prepare(
    `INSERT INTO agent_action_logs (
      id, tenant_id, user_id, user_email, action_type, agent_name, project_id, project_name,
      status, error_message, tokens_used, tokens_input, tokens_output, model_name,
      api_endpoint, api_provider, response_time_ms, metadata, request_preview, response_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('alog'),
      context.tenantId,
      context.userId,
      context.userEmail || context.userId,
      input.actionType,
      input.agentName,
      input.projectId,
      input.projectName || input.projectId,
      input.status,
      input.errorMessage || null,
      (input.tokensInput ?? 0) + (input.tokensOutput ?? 0),
      input.tokensInput ?? 0,
      input.tokensOutput ?? 0,
      input.modelName || null,
      '/api/agents',
      input.provider || null,
      input.responseTimeMs ?? null,
      JSON.stringify(input.metadata || {}),
      (input.requestPreview || '').slice(0, 500),
      (input.responsePreview || '').slice(0, 500)
    )
    .run()
}

export async function generateTenantAiText(
  env: EnvBindings,
  context: Context,
  input: {
    featureKey: UsageFeatureKey
    system: string
    prompt?: string
    messages?: ModelMessage[]
    modelConfig?: AgentModelConfig
    maxOutputTokens?: number
    tools?: ToolSet
    maxSteps?: number
    metadata?: Record<string, unknown>
  }
) {
  await assertUsageAllowed(env, context.tenantId, context.userId)
  const startedAt = Date.now()

  try {
    const result = await generateWithFallback(env, context.tenantId, input.modelConfig, {
      system: input.system,
      prompt: input.prompt,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      tools: input.tools,
      maxSteps: input.maxSteps,
    })

    await recordUsageEvent(env, context, {
      featureKey: input.featureKey,
      provider: result.usedProvider,
      model: result.usedModel,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      status: 'success',
      metadata: input.metadata,
    })

    await logAgentUsage(env, context, {
      actionType: input.featureKey,
      agentName: 'shared-ai-runtime',
      projectId: String(input.metadata?.projectId || 'workspace'),
      status: 'success',
      modelName: result.usedModel,
      provider: result.usedProvider,
      tokensInput: result.usage.inputTokens,
      tokensOutput: result.usage.outputTokens,
      requestPreview: input.prompt || JSON.stringify(input.messages || []).slice(0, 500),
      responsePreview: result.text,
      responseTimeMs: Date.now() - startedAt,
      metadata: input.metadata,
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI generation failed'
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined
    await recordUsageEvent(env, context, {
      featureKey: input.featureKey,
      status: code === 'usage_limit_reached' ? 'blocked' : 'error',
      metadata: { ...input.metadata, message },
    })
    throw error
  }
}

export async function streamTenantAiText(
  env: EnvBindings,
  context: Context,
  input: {
    featureKey: UsageFeatureKey
    system: string
    prompt?: string
    messages?: ModelMessage[]
    maxOutputTokens?: number
    tools?: ToolSet
    maxSteps?: number
    onChunk?: (chunk: string) => void
  }
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; usedProvider: string; usedModel: string }> {
  await assertUsageAllowed(env, context.tenantId, context.userId)

  const targets = await resolveModelTargets(env, context.tenantId, undefined)
  const tryTargets = [...targets.primary, ...targets.fallback]
  if (tryTargets.length === 0) {
    return { text: 'No model configured.', usage: { inputTokens: 0, outputTokens: 0 }, usedProvider: 'gateway', usedModel: 'none' }
  }

  const target = tryTargets[0]!
  const model = createProviderModel(target)
  const stopWhen = input.tools && input.maxSteps ? stepCountIs(input.maxSteps) : undefined

  const stream = input.messages
    ? streamText({ model, system: input.system, messages: input.messages, maxOutputTokens: input.maxOutputTokens, tools: input.tools, stopWhen })
    : streamText({ model, system: input.system, prompt: input.prompt ?? '', maxOutputTokens: input.maxOutputTokens, tools: input.tools, stopWhen })

  let fullText = ''
  for await (const delta of stream.textStream) {
    fullText += delta
    input.onChunk?.(delta)
  }

  const usage = await stream.usage
  return {
    text: fullText,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    usedProvider: target.provider,
    usedModel: target.model,
  }
}

export async function logAgentActionEvent(
  env: EnvBindings,
  context: Context,
  input: {
    projectId: string
    projectAgentId?: string | null
    runId?: string | null
    sourceMessageId?: string | null
    eventType: 'dry_run' | 'applied' | 'rejected'
    actions: unknown[]
  }
) {
  const project = await ensureProjectExists(env, context.tenantId, input.projectId)
  if (!project) {
    throw new Error(`Project ${input.projectId} was not found for this workspace.`)
  }

  await env.DB.prepare(
    `INSERT INTO agent_action_events (
      id,
      tenant_id,
      project_id,
      project_agent_id,
      run_id,
      source_message_id,
      actions_json,
      event_type,
      created_by,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('aevt'),
      context.tenantId,
      input.projectId,
      input.projectAgentId ?? null,
      input.runId ?? null,
      input.sourceMessageId ?? null,
      JSON.stringify(input.actions),
      input.eventType,
      context.userId,
      Date.now()
    )
    .run()
}

function createProviderModel(target: ResolvedModelTarget) {
  if (target.provider === 'gemini') {
    const google = createGoogleGenerativeAI({ apiKey: target.apiKey })
    return google(target.model)
  }

  if (target.provider === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: target.apiKey })
    return anthropic(target.model)
  }

  const openai = createOpenAI({
    apiKey: target.apiKey,
    baseURL: target.provider === 'openrouter' || target.provider === 'gateway' ? target.baseURL || OPENROUTER_DEFAULT_BASE_URL : undefined,
    headers: target.provider === 'openrouter' ? target.headers : undefined,
  })
  return target.provider === 'openrouter' || target.provider === 'gateway' ? openai.chat(target.model) : openai(target.model)
}

async function generateWithFallback(
  env: EnvBindings,
  tenantId: string,
  modelConfig: AgentModelConfig | undefined,
  input: { system: string; prompt?: string; messages?: ModelMessage[]; maxOutputTokens?: number; tools?: ToolSet; maxSteps?: number }
) {
  const effectiveConfig = modelConfig || (await resolveDefaultModelConfig(env, tenantId))
  const targets = await resolveModelTargets(env, tenantId, modelConfig)
  const tryTargets = [...targets.primary, ...targets.fallback]
  const attemptedModels: string[] = []
  const requestedProvider = effectiveConfig?.provider ?? 'gateway'
  const requestedModel = effectiveConfig?.model || GATEWAY_DEFAULT_MODEL
  if (tryTargets.length === 0) {
    return {
      text: 'No model API key configured for the selected provider. Configure Cloudflare Gateway, OpenRouter, or another backend model provider first.',
      usage: { inputTokens: 0, outputTokens: 0 },
      requestedProvider,
      requestedModel,
      usedModel: 'none',
      usedProvider: 'gateway',
      attemptedModels,
      warning: 'missing_credentials' as AgentUsageWarning,
      toolCalls: [] as unknown[],
      toolResults: [] as unknown[],
    }
  }

  let lastError: unknown = null
  for (let index = 0; index < tryTargets.length; index += 1) {
    const target = tryTargets[index]
    attemptedModels.push(`${target.provider}:${target.model}`)
    try {
      const model = createProviderModel(target)
      const stopWhen = input.tools && input.maxSteps ? stepCountIs(input.maxSteps) : undefined
      const result = input.messages
        ? await generateText({
            model,
            system: input.system,
            messages: input.messages,
            maxOutputTokens: input.maxOutputTokens,
            tools: input.tools,
            stopWhen,
          })
        : await generateText({
            model,
            system: input.system,
            prompt: input.prompt || '',
            maxOutputTokens: input.maxOutputTokens,
            tools: input.tools,
            stopWhen,
          })

      if (!result.text.trim()) {
        throw new Error(`Model ${target.provider}:${target.model} returned an empty response.`)
      }

      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        requestedProvider,
        requestedModel,
        usedModel: target.model,
        usedProvider: target.provider,
        attemptedModels,
        warning: index > 0 ? ('fallback_used' as AgentUsageWarning) : undefined,
        toolCalls: (result as { toolCalls?: unknown[] }).toolCalls || [],
        toolResults: (result as { toolResults?: unknown[] }).toolResults || [],
      }
    } catch (error) {
      lastError = error
    }
  }

  const wrappedError = lastError instanceof Error ? lastError : new Error('Model execution failed for primary and fallback providers.')
  ;(wrappedError as Error & { warning?: AgentUsageWarning }).warning = 'primary_and_fallback_failed'
  throw wrappedError
}

function parseJsonSafe(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    return { raw: input }
  } catch {
    return { raw: input }
  }
}

async function loadProjectOperatingProfile(env: EnvBindings, context: Context, projectId: string): Promise<ProjectOperatingProfile> {
  const project = await ensureProjectExists(env as EnvBindings, context.tenantId, projectId)
  if (!project) {
    throw new Error(`Project ${projectId} was not found for this workspace.`)
  }

  const projectMembers = await env.DB.prepare(
    `SELECT
       u.id,
       COALESCE(u.name, u.email, u.id) AS name,
       u.email,
       m.role
     FROM project_member_assignments pma
     JOIN users u ON u.id = pma.member_id AND u.tenant_id = pma.tenant_id
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
     WHERE pma.tenant_id = ? AND pma.project_id = ?
     ORDER BY pma.updated_at DESC`
  )
    .bind(context.tenantId, projectId)
    .all<{ id: string; name: string; email: string | null; role: string | null }>()

  const [githubLink, connectedServiceRows, adminIntegrationRows] = await Promise.all([
    env.DB.prepare(
      `SELECT repo_full_name, collaboration_mode, review_on_push
       FROM project_github_links
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    )
      .bind(context.tenantId, projectId)
      .first<{ repo_full_name: string; collaboration_mode: string | null; review_on_push: number | null } | null>(),
    env.DB.prepare(
      `SELECT DISTINCT service_type
       FROM service_connections
       WHERE tenant_id = ? AND is_active = true
       ORDER BY service_type ASC`
    )
      .bind(context.tenantId)
      .all<{ service_type: string }>(),
    env.DB.prepare(
      `SELECT integration_key, status
       FROM admin_integration_configs
       WHERE tenant_id = ?
       ORDER BY integration_key ASC`
    )
      .bind(context.tenantId)
      .all<{ integration_key: string; status: string }>(),
  ])

  const rosterText = projectMembers.results.length
    ? projectMembers.results
        .map((member) => `- ${member.id}: ${member.name}${member.role ? ` (${member.role})` : ''}${member.email ? ` <${member.email}>` : ''}`)
        .join('\n')
    : '- No project members are assigned yet. Ask before assigning ownership or pretending a mystery teammate volunteered.'

  const memberCount = projectMembers.results.length
  const githubRepoFullName = githubLink?.repo_full_name || null
  const githubCollaborationMode =
    memberCount > 0 && !githubRepoFullName
      ? 'collaborative_needs_repo'
      : githubLink?.collaboration_mode === 'collaborative_review'
        ? 'collaborative_review'
        : 'agent_build'

  return {
    projectName: project.name,
    memberCount,
    rosterText,
    githubRepoFullName,
    githubCollaborationMode,
    githubReviewOnPush: Boolean(githubLink?.review_on_push),
    connectedIntegrations: connectedServiceRows.results.map((row) => row.service_type),
    adminManagedIntegrations: adminIntegrationRows.results.filter((row) => row.status === 'active').map((row) => row.integration_key),
    pendingAdminIntegrations: adminIntegrationRows.results.filter((row) => row.status === 'pending').map((row) => row.integration_key),
  }
}

async function ensureProjectAgent(
  env: EnvBindings,
  context: Context,
  projectId: string,
  rootPrompt: string
): Promise<{ id: string; systemPrompt: string }> {
  const profile = await loadProjectOperatingProfile(env, context, projectId)
  const memoryDocs = await ensureProjectMemoryAvailable(env, context.tenantId, projectId)

  const existing = await env.DB.prepare(
    `SELECT id, system_prompt FROM project_agents WHERE tenant_id = ? AND project_id = ? LIMIT 1`
  )
    .bind(context.tenantId, projectId)
    .first<{ id: string; system_prompt: string }>()

  const now = Date.now()
  const id = newId('agent')
  const orchestratorOverride = await loadStoredOrchestratorPrompt(env, context.tenantId)
  const systemPrompt = [
    orchestratorOverride?.trim() ||
      'You are TaskCenter Orchestrator, the main coordinator for a software project workspace. Stay grounded, decisive, and allergic to fake certainty.',
    `You are the dedicated TaskCenter project agent for "${profile.projectName}".`,
    'Mission:',
    '- Turn project conversations into concrete, safe next actions.',
    '- Keep board updates, assignments, and completion calls tied to real evidence.',
    '- Act like an orchestrator that knows when to delegate planning, review, and execution concerns instead of free-styling them.',
    '- Think like a coordinator with specialist roles in mind: plan, implement, review, and execute are distinct concerns even when one reply covers more than one of them.',
    'Mutation policy:',
    '- Board changes stay proposal-first. Do not pretend chat directly mutates durable project state.',
    '- Use action JSON to describe the intended change, then let the proposal/apply flow land it.',
    '- Prefer issue-first decomposition. New work should usually become a focused issue, assignment, or proposal instead of an oversized vague update.',
    '- Prefer issue comments and execution updates for ongoing discussion instead of inventing a separate messages workflow.',
    'Project memory stack:',
    '- Foundation: durable brief, project intent, repo posture, and planning assumptions.',
    '- Workflow: how planning, proposals, and applied state should move through the system.',
    '- Active Context: what is currently in flight, blocked, queued, or waiting on a decision.',
    '- Delivery: applied changes, review posture, and completion evidence.',
    'Grounding rules:',
    '- Treat attached retrieval context, project memory layers, board state, planning memory, and linked app memory as source of truth over vague recollection.',
    '- Never claim work shipped, merged, tested, reviewed, or deployed unless the evidence is present in project context or explicitly supplied by the user.',
    '- Never invent secrets, credentials, legal claims, analytics, or production results.',
    'Operating modes:',
    '- agent_build: solo or greenfield work where the AI can plan/build and push later.',
    '- collaborative_review: teammates are already working in a linked GitHub repo, so use review-first behavior and respect existing ownership.',
    '- collaborative_needs_repo: teammates exist but the repo is not linked yet, so do not pretend code execution or progress review can safely start.',
    `Current mode: ${profile.githubCollaborationMode}`,
    `Linked GitHub repo: ${profile.githubRepoFullName || 'none linked'}`,
    `Review on push: ${profile.githubReviewOnPush ? 'enabled' : 'disabled'}`,
    `Connected workspace integrations: ${profile.connectedIntegrations.length ? profile.connectedIntegrations.join(', ') : 'none connected'}`,
    `Admin-managed integrations: ${profile.adminManagedIntegrations.length ? profile.adminManagedIntegrations.join(', ') : 'none active'}`,
    `Pending admin integration setup: ${profile.pendingAdminIntegrations.length ? profile.pendingAdminIntegrations.join(', ') : 'none pending'}`,
    `Project ID: ${projectId}`,
    `Available memory layers: ${memoryDocs.length ? memoryDocs.map((doc) => `${doc.layer_key} (${doc.title})`).join(', ') : 'none yet'}`,
    `Known project members:\n${profile.rosterText}`,
    'GitHub and completion policy:',
    '- If collaborators are active, require repo-linked evidence before moving implementation work to done.',
    '- If the user asks whether pushed work is good to go, review it like a practical diff reviewer: changed scope, regressions, tests, edge cases, and missing follow-through.',
    '- If the repo is missing in collaborative_needs_repo mode, say so plainly and direct the user to connect/select GitHub before code-heavy execution or push review.',
    '- Progress tasks to review or done only when the evidence clearly maps to the task scope.',
    'Integration policy:',
    '- Use connected integrations when they provide real evidence or automation leverage, but never pretend an integration is available if the workspace status says otherwise.',
    '- If a requested integration requires admin setup, call that out directly and avoid suggesting user-side magic rituals as a workaround.',
    '- Use the integration specialist mindset when recommending setup: what to connect, who owns it, and whether it blocks execution or is merely useful.',
    'Northstar runtime policy:',
    '- Assume the runtime may provide current screen context, a tool registry, support hints, and a carry-forward conversation summary. Use them when present.',
    '- Know when to route the user instead of over-answering: if the user needs a specific screen, control, or workflow, say exactly where to go next.',
    '- Know when to escalate into broader execution: if a request is larger than one reply, propose a structured run, proposal, or review cycle instead of pretending the work is already done.',
    '- If the user is looking at a specific issue or task, keep the answer anchored to that work object instead of drifting into a generic project lecture.',
    '- If the user or the assistant is stuck, switch into support mode: state the current page or context, explain what is missing, and give the next one or two steps.',
    '- If the runtime includes current user identity and the user says "assign it to me" or equivalent, treat that as the current user member id instead of guessing from vibes.',
    '- If a focused task id is present and the user asks to assign or reassign that task, prefer task.assign over task.upsert.',
    'Assignment policy:',
    '- Suggest AI ownership for repeatable drafting, structured analysis, boilerplate implementation, and preparation work.',
    '- Suggest human ownership for approvals, product judgment, merge decisions, secrets, billing, legal, and risky irreversible actions.',
    '- Prefer hybrid handoffs when AI can prepare work but a human should confirm it.',
    '- If a human already started the work locally or in GitHub, continue from their evidence and leave a clear checkpoint trail.',
    'Response style:',
    '- Keep answers concise, implementation-focused, and operationally useful.',
    '- Call out assumptions and blockers explicitly.',
    '- Favor a short operating summary, then concrete actions, then evidence or caveats.',
    '- Do not pad with generic pep-talk or marketing fluff.',
    'When suggesting board changes, append exactly one fenced ```json block at the end with this shape:',
    '{"actions":[{"type":"task.upsert|task.assign|epic.upsert|member.assign|repo.run","payload":{...}}]}',
    'Rules for actions:',
    '- task.upsert payload must include title and should usually include status.',
    '- task.assign payload must include taskId and assigneeId. Use it for focused-task reassignment requests.',
    '- epic.upsert payload must include title and can include objective.',
    '- member.assign payload must include memberId only when a real member is already known.',
    '- repo.run is only allowed when the project has a linked GitHub repo or the user is explicitly asking for a branch/PR/build handoff.',
    '- repo.run payload must include commitMessage, prTitle, and files[]. Each file needs path and full content. Include buildCommands only when you know the repo command(s).',
    '- Prefer repo.run when the request is actual code delivery for a repo-backed project, especially when the user asks to build, patch, commit, push, or open a PR.',
    '- If no board change is needed, do not emit a JSON block.',
    '- Never emit multiple JSON blocks.',
    '- Keep normal prose outside the JSON block under 8 short bullet points or 2 short paragraphs.',
  ].join('\n')

  if (existing) {
    if (existing.system_prompt !== systemPrompt) {
      await env.DB.prepare(`UPDATE project_agents SET system_prompt = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(systemPrompt, now, existing.id, context.tenantId)
        .run()
    }
    return { id: existing.id, systemPrompt }
  }

  await env.DB.prepare(
    `INSERT INTO project_agents (id, tenant_id, project_id, owner_user_id, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, context.tenantId, projectId, context.userId, systemPrompt, now, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO agent_messages (id, tenant_id, project_id, project_agent_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(newId('msg'), context.tenantId, projectId, id, 'system', `Project agent ready for ${profile.projectName}. Root prompt: ${rootPrompt}`, now)
    .run()

  return { id, systemPrompt }
}

export async function createAgentRun(
  env: EnvBindings,
  context: Context,
  input: CreateAgentRunInput
): Promise<{ run: AgentRunRecord; stepsCreated: number }> {
  const project = await ensureProjectExists(env as EnvBindings, context.tenantId, input.projectId)
  if (!project) {
    throw new Error(`Project ${input.projectId} was not found for this workspace.`)
  }

  const now = Date.now()
  const runId = newId('run')

  const initialStatus: AgentRunStatus = 'running'
  const projectAgent = await ensureProjectAgent(env, context, input.projectId, input.prompt)
  const profile = await loadProjectOperatingProfile(env, context, input.projectId)
  const runtimeToolContext = await loadRuntimeToolSession(env, {
    tenantId: context.tenantId,
    userId: context.userId,
    projectId: input.projectId,
  })
  const ragContext = await buildProjectRagContext(env, {
    tenantId: context.tenantId,
    projectId: input.projectId,
    query: [input.prompt, input.requestedTask || ''].filter(Boolean).join('\n'),
    maxSnippets: 7,
  })

  await env.DB.prepare(
    `INSERT INTO agent_runs (id, tenant_id, project_id, requested_by, root_prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(runId, context.tenantId, input.projectId, context.userId, input.prompt, initialStatus, now, now)
    .run()

  const storedAgentConfigs = await loadStoredAgentConfigs(env, context.tenantId)
  const steps = buildStepBlueprints(input, storedAgentConfigs, profile)
  let previousOutput = input.prompt

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const stepId = newId('step')
    const startedAt = Date.now()
    try {
      const modelResult = await generateTenantAiText(env as EnvBindings, context, {
        featureKey: 'agent.run',
        system: step.systemPrompt,
        prompt: JSON.stringify({
          runId,
          previousOutput,
          input: step.input,
          projectPrompt: input.prompt,
          requestedTask: input.requestedTask ?? null,
          runtimeToolContext: runtimeToolContext.summaryText,
          retrievedProjectContext: ragContext.promptContext,
        }),
        modelConfig: input.modelConfig || step.modelConfig,
        maxOutputTokens: step.maxOutputTokens,
        metadata: {
          projectId: input.projectId,
          runId,
          stepOrder: index + 1,
          ragSnippetCount: ragContext.snippets.length,
        },
      })
      const outputText = modelResult.text
      const inTokens = modelResult.usage.inputTokens
      const outTokens = modelResult.usage.outputTokens

      const outputPayload = parseJsonSafe(outputText)
      await env.DB.prepare(
        `INSERT INTO agent_steps (id, run_id, tenant_id, agent_name, step_order, input_payload, output_payload, model, input_tokens, output_tokens, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          stepId,
          runId,
          context.tenantId,
          step.agentName,
          index + 1,
          JSON.stringify(step.input),
          JSON.stringify(outputPayload),
          `${modelResult.usedProvider}:${modelResult.usedModel}`,
          inTokens,
          outTokens,
          'completed',
          now,
          now
        )
        .run()

      previousOutput = outputText
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent run step failed'
      await env.DB.prepare(`UPDATE agent_runs SET status = 'failed', updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(Date.now(), runId, context.tenantId)
        .run()
      await logAgentUsage(env, context, {
        actionType: 'agent.run.step',
        agentName: step.agentName,
        projectId: input.projectId,
        status: 'error',
        errorMessage: message,
        requestPreview: JSON.stringify(step.input),
        responseTimeMs: Date.now() - startedAt,
        metadata: { runId, stepOrder: index + 1 },
      })
      throw error
    }
  }

  await env.DB.prepare(`UPDATE agent_runs SET status = 'completed', updated_at = ? WHERE id = ? AND tenant_id = ?`)
    .bind(Date.now(), runId, context.tenantId)
    .run()

  await env.DB.prepare(`UPDATE project_agents SET latest_run_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
    .bind(runId, Date.now(), projectAgent.id, context.tenantId)
    .run()

  await upsertProjectSearchIndex(env, {
    tenantId: context.tenantId,
    projectId: input.projectId,
    extraTexts: [input.prompt],
  })

  return {
    run: {
      id: runId,
      tenantId: context.tenantId,
      projectId: input.projectId,
      requestedBy: context.userId,
      rootPrompt: input.prompt,
      status: 'completed',
      createdAt: now,
      updatedAt: Date.now(),
    },
    stepsCreated: steps.length,
  }
}

export async function getAgentRunDetails(env: EnvBindings, context: Context, runId: string) {
  const run = await env.DB.prepare(
    `SELECT id, tenant_id, project_id, requested_by, root_prompt, status, created_at, updated_at
     FROM agent_runs WHERE id = ? AND tenant_id = ? LIMIT 1`
  )
    .bind(runId, context.tenantId)
    .first()

  if (!run) return null

  const steps = await env.DB.prepare(
    `SELECT id, run_id, tenant_id, agent_name, step_order, input_payload, output_payload, status, created_at, updated_at
     FROM agent_steps WHERE run_id = ? AND tenant_id = ? ORDER BY step_order ASC`
  )
    .bind(runId, context.tenantId)
    .all()

  return {
    run,
    steps: steps.results,
  }
}

export async function listRecentRuns(env: EnvBindings, context: Context, projectId?: string) {
  if (projectId) {
    const result = await env.DB.prepare(
      `SELECT id, project_id, root_prompt, status, created_at, updated_at
       FROM agent_runs WHERE tenant_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 20`
    )
      .bind(context.tenantId, projectId)
      .all()
    return result.results
  }

  const result = await env.DB.prepare(
    `SELECT id, project_id, root_prompt, status, created_at, updated_at
     FROM agent_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(context.tenantId)
    .all()
  return result.results
}

export async function getProjectAgentMessages(env: EnvBindings, context: Context, projectId: string) {
  const agent = await ensureProjectAgent(env, context, projectId, 'dashboard chat bootstrap')
  const messages = await env.DB.prepare(
    `SELECT id, role, content, model, input_tokens, output_tokens, created_at
     FROM agent_messages WHERE tenant_id = ? AND project_id = ? AND project_agent_id = ? ORDER BY created_at ASC LIMIT 100`
  )
    .bind(context.tenantId, projectId, agent.id)
    .all()

  return {
    projectAgentId: agent.id,
    messages: messages.results,
  }
}

export async function chatWithProjectAgent(
  env: EnvBindings,
  context: Context,
  input: { projectId: string; message: string; modelConfig?: AgentModelConfig; skillIds?: string[]; context?: ProjectAgentRuntimeContext }
) {
  const project = await ensureProjectExists(env as EnvBindings, context.tenantId, input.projectId)
  if (!project) {
    throw new Error(`Project ${input.projectId} was not found for this workspace.`)
  }

  const now = Date.now()
  const agent = await ensureProjectAgent(env, context, input.projectId, input.message)

  await env.DB.prepare(
    `INSERT INTO agent_messages (id, tenant_id, project_id, project_agent_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(newId('msg'), context.tenantId, input.projectId, agent.id, 'user', input.message, now)
    .run()

  const historyRows = await env.DB.prepare(
    `SELECT role, content FROM agent_messages
     WHERE tenant_id = ? AND project_id = ? AND project_agent_id = ?
     ORDER BY created_at DESC LIMIT 24`
  )
    .bind(context.tenantId, input.projectId, agent.id)
    .all<{ role: string; content: string }>()

  const reversed = [...historyRows.results].reverse()
  const olderRows = reversed.filter((row) => row.role === 'user' || row.role === 'assistant').slice(0, -12)
  const recentRows = reversed.filter((row) => row.role === 'user' || row.role === 'assistant').slice(-12)
  const historySummary = summarizeNorthstarHistory(olderRows)
  const messages: ModelMessage[] = recentRows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content }))

  const startedAt = Date.now()
  let result: Awaited<ReturnType<typeof generateWithFallback>>
  const selectedSkills = input.skillIds?.length
    ? await getWorkspaceSkillsByIds(env, context.tenantId, input.skillIds)
    : { results: [] as Array<{ id: string; name: string; description: string; instructions: string }> }
  const skillContext = selectedSkills.results.length
    ? [
        'Selected workspace skills:',
        ...selectedSkills.results.map((skill) => `- ${skill.name}: ${skill.description}\n${skill.instructions}`),
      ].join('\n')
    : ''
  const ragContext = await buildProjectRagContext(env, {
    tenantId: context.tenantId,
    projectId: input.projectId,
    query: input.message,
    maxSnippets: 6,
  })
  const runtimeToolContext = await loadRuntimeToolSession(env, {
    tenantId: context.tenantId,
    userId: context.userId,
    projectId: input.projectId,
    selectedConnectorKeys: input.context?.selectedConnectorKeys,
  })
  const mergedRuntimeContext = {
    ...input.context,
    projectName: input.context?.projectName || project.name,
    selectedConnectorLabels: input.context?.selectedConnectorLabels?.length
      ? input.context.selectedConnectorLabels
      : runtimeToolContext.selectedConnectorLabels,
    toolSummary: [
      input.context?.toolSummary,
      `Workspace integration registry:\n${runtimeToolContext.summaryText}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  } satisfies ProjectAgentRuntimeContext
  try {
    result = await generateTenantAiText(env as EnvBindings, context, {
      featureKey: 'agent.chat',
      system: `${agent.systemPrompt}\n\n${buildNorthstarRuntimePrompt(mergedRuntimeContext, historySummary)}\n\n${ragContext.promptContext}${skillContext ? `\n\n${skillContext}` : ''}`,
      messages,
      modelConfig: input.modelConfig,
      maxOutputTokens: 768,
      metadata: {
        projectId: input.projectId,
        projectName: project.name,
        projectAgentId: agent.id,
        ragSnippetCount: ragContext.snippets.length,
        currentPage: input.context?.currentPage,
        currentRoute: input.context?.currentRoute,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project chat failed'
    await logAgentUsage(env, context, {
      actionType: 'agent.chat',
      agentName: 'orchestrator',
      projectId: input.projectId,
      status: 'error',
      errorMessage: message,
      requestPreview: input.message,
      responseTimeMs: Date.now() - startedAt,
      metadata: { projectAgentId: agent.id },
    })
    throw error
  }
  const reply = result.text
  const actions = extractAgentActions(reply)
  const inTokens = result.usage.inputTokens
  const outTokens = result.usage.outputTokens

  await env.DB.prepare(
    `INSERT INTO agent_messages (id, tenant_id, project_id, project_agent_id, role, content, model, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('msg'),
      context.tenantId,
      input.projectId,
      agent.id,
      'assistant',
      reply,
      `${result.usedProvider}:${result.usedModel}`,
      inTokens,
      outTokens,
      Date.now()
    )
    .run()

  await upsertProjectSearchIndex(env, {
    tenantId: context.tenantId,
    projectId: input.projectId,
    extraTexts: [input.message, reply],
  })

  if (selectedSkills.results.length > 0) {
    await incrementSkillUsage(env, context.tenantId, selectedSkills.results.map((skill) => skill.id)).catch(() => {})
  }

  const skillSuggestion = await maybeCreateSkillFromRequest(env, context, {
    projectId: input.projectId,
    message: input.message,
  }).catch(() => null)
  const escalationMode = detectInvestigationMode(input.message)
  const escalation = escalationMode
    ? await createDebugInvestigation(env, { tenantId: context.tenantId, userId: context.userId, userEmail: context.userEmail ?? null }, {
        projectId: input.projectId,
        mode: escalationMode,
        summary: input.message.slice(0, 4000),
        evidenceSources: ['chat_request', 'project_state', 'runtime_errors', 'usage'],
        screenContext: input.context ? { ...input.context } : null,
      })
        .then((details) =>
          details
            ? {
                type: 'investigation' as const,
                mode: escalationMode,
                sessionId: String((details.session as { id?: string })?.id || ''),
                reason: 'Northstar escalated this request into a durable investigation session so evidence, retries, and follow-up review can stay attached to the project.',
              }
            : null
        )
        .catch(() => null)
    : null

  return {
    projectAgentId: agent.id,
    reply,
    actions,
    usage: {
      inputTokens: inTokens,
      outputTokens: outTokens,
      model: `${result.usedProvider}:${result.usedModel}`,
    },
    routing: {
      requestedProvider: result.requestedProvider,
      requestedModel: result.requestedModel,
      usedProvider: result.usedProvider,
      usedModel: result.usedModel,
      attemptedModels: result.attemptedModels,
    },
    retrieval: {
      snippets: ragContext.snippets,
      counts: ragContext.counts,
    },
    warning: result.warning,
    skillSuggestion: skillSuggestion
      ? {
          id: skillSuggestion.skill.id,
          name: skillSuggestion.skill.name,
          status: skillSuggestion.skill.status,
          reason: skillSuggestion.reason,
        }
      : null,
    escalation,
  }
}

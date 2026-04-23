export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed'

export type AgentStepStatus = 'queued' | 'running' | 'completed' | 'failed'

export type AgentName =
  | 'orchestrator'
  | 'planning_analyst'
  | 'repo_strategist'
  | 'integration_specialist'
  | 'task_decomposer'
  | 'assignment_router'
  | 'code_reviewer'
  | 'execution_planner'

export type AgentStepInput = {
  summary: string
  payload: Record<string, unknown>
}

export type AgentStepOutput = {
  summary: string
  payload: Record<string, unknown>
}

export type AgentStepRecord = {
  id: string
  runId: string
  tenantId: string
  agentName: AgentName
  stepOrder: number
  status: AgentStepStatus
  inputPayload: AgentStepInput
  outputPayload: AgentStepOutput
  createdAt: number
  updatedAt: number
}

export type AgentRunRecord = {
  id: string
  tenantId: string
  projectId: string
  requestedBy: string
  rootPrompt: string
  status: AgentRunStatus
  createdAt: number
  updatedAt: number
}

export type CreateAgentRunInput = {
  projectId: string
  prompt: string
  requestedTask?: string
  modelConfig?: AgentModelConfig
}

export type AgentModelProvider = 'gateway' | 'gemini' | 'openai' | 'openrouter' | 'anthropic'

export type AgentModelConfig = {
  provider: AgentModelProvider
  model: string
  apiKey?: string
  fallbackProvider?: AgentModelProvider
  fallbackModel?: string
  fallbackApiKey?: string
}

export type AgentUsageWarning =
  | 'missing_credentials'
  | 'fallback_used'
  | 'primary_and_fallback_failed'

export type AgentRoutingInfo = {
  requestedProvider: AgentModelProvider
  requestedModel: string
  usedProvider: AgentModelProvider
  usedModel: string
  attemptedModels: string[]
}

export type AgentAction =
  | {
      type: 'task.upsert'
      payload: {
        id?: string
        title: string
        status: 'todo' | 'in_progress' | 'review' | 'done'
        assignees?: string[]
        tags?: string[]
      }
    }
  | {
      type: 'task.assign'
      payload: {
        taskId: string
        assigneeId: string
      }
    }
  | {
      type: 'epic.upsert'
      payload: {
        id?: string
        title: string
        objective?: string
      }
    }
  | {
      type: 'member.assign'
      payload: {
        memberId: string
      }
    }
  | {
      type: 'repo.run'
      payload: {
        baseBranch?: string
        branchName?: string
        commitMessage: string
        prTitle: string
        prBody?: string
        buildCommands?: string[]
        files: Array<{
          path: string
          content: string
        }>
      }
    }

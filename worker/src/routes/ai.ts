import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { generateTenantAiText } from '../agents/orchestrator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { listCatalogModels, maybeRefreshOpenRouterModelCatalog } from '../lib/model-catalog'

export const aiRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

aiRoute.get('/models', async (c) => {
  await maybeRefreshOpenRouterModelCatalog(c.env).catch(() => {})
  const catalog = await listCatalogModels(c.env).catch(() => ({ updatedAt: null, models: [] }))
  return c.json(catalog)
})

aiRoute.post(
  '/generate',
  zValidator(
    'json',
    z.object({
      featureKey: z.enum(['planning.context_analysis', 'planning.epic_generation']),
      system: z.string().min(1),
      prompt: z.string().min(1),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const payload = c.req.valid('json')

    try {
      const result = await generateTenantAiText(c.env, { tenantId, userId, userEmail }, {
        featureKey: payload.featureKey,
        system: payload.system,
        prompt: payload.prompt,
        metadata: { phase: 'generic-generation' },
      })

      return c.json({
        text: result.text,
        usage: result.usage,
        routing: {
          requestedProvider: result.requestedProvider,
          requestedModel: result.requestedModel,
          usedProvider: result.usedProvider,
          usedModel: result.usedModel,
          attemptedModels: result.attemptedModels,
        },
        warning: result.warning,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI generation failed'
      const status = message.includes('Usage limit reached') ? 429 : 500
      return c.json({ error: status === 429 ? 'usage_limit_reached' : 'ai_generation_failed', message }, status)
    }
  }
)

aiRoute.post(
  '/planning/analyze',
  zValidator(
    'json',
    z.object({
      planningPrompt: z.string().min(1),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const { planningPrompt } = c.req.valid('json')

    const prompt = [
      'Analyze the planning prompt and return only valid JSON.',
      'Required shape:',
      '{"intentMode":"chat|plan","planReadiness":"ready|needs_context|unclear","assistantReply":"string","suggestedFollowUp":"string|null","missingInformation":["string"],"inferred":{"product":"string","audience":"string","outcome":"string","constraints":["string"],"assumptions":["string"],"deliverables":["string"],"industry":"string","teamSize":1,"deadline":"string","techStack":["string"],"executionMode":"auto|manual|hybrid"},"confidence":{"overall":0.0,"industry":0.0,"teamSize":0.0,"deadline":0.0,"techStack":0.0,"executionMode":0.0},"reasoning":"string"}',
      'Rules:',
      '- intentMode = "chat" when the user is primarily discussing, exploring, or asking questions without clearly asking you to build a plan yet.',
      '- intentMode = "plan" when the user wants you to create, break down, scope, sequence, assign, roadmap, estimate, or structure project work.',
      '- planReadiness = "ready" only when there is enough detail to move into planning without another mandatory follow-up question.',
      '- planReadiness = "needs_context" when a specific missing detail would materially improve the plan.',
      '- planReadiness = "unclear" when the request is too vague or early to treat as a planning brief.',
      '- assistantReply should sound like a concise, helpful next response from the intake agent.',
      '- If intentMode is "chat", assistantReply should continue the conversation naturally instead of shoving the user into planning.',
      '- If planReadiness is not "ready", suggestedFollowUp should be the single best next question.',
      '- missingInformation should be concrete and short. Keep it empty when planReadiness is "ready".',
      '- Keep inferred values concise and practical.',
      '- If the prompt is vague, make the safest assumption and put it in assumptions instead of hallucinating certainty.',
      '- confidence values must be numbers from 0 to 1.',
      '- Do not use markdown.',
      `Prompt: ${planningPrompt}`,
    ].join('\n')

    try {
      const result = await generateTenantAiText(c.env, { tenantId, userId, userEmail }, {
        featureKey: 'planning.context_analysis',
        system: 'You are TaskCenter planning intake. Extract context for downstream planning agents and return strict JSON only.',
        prompt,
        maxOutputTokens: 512,
        metadata: { phase: 'context-analysis' },
      })

      return c.json({
        text: result.text,
        usage: result.usage,
        routing: {
          requestedProvider: result.requestedProvider,
          requestedModel: result.requestedModel,
          usedProvider: result.usedProvider,
          usedModel: result.usedModel,
          attemptedModels: result.attemptedModels,
        },
        warning: result.warning,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Planning analysis failed'
      const status = message.includes('Usage limit reached') ? 429 : 500
      return c.json({ error: status === 429 ? 'usage_limit_reached' : 'planning_analysis_failed', message }, status)
    }
  }
)

aiRoute.post(
  '/planning/epics',
  zValidator(
    'json',
    z.object({
      intent: z.string().min(1),
      context: z.string().optional(),
    })
  ),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const userEmail = c.get('userEmail')
    const { intent, context } = c.req.valid('json')

    const prompt = [
      'Generate a compact project plan and return only valid JSON.',
      'Required shape:',
      '{"epics":[{"id":"epic-1","title":"string","description":"string","stories":[{"id":"story-1","title":"string","description":"string","tasks":[{"id":"task-1","title":"string","description":"string","priority":"high|medium|low","dependencies":["task-id"],"subtasks":[{"id":"subtask-1","title":"string","description":"string","tools":["string"]}]}]}]}]}',
      'Rules:',
      '- At most 2 epics, 3 stories per epic, and 3 tasks per story.',
      '- Keep titles short and implementation-ready.',
      '- Use dependencies only when necessary.',
      '- Prefer realistic work for a software team, not generic business fluff.',
      `User intent: ${intent}`,
      `Additional context: ${context || 'None'}`,
    ].join('\n')

    try {
      const result = await generateTenantAiText(c.env, { tenantId, userId, userEmail }, {
        featureKey: 'planning.epic_generation',
        system: 'You are TaskCenter planning decomposition. Produce execution-ready epics, stories, tasks, and subtasks as strict JSON only.',
        prompt,
        maxOutputTokens: 1024,
        metadata: { phase: 'epic-generation' },
      })

      return c.json({
        text: result.text,
        usage: result.usage,
        routing: {
          requestedProvider: result.requestedProvider,
          requestedModel: result.requestedModel,
          usedProvider: result.usedProvider,
          usedModel: result.usedModel,
          attemptedModels: result.attemptedModels,
        },
        warning: result.warning,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Epic generation failed'
      const status = message.includes('Usage limit reached') ? 429 : 500
      return c.json({ error: status === 429 ? 'usage_limit_reached' : 'epic_generation_failed', message }, status)
    }
  }
)

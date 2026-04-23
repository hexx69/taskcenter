import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { upsertProjectSearchIndex } from '../db/project-index'
import { upsertAppMemoryEntry } from '../lib/app-memory'
import { newId } from '../lib/ids'
import { refreshProjectMemoryDocs } from '../lib/project-memory'

const createPlanningContextSchema = z.object({
  projectId: z.string().optional(),
  selectedProjectId: z.string().min(1),
  planIntent: z.string().min(1),
  executionMode: z.enum(['auto', 'manual', 'hybrid']),
  onboardingAnswers: z.array(z.string()),
  qualifyingAnswers: z.array(z.string()),
  uploadedDocument: z.string().optional(),
  markdownBundle: z.string().optional(),
})

export const planningContextsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

planningContextsRoute.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.query('projectId')

  const filters = ['tenant_id = ?']
  const params: string[] = [tenantId]

  if (projectId) {
    filters.push('(project_id = ? OR selected_project_id = ?)')
    params.push(projectId, projectId)
  }

  const result = await c.env.DB.prepare(
    `SELECT id, project_id, selected_project_id, created_by, plan_intent, execution_mode,
            onboarding_answers_json, qualifying_answers_json, uploaded_document, markdown_bundle, created_at
     FROM planning_contexts
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(...params)
    .all()

  return c.json({ contexts: result.results })
})

planningContextsRoute.post(
  '/',
  zValidator('json', createPlanningContextSchema),
  async (c) => {
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const payload = c.req.valid('json')
    const id = newId('ctx')
    const now = Date.now()

    await c.env.DB.prepare(
      `INSERT INTO planning_contexts (
        id, tenant_id, project_id, created_by, plan_intent, selected_project_id,
        execution_mode, onboarding_answers_json, qualifying_answers_json, uploaded_document, markdown_bundle, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        payload.projectId ?? null,
        userId,
        payload.planIntent,
        payload.selectedProjectId,
        payload.executionMode,
        JSON.stringify(payload.onboardingAnswers),
        JSON.stringify(payload.qualifyingAnswers),
        payload.uploadedDocument ?? null,
        payload.markdownBundle ?? null,
        now
      )
      .run()

    const indexProjectId = payload.projectId || payload.selectedProjectId
    if (indexProjectId) {
      await upsertProjectSearchIndex(c.env, {
        tenantId,
        projectId: indexProjectId,
        extraTexts: [payload.planIntent, payload.markdownBundle ?? ''],
      }).catch(() => {})

      await upsertAppMemoryEntry(c.env, {
        tenantId,
        projectId: indexProjectId,
        sourceApp: 'taskcenter',
        sourceType: 'planning_context',
        sourceKey: id,
        title: payload.planIntent,
        content: [
          payload.planIntent,
          payload.onboardingAnswers.join('\n'),
          payload.qualifyingAnswers.join('\n'),
          payload.uploadedDocument ?? '',
          payload.markdownBundle ?? '',
        ].filter(Boolean).join('\n\n'),
        summary: `${payload.executionMode} planning context`,
        metadata: { executionMode: payload.executionMode },
      }).catch(() => {})

      await refreshProjectMemoryDocs(c.env, {
        tenantId,
        projectId: indexProjectId,
      }).catch(() => {})
    }

    return c.json({ id }, 201)
  }
)

import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { createWorkspaceSkill, listWorkspaceSkills } from '../lib/skills'

export const skillsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const createSkillSchema = z.object({
  name: z.string().min(2),
  description: z.string().min(8),
  instructions: z.string().min(16),
  status: z.enum(['active', 'suggested', 'archived']).optional(),
})

const updateSkillSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().min(8).optional(),
  instructions: z.string().min(16).optional(),
  status: z.enum(['active', 'suggested', 'archived']).optional(),
})

skillsRoute.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const result = await listWorkspaceSkills(c.env, tenantId)
  return c.json({ skills: result.results })
})

skillsRoute.post('/', zValidator('json', createSkillSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const payload = c.req.valid('json')

  const skill = await createWorkspaceSkill(c.env, { tenantId, userId }, payload)
  return c.json({ skill }, 201)
})

skillsRoute.put('/:skillId', zValidator('json', updateSkillSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const skillId = c.req.param('skillId')
  const payload = c.req.valid('json')

  const existing = await c.env.DB.prepare(
    `SELECT id, name, description, instructions, status
     FROM workspace_skills
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, skillId)
    .first<{ id: string; name: string; description: string; instructions: string; status: 'active' | 'suggested' | 'archived' } | null>()

  if (!existing) {
    return c.json({ error: 'skill_not_found' }, 404)
  }

  await c.env.DB.prepare(
    `UPDATE workspace_skills
     SET name = ?, description = ?, instructions = ?, status = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(
      payload.name || existing.name,
      payload.description || existing.description,
      payload.instructions || existing.instructions,
      payload.status || existing.status,
      Date.now(),
      tenantId,
      skillId
    )
    .run()

  const updated = await c.env.DB.prepare(
    `SELECT * FROM workspace_skills WHERE tenant_id = ? AND id = ? LIMIT 1`
  )
    .bind(tenantId, skillId)
    .first()

  return c.json({ skill: updated })
})

export default skillsRoute

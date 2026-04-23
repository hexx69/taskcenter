import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { refreshProjectMemoryDocs, listProjectMemoryDocs } from '../lib/project-memory'
import { ensureProjectExists } from '../lib/projects'
import type { EnvBindings, RequestContext } from '../lib/context'
import { listMemoryFiles, getMemoryFile, upsertMemoryFile, archiveMemoryFile } from '../lib/memory-files'

export const projectMemoryRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

projectMemoryRoute.get('/projects/:projectId', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const project = await ensureProjectExists(c.env, tenantId, projectId)
  if (!project) {
    return c.json({ error: 'project_not_found' }, 404)
  }

  const docs = await listProjectMemoryDocs(c.env, { tenantId, projectId })
  if (docs.length > 0) {
    return c.json({ docs })
  }

  const refreshed = await refreshProjectMemoryDocs(c.env, { tenantId, projectId })
  return c.json({ docs: refreshed })
})

projectMemoryRoute.post('/projects/:projectId/refresh', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const project = await ensureProjectExists(c.env, tenantId, projectId)
  if (!project) {
    return c.json({ error: 'project_not_found' }, 404)
  }

  const docs = await refreshProjectMemoryDocs(c.env, { tenantId, projectId })
  return c.json({ docs })
})

const memoryFileCreateSchema = z.object({
  paraCategory: z.enum(['projects', 'areas', 'resources', 'archives']),
  path: z.string().min(1),
  title: z.string().min(1),
  markdown: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

const memoryFileUpdateSchema = z.object({
  paraCategory: z.enum(['projects', 'areas', 'resources', 'archives']).optional(),
  path: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  markdown: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

projectMemoryRoute.get('/:projectId/files', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const category = c.req.query('category')
  const project = await ensureProjectExists(c.env, tenantId, projectId)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  return c.json(await listMemoryFiles(c.env, { tenantId, projectId, paraCategory: category }))
})

projectMemoryRoute.post('/:projectId/files', zValidator('json', memoryFileCreateSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const project = await ensureProjectExists(c.env, tenantId, projectId)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const body = c.req.valid('json')
  const file = await upsertMemoryFile(c.env, { tenantId, projectId, createdBy: userId, ...body })
  return c.json({ file }, 201)
})

projectMemoryRoute.get('/:projectId/files/:fileId', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')
  const file = await getMemoryFile(c.env, { tenantId, projectId, fileId })
  if (!file) return c.json({ error: 'not_found' }, 404)
  return c.json({ file })
})

projectMemoryRoute.patch('/:projectId/files/:fileId', zValidator('json', memoryFileUpdateSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')
  const body = c.req.valid('json')
  const existing = await getMemoryFile(c.env, { tenantId, projectId, fileId })
  if (!existing) return c.json({ error: 'not_found' }, 404)
  const file = await upsertMemoryFile(c.env, {
    tenantId,
    projectId,
    fileId,
    paraCategory: body.paraCategory ?? existing.paraCategory as 'projects' | 'areas' | 'resources' | 'archives',
    path: body.path ?? existing.path,
    title: body.title ?? existing.title,
    markdown: body.markdown ?? existing.markdown,
    summary: body.summary ?? existing.summary ?? undefined,
    tags: body.tags ?? existing.tags,
    createdBy: userId,
  })
  return c.json({ file })
})

projectMemoryRoute.delete('/:projectId/files/:fileId', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')
  const result = await archiveMemoryFile(c.env, { tenantId, projectId, fileId })
  return c.json(result)
})

import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'
import { listPlugins, installPlugin, activatePlugin, invokePlugin } from '../lib/plugins'

export const pluginsRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const installPluginSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  manifest: z.record(z.unknown()).default({}),
  workerUrl: z.string().url().optional(),
  uiUrl: z.string().url().optional(),
})

const invokePluginSchema = z.object({
  action: z.string().min(1),
  payload: z.unknown().default({}),
})

pluginsRoute.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const result = await listPlugins(c.env, tenantId)
  return c.json(result)
})

pluginsRoute.post('/', zValidator('json', installPluginSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const body = c.req.valid('json')
  const result = await installPlugin(c.env, { tenantId, createdBy: userId, ...body })
  return c.json(result, 201)
})

pluginsRoute.post('/:pluginId/activate', async (c) => {
  const tenantId = c.get('tenantId')
  const { pluginId } = c.req.param()
  const result = await activatePlugin(c.env, { tenantId, pluginId })
  return c.json(result)
})

pluginsRoute.post('/:slug/invoke', zValidator('json', invokePluginSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const { slug } = c.req.param()
  const { action, payload } = c.req.valid('json')
  try {
    const result = await invokePlugin(c.env, { tenantId, slug, action, payload })
    return c.json({ ok: true, result })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invoke_failed' }, 400)
  }
})

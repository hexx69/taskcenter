import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings, RequestContext } from '../lib/context'

export const seedRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

seedRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      tenantName: z.string().min(1).default('Default Tenant'),
      userEmail: z.string().email().default('you@example.com'),
      userName: z.string().min(1).default('You')
    })
  ),
  async (c) => {
    const { tenantName, userEmail, userName } = c.req.valid('json')
    const tenantId = c.get('tenantId')
    const userId = c.get('userId')
    const now = Date.now()

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)`
    )
      .bind(tenantId, tenantName, now)
      .run()

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(userId, tenantId, userEmail, userName, now)
      .run()

    return c.json({ ok: true })
  }
)

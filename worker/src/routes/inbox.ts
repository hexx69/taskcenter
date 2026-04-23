import { Hono } from 'hono'
import type { EnvBindings, RequestContext } from '../lib/context'
import { upsertAppMemoryEntry } from '../lib/app-memory'

export const inboxRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

inboxRoute.post('/:entryId/archive', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const entryId = c.req.param('entryId')

  const colonIndex = entryId.indexOf(':')
  const kind = colonIndex >= 0 ? entryId.slice(0, colonIndex) : ''
  const innerId = colonIndex >= 0 ? entryId.slice(colonIndex + 1) : entryId

  if (!kind || !innerId) {
    return c.json({ error: 'invalid_entry_id' }, 400)
  }

  // Keep the archive marker in app_memory to avoid schema churn.
  // Keyed so a given user can only archive any entry once.
  try {
    await upsertAppMemoryEntry(c.env, {
      tenantId,
      sourceApp: 'taskcenter',
      sourceType: 'inbox_archived',
      sourceKey: `${userId}:${entryId}`,
      title: `Archived ${kind}`,
      content: `User ${userId} archived inbox entry ${entryId}.`,
      summary: null,
      metadata: {
        kind,
        entryId,
        innerId,
        userId,
        archivedAt: Date.now(),
      },
    })
  } catch (error) {
    return c.json({ error: 'archive_failed', message: error instanceof Error ? error.message : 'failed' }, 500)
  }

  return c.json({ ok: true, entryId, kind })
})

export default inboxRoute

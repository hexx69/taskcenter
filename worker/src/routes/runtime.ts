import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings } from '../lib/context'

const runtimeRoute = new Hono<{ Bindings: EnvBindings }>()

const repoRunCallbackSchema = z.object({
  status: z.enum(['running', 'succeeded', 'failed']),
  externalRunId: z.string().optional(),
  logs: z.array(z.string()).optional(),
  result: z.record(z.any()).optional(),
  errorMessage: z.string().optional(),
})

runtimeRoute.post(
  '/github/runs/:runId/callback',
  zValidator('json', repoRunCallbackSchema),
  async (c) => {
    const sharedSecret = c.req.header('x-taskcenter-runner-secret')
    if (!c.env.REPO_RUNNER_SECRET || sharedSecret !== c.env.REPO_RUNNER_SECRET) {
      return c.json({ error: 'forbidden' }, 403)
    }

    const { runId } = c.req.param()
    const payload = c.req.valid('json')
    const now = Date.now()
    await c.env.DB.prepare(
      `UPDATE project_repo_runs
       SET status = ?,
           external_run_id = COALESCE(?, external_run_id),
           logs_json = ?,
           result_json = ?,
           error_message = ?,
           updated_at = ?,
           completed_at = CASE WHEN ? IN ('succeeded', 'failed') THEN ? ELSE completed_at END,
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END
       WHERE id = ?`
    )
      .bind(
        payload.status,
        payload.externalRunId || null,
        JSON.stringify(payload.logs || []),
        payload.result ? JSON.stringify(payload.result) : null,
        payload.errorMessage || null,
        now,
        payload.status,
        now,
        payload.status,
        now,
        runId
      )
      .run()

    return c.json({ ok: true })
  }
)

export { runtimeRoute }

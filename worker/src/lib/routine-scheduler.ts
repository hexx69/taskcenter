import type { EnvBindings } from './context'

type RoutineRow = {
  id: string
  tenant_id: string
  company_id: string
  title: string
  schedule_json: string | null
  last_run_at: number | null
  status: string
}

function shouldRunNow(scheduleJson: string | null, lastRunAt: number | null, now: number): boolean {
  if (!scheduleJson) return false
  try {
    const schedule = JSON.parse(scheduleJson) as { intervalMinutes?: number; runOnce?: boolean }
    if (schedule.runOnce && lastRunAt) return false
    const intervalMs = (schedule.intervalMinutes ?? 60) * 60_000
    if (!lastRunAt) return true
    return now - lastRunAt >= intervalMs
  } catch {
    return false
  }
}

export async function processRoutines(env: EnvBindings): Promise<void> {
  const now = Date.now()

  const routines = await env.DB.prepare(
    `SELECT id, tenant_id, company_id, title, schedule_json, last_run_at, status
     FROM company_routines
     WHERE status = 'active'
     ORDER BY COALESCE(last_run_at, 0) ASC
     LIMIT 50`
  )
    .all<RoutineRow>()
    .catch(() => ({ results: [] as RoutineRow[] }))

  for (const routine of routines.results) {
    if (!shouldRunNow(routine.schedule_json, routine.last_run_at, now)) continue

    try {
      // Record activity for the routine fire
      await env.DB.prepare(
        `INSERT INTO company_activity (id, tenant_id, company_id, project_id, category, severity, message, metadata_json, created_at)
         VALUES (?, ?, ?, NULL, 'routine_fired', 'info', ?, ?, ?)`
      )
        .bind(
          `cact_${crypto.randomUUID().replace(/-/g, '')}`,
          routine.tenant_id,
          routine.company_id,
          `Routine "${routine.title}" fired.`,
          JSON.stringify({ routineId: routine.id }),
          now
        )
        .run()

      await env.DB.prepare(
        `UPDATE company_routines SET last_run_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
      )
        .bind(now, now, routine.tenant_id, routine.id)
        .run()
    } catch {
      // continue with other routines
    }
  }
}

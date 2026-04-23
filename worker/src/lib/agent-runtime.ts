import type { EnvBindings } from './context'
import { wakeCompanyAgent } from './companies'

type AgentRow = {
  id: string
  tenant_id: string
  company_id: string
  created_by: string
  wakeup_policy_json: string | null
}

type WakeupPolicy = {
  mode?: 'on_demand' | 'scheduled' | 'continuous'
  intervalMinutes?: number
}

function shouldTick(policy: WakeupPolicy, now: number, lastTick: number | undefined): boolean {
  if (policy.mode === 'continuous') return true
  if (policy.mode === 'scheduled') {
    const intervalMs = (policy.intervalMinutes ?? 60) * 60_000
    return !lastTick || now - lastTick >= intervalMs
  }
  // on_demand = alarm-driven only when signaled, skip autonomous ticks
  return false
}

/**
 * Called from the CompanyRuntimeCoordinator DO alarm. Iterates the company's
 * agents and invokes `wakeCompanyAgent` on any that are due per their
 * wakeup_policy_json. All work goes through existing paperclip primitives.
 */
export async function tickCompanyAgents(
  env: EnvBindings,
  input: { tenantId: string; companyId: string }
): Promise<void> {
  const now = Date.now()

  const rows = await env.DB.prepare(
    `SELECT id, tenant_id, company_id, created_by, wakeup_policy_json
     FROM company_agents
     WHERE tenant_id = ? AND company_id = ?`
  )
    .bind(input.tenantId, input.companyId)
    .all<AgentRow>()
    .catch(() => ({ results: [] as AgentRow[] }))

  const lastTicks = await env.DB.prepare(
    `SELECT metadata_json FROM company_activity
     WHERE tenant_id = ? AND company_id = ? AND category = 'agent_heartbeat'
     ORDER BY created_at DESC LIMIT 50`
  )
    .bind(input.tenantId, input.companyId)
    .all<{ metadata_json: string | null }>()
    .catch(() => ({ results: [] as Array<{ metadata_json: string | null }> }))

  const lastByAgent = new Map<string, number>()
  for (const row of lastTicks.results) {
    try {
      const meta = row.metadata_json ? (JSON.parse(row.metadata_json) as { agentId?: string; tickAt?: number }) : null
      if (meta?.agentId && meta.tickAt && !lastByAgent.has(meta.agentId)) {
        lastByAgent.set(meta.agentId, meta.tickAt)
      }
    } catch {
      // ignore malformed metadata
    }
  }

  for (const agent of rows.results) {
    let policy: WakeupPolicy = {}
    try {
      policy = agent.wakeup_policy_json ? (JSON.parse(agent.wakeup_policy_json) as WakeupPolicy) : {}
    } catch {
      policy = {}
    }

    if (!shouldTick(policy, now, lastByAgent.get(agent.id))) continue

    try {
      await wakeCompanyAgent(env, {
        tenantId: agent.tenant_id,
        userId: agent.created_by,
        agentId: agent.id,
        reason: 'scheduled_tick',
        targetType: null,
        targetId: null,
      })
    } catch {
      // continue with other agents
    }
  }
}

import { Hono } from 'hono'
import { processRoutines } from './lib/routine-scheduler'
import { pluginsRoute } from './routes/plugins'

import { initDb } from './db/init'
import { requireContext } from './lib/context'
import { projectsRoute } from './routes/projects'
import { itemsRoute } from './routes/items'
import { seedRoute } from './routes/seed'
import { agentsRoute } from './routes/agents'
import { sessionRoute } from './routes/session'
import { planningContextsRoute } from './routes/planning-contexts'
import { proposalsRoute } from './routes/proposals'
import { authRoute } from './routes/auth'
import adminRoute from './routes/admin'
import integrationsRoute from './routes/integrations'
import { billingRoute } from './routes/billing'
import { aiRoute } from './routes/ai'
import skillsRoute from './routes/skills'
import { projectMemoryRoute } from './routes/project-memory'
import { debugRoute } from './routes/debug'
import { runtimeRoute } from './routes/runtime'
import { assistantRoute, publicAssistantRoute } from './routes/assistant'
import { northstarRoute } from './routes/northstar'
import { executionSessionsPublicRoute, executionSessionsRoute } from './routes/execution-sessions'
import { companiesRoute } from './routes/companies'
import { inboxRoute } from './routes/inbox'
import type { EnvBindings } from './lib/context'
import { AssistantThreadStreamDurableObject } from './lib/assistant-live'
import { CompanyRuntimeCoordinatorDurableObject, ExecutionSessionStreamDurableObject } from './lib/control-plane-live'
import { paperclipAliasesRoute } from './routes/paperclip-aliases'
import {
  listCompanies,
  listCompanyAgents,
  listCompanyApprovals,
  listCompanyRoutines,
  listCompanyGoals,
  listCompanyIssues,
  ensureCompanyExists,
} from './lib/companies'

const app = new Hono<{ Bindings: EnvBindings }>()
let dbInitPromise: Promise<void> | null = null

async function ensureDbReady(c: Parameters<typeof initDb>[0]) {
  if (!dbInitPromise) {
    console.log('[taskcenter] db init start')
    dbInitPromise = initDb(c).catch((error) => {
      console.error('[taskcenter] db init failed', error)
      dbInitPromise = null
      throw error
    })
  }

  await dbInitPromise
  console.log('[taskcenter] db init ready')
}

app.get('/api/health', (c) => c.json({ ok: true }))
app.use('/api/*', async (c, next) => {
  await ensureDbReady(c as Parameters<typeof initDb>[0])
  await next()
})
// Paperclip-UI aliases must mount BEFORE /api/auth so that paths like
// /api/auth/get-session reach the shape-mapper instead of 404ing inside
// the TaskCenter auth router.
app.route('/api', paperclipAliasesRoute)
app.route('/api/auth', authRoute)
app.route('/api/billing', billingRoute)
app.route('/api/runtime', runtimeRoute)
app.route('/api/public/assistant', publicAssistantRoute)
app.route('/api/public/execution-sessions', executionSessionsPublicRoute)

app.post('/api/admin/init', async (c) => {
  try {
    await initDb(c)
    return c.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database init failed'
    return c.json({ ok: false, error: message }, 500)
  }
})

app.use('/api/*', requireContext)

// ----- Paperclip UI envelope unwrappers ------------------------------------
// The forked Paperclip UI expects bare arrays from list endpoints; TaskCenter
// wraps them in { companies: [...] }, { agents: [...] }, etc. These aliases
// mount BEFORE the real routes so the UI gets the shape it expects.
app.get('/api/companies', async (c) => {
  const r = await listCompanies(c.env, c.get('tenantId'))
  return c.json(r.companies)
})
app.get('/api/companies/:companyId/agents', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json([])
  const r = await listCompanyAgents(c.env, c.get('tenantId'), company.id)
  return c.json(r.agents)
})
app.get('/api/companies/:companyId/approvals', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json([])
  const r = await listCompanyApprovals(c.env, c.get('tenantId'), company.id)
  return c.json(r.approvals)
})
app.get('/api/companies/:companyId/routines', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json([])
  const r = await listCompanyRoutines(c.env, c.get('tenantId'), company.id)
  return c.json(r.routines)
})
app.get('/api/companies/:companyId/goals', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json([])
  const r = await listCompanyGoals(c.env, c.get('tenantId'), company.id)
  return c.json(r.goals)
})
app.get('/api/companies/:companyId/issues', async (c) => {
  const company = await ensureCompanyExists(c.env, c.get('tenantId'), c.req.param('companyId'))
  if (!company) return c.json([])
  const r = await listCompanyIssues(c.env, c.get('tenantId'), company.id)
  return c.json(r.issues)
})

app.route('/api/session', sessionRoute)
app.route('/api/seed', seedRoute)
app.route('/api/projects', projectsRoute)
app.route('/api/companies', companiesRoute)
app.route('/api/items', itemsRoute)
app.route('/api/inbox', inboxRoute)
app.route('/api/planning-contexts', planningContextsRoute)
app.route('/api/ai', aiRoute)
app.route('/api/agents', agentsRoute)
app.route('/api/proposals', proposalsRoute)
app.route('/api/admin', adminRoute)
app.route('/api/integrations', integrationsRoute)
app.route('/api/skills', skillsRoute)
app.route('/api/project-memory', projectMemoryRoute)
app.route('/api/debug', debugRoute)
app.route('/api/assistant', assistantRoute)
app.route('/api/northstar', northstarRoute)
app.route('/api/execution-sessions', executionSessionsRoute)
app.route('/api/plugins', pluginsRoute)

// Stub endpoints for Paperclip features TaskCenter doesn't implement.
// Returning harmless defaults keeps the UI quiet.
app.get('/api/instance/settings/general', (c) => c.json({ instanceName: 'TaskCenter', features: {} }))
app.get('/api/instance/settings/heartbeats', (c) => c.json({ heartbeats: [] }))
app.get('/api/instance/settings/experimental', (c) => c.json({ flags: {} }))
app.get('/api/instance/settings/plugins', (c) => c.json({ plugins: [] }))

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_controller: ScheduledController, env: EnvBindings, _ctx: ExecutionContext) {
    await processRoutines(env).catch((error) => console.error('[cron] routine processor failed', error))
  },
} satisfies ExportedHandler<EnvBindings>
export { AssistantThreadStreamDurableObject, ExecutionSessionStreamDurableObject, CompanyRuntimeCoordinatorDurableObject }

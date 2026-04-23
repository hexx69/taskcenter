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
import { executionSessionsPublicRoute, executionSessionsRoute } from './routes/execution-sessions'
import { companiesRoute } from './routes/companies'
import { inboxRoute } from './routes/inbox'
import type { EnvBindings } from './lib/context'
import { AssistantThreadStreamDurableObject } from './lib/assistant-live'
import { CompanyRuntimeCoordinatorDurableObject, ExecutionSessionStreamDurableObject } from './lib/control-plane-live'

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

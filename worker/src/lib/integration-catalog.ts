import type { EnvBindings } from './context'

export type IntegrationField = {
  key: 'accessToken' | 'refreshToken' | 'serviceUrl' | 'accountId' | 'accountEmail' | 'accountName'
  label: string
  type: 'text' | 'password' | 'url' | 'email'
  placeholder?: string
  required?: boolean
  helpText?: string
}

export type IntegrationCatalogEntry = {
  key: string
  name: string
  description: string
  category: 'development' | 'planning' | 'automation' | 'analytics'
  authKind: 'oauth' | 'token' | 'webhook' | 'admin'
  serviceType?: string
  requiresAdmin: boolean
  userConnectable: boolean
  adminConfigurable: boolean
  showcase: boolean
  handledByAgent: 'integration_specialist'
  setupFields: IntegrationField[]
}

export const integrationCatalog: readonly IntegrationCatalogEntry[] = [
  {
    key: 'github',
    name: 'GitHub',
    description: 'Sync repos, contributors, and push-based progress review for collaborative code work.',
    category: 'development',
    authKind: 'oauth',
    serviceType: 'github',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [],
  },
  {
    key: 'jira',
    name: 'Jira',
    description: 'Pull projects and issues into planning context and execution tracking.',
    category: 'planning',
    authKind: 'token',
    serviceType: 'jira',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'serviceUrl', label: 'Jira site URL', type: 'url', placeholder: 'https://your-team.atlassian.net', required: true },
      { key: 'accessToken', label: 'API token', type: 'password', placeholder: 'Paste your Jira API token', required: true },
      { key: 'accountEmail', label: 'Account email', type: 'email', placeholder: 'name@company.com', required: true },
      { key: 'accountName', label: 'Display name', type: 'text', placeholder: 'Engineering workspace', required: false },
    ],
  },
  {
    key: 'notion',
    name: 'Notion',
    description: 'Connect workspace docs and planning notes so agents stop pretending they remember them telepathically.',
    category: 'planning',
    authKind: 'token',
    serviceType: 'notion',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accessToken', label: 'Integration token', type: 'password', placeholder: 'Paste your Notion internal integration token', required: true },
      { key: 'accountId', label: 'Workspace ID', type: 'text', placeholder: 'Optional workspace identifier', required: false },
      { key: 'accountName', label: 'Workspace name', type: 'text', placeholder: 'Design systems hub', required: false },
    ],
  },
  {
    key: 'google_sheets',
    name: 'Google Sheets',
    description: 'Send structured planning data and execution logs into spreadsheet workflows.',
    category: 'automation',
    authKind: 'token',
    serviceType: 'google_sheets',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accessToken', label: 'Access token or app password', type: 'password', placeholder: 'Paste your Google API token', required: true },
      { key: 'accountEmail', label: 'Google account email', type: 'email', placeholder: 'ops@company.com', required: false },
      { key: 'accountName', label: 'Sheet destination', type: 'text', placeholder: 'Quarterly roadmap sheet', required: false },
    ],
  },
  {
    key: 'airtable',
    name: 'Airtable',
    description: 'Sync structured records for pipelines, intake, and lightweight operational boards.',
    category: 'automation',
    authKind: 'token',
    serviceType: 'airtable',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accessToken', label: 'Personal access token', type: 'password', placeholder: 'Paste your Airtable token', required: true },
      { key: 'accountId', label: 'Base ID', type: 'text', placeholder: 'appXXXXXXXXXXXXXX', required: false },
      { key: 'accountName', label: 'Base name', type: 'text', placeholder: 'Growth ops base', required: false },
    ],
  },
  {
    key: 'webhooks',
    name: 'Webhooks',
    description: 'Send TaskCenter events to any HTTP endpoint that behaves itself.',
    category: 'automation',
    authKind: 'webhook',
    serviceType: 'webhooks',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'serviceUrl', label: 'Webhook URL', type: 'url', placeholder: 'https://example.com/taskcenter/webhook', required: true },
      { key: 'accessToken', label: 'Signing secret', type: 'password', placeholder: 'Optional shared secret', required: false },
      { key: 'accountName', label: 'Destination name', type: 'text', placeholder: 'Operations receiver', required: false },
    ],
  },
  {
    key: 'slack',
    name: 'Slack',
    description: 'Route task updates, handoffs, and agent summaries into shared channels.',
    category: 'automation',
    authKind: 'token',
    serviceType: 'slack',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accessToken', label: 'Bot token', type: 'password', placeholder: 'xoxb-...', required: true },
      { key: 'accountId', label: 'Workspace ID', type: 'text', placeholder: 'T01234567', required: false },
      { key: 'accountName', label: 'Workspace name', type: 'text', placeholder: 'Bootminds Slack', required: false },
    ],
  },
  {
    key: 'coda',
    name: 'Coda',
    description: 'Push synced records and generated plans into docs that double as operating systems.',
    category: 'automation',
    authKind: 'token',
    serviceType: 'coda',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accessToken', label: 'API token', type: 'password', placeholder: 'Paste your Coda API token', required: true },
      { key: 'accountId', label: 'Doc ID', type: 'text', placeholder: 'Optional doc identifier', required: false },
      { key: 'accountName', label: 'Workspace name', type: 'text', placeholder: 'Product operations doc', required: false },
    ],
  },
  {
    key: 'google_analytics',
    name: 'Google Analytics',
    description: 'Workspace-level analytics routing for tracking launches and campaign outcomes.',
    category: 'analytics',
    authKind: 'admin',
    requiresAdmin: true,
    userConnectable: false,
    adminConfigurable: true,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accountId', label: 'Property ID', type: 'text', placeholder: '123456789', required: true },
      { key: 'accountName', label: 'Property name', type: 'text', placeholder: 'TaskCenter marketing', required: false },
      { key: 'accessToken', label: 'Measurement secret or API token', type: 'password', placeholder: 'Optional secret for event pushes', required: false },
    ],
  },
  {
    key: 'meta_pixel',
    name: 'Meta Pixel',
    description: 'Workspace-managed conversion tracking for product and marketing flows.',
    category: 'analytics',
    authKind: 'admin',
    requiresAdmin: true,
    userConnectable: false,
    adminConfigurable: true,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'accountId', label: 'Pixel ID', type: 'text', placeholder: '123456789012345', required: true },
      { key: 'accountName', label: 'Pixel name', type: 'text', placeholder: 'TaskCenter acquisition pixel', required: false },
      { key: 'accessToken', label: 'Conversion API token', type: 'password', placeholder: 'Optional token for server-side events', required: false },
    ],
  },
  {
    key: 'zapier',
    name: 'Zapier',
    description: 'Trigger thousands of downstream automations from TaskCenter events.',
    category: 'automation',
    authKind: 'webhook',
    serviceType: 'zapier',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'serviceUrl', label: 'Catch hook URL', type: 'url', placeholder: 'https://hooks.zapier.com/hooks/catch/...', required: true },
      { key: 'accountName', label: 'Zap name', type: 'text', placeholder: 'Board update relay', required: false },
    ],
  },
  {
    key: 'make',
    name: 'Make',
    description: 'Drive scenario-based automations for approvals, syncing, and routing.',
    category: 'automation',
    authKind: 'webhook',
    serviceType: 'make',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'serviceUrl', label: 'Scenario webhook URL', type: 'url', placeholder: 'https://hook.eu1.make.com/...', required: true },
      { key: 'accountName', label: 'Scenario name', type: 'text', placeholder: 'Sprint sync scenario', required: false },
    ],
  },
  {
    key: 'pipedream',
    name: 'Pipedream',
    description: 'Ship task and planning events into event-driven workflows without turning the app into a science fair project.',
    category: 'automation',
    authKind: 'webhook',
    serviceType: 'pipedream',
    requiresAdmin: false,
    userConnectable: true,
    adminConfigurable: false,
    showcase: true,
    handledByAgent: 'integration_specialist',
    setupFields: [
      { key: 'serviceUrl', label: 'Source URL', type: 'url', placeholder: 'https://eo1234.m.pipedream.net', required: true },
      { key: 'accountName', label: 'Workflow name', type: 'text', placeholder: 'Launch ops pipeline', required: false },
    ],
  },
] as const

export function getCatalogEntry(key: string) {
  return integrationCatalog.find((entry) => entry.key === key) || null
}

function buildConnectionSummary(
  entry: IntegrationCatalogEntry,
  connection: {
    service_account_name: string | null
    service_account_email: string | null
    service_url: string | null
  } | null
) {
  if (!connection) return null
  return connection.service_account_name || connection.service_account_email || connection.service_url || `${entry.name} connected`
}

export async function listIntegrationCatalogStatus(
  env: EnvBindings,
  input: { tenantId: string; userId: string }
) {
  const serviceTypes = integrationCatalog
    .map((entry) => entry.serviceType)
    .filter((value): value is string => Boolean(value))

  const [userConnections, adminConfigs] = await Promise.all([
    serviceTypes.length > 0
      ? env.DB.prepare(
          `SELECT service_type, service_url, service_account_id, service_account_email, service_account_name, updated_at
           FROM service_connections
           WHERE tenant_id = ? AND user_id = ? AND is_active = true AND service_type IN (${serviceTypes.map(() => '?').join(', ')})
           ORDER BY updated_at DESC`
        )
          .bind(input.tenantId, input.userId, ...serviceTypes)
          .all<{
            service_type: string
            service_url: string | null
            service_account_id: string | null
            service_account_email: string | null
            service_account_name: string | null
            updated_at: string
          }>()
      : Promise.resolve({
          results: [] as Array<{
            service_type: string
            service_url: string | null
            service_account_id: string | null
            service_account_email: string | null
            service_account_name: string | null
            updated_at: string
          }>,
        }),
    env.DB.prepare(
      `SELECT integration_key, status, summary, updated_at
       FROM admin_integration_configs
       WHERE tenant_id = ?`
    )
      .bind(input.tenantId)
      .all<{ integration_key: string; status: string; summary: string | null; updated_at: number }>(),
  ])

  const connectionByType = new Map<string, typeof userConnections.results[number]>()
  for (const row of userConnections.results) {
    if (!connectionByType.has(row.service_type)) {
      connectionByType.set(row.service_type, row)
    }
  }

  const adminByKey = new Map<string, typeof adminConfigs.results[number]>()
  for (const row of adminConfigs.results) {
    adminByKey.set(row.integration_key, row)
  }

  return integrationCatalog.map((entry) => {
    const connection = entry.serviceType ? connectionByType.get(entry.serviceType) || null : null
    const adminConfig = adminByKey.get(entry.key) || null
    const workspaceStatus = entry.requiresAdmin
      ? adminConfig?.status || 'missing'
      : adminConfig?.status || 'not_required'
    const connected = entry.requiresAdmin ? workspaceStatus === 'active' : Boolean(connection)
    const effectiveState = entry.requiresAdmin
      ? workspaceStatus === 'active'
        ? 'connected'
        : workspaceStatus === 'pending'
          ? 'pending_admin'
          : 'admin_required'
      : connection
        ? 'connected'
        : 'needs_user_connect'

    return {
      ...entry,
      status: {
        connected,
        effectiveState,
        userConnected: Boolean(connection),
        userConnectionLabel: buildConnectionSummary(entry, connection),
        userConnectionUpdatedAt: connection?.updated_at || null,
        workspaceStatus,
        workspaceConfigured: workspaceStatus === 'active' || workspaceStatus === 'pending',
        workspaceSummary: adminConfig?.summary || null,
      },
    }
  })
}

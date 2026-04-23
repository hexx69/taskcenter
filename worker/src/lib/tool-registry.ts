import type { EnvBindings } from './context'
import { listIntegrationCatalogStatus } from './integration-catalog'

type RuntimeToolCategory = 'integration' | 'custom_connector' | 'project_repo'
type RuntimeToolAvailability = 'selected' | 'available'
type RuntimeToolReadiness = 'ready' | 'requires_setup' | 'pending' | 'disabled'

type RuntimeIntegrationTool = Awaited<ReturnType<typeof listIntegrationCatalogStatus>>[number]

export type RuntimeToolDescriptor = {
  key: string
  label: string
  category: RuntimeToolCategory
  availability: RuntimeToolAvailability
  readiness: RuntimeToolReadiness
  description: string
  statusSummary: string
  authKind?: string | null
  selected: boolean
  requiresAuth: boolean
  source:
    | {
        type: 'integration'
        integrationKey: string
        workspaceStatus: string
        effectiveState: string
      }
    | {
        type: 'custom_connector'
        connectorType: 'custom_api' | 'custom_mcp'
        connectorId: string
        accessScope: 'personal' | 'workspace'
        transport: 'http' | 'sse' | 'stdio' | null
        authMode: 'none' | 'bearer' | 'header'
      }
    | {
        type: 'project_repo'
        repoFullName: string
        collaborationMode: string | null
        reviewOnPush: boolean
      }
}

export type RuntimeToolSession = {
  selectedConnectorLabels: string[]
  summaryText: string
  counts: {
    total: number
    selected: number
    ready: number
    requiresSetup: number
  }
  tools: RuntimeToolDescriptor[]
}

type RuntimeToolSessionSources = {
  integrationTools: RuntimeIntegrationTool[]
  customConnectors: Array<{
    id: string
    connector_type: 'custom_api' | 'custom_mcp'
    name: string
    slug: string
    description: string
    status: 'active' | 'pending' | 'disabled'
    access_scope: 'personal' | 'workspace'
    transport: 'http' | 'sse' | 'stdio' | null
    auth_mode: 'none' | 'bearer' | 'header'
  }>
  projectGithubLink?: {
    repo_full_name: string
    collaboration_mode: string | null
    review_on_push: number | null
  } | null
  selectedConnectorKeys?: string[]
}

type RuntimeToolSessionScope = {
  tenantId: string
  userId: string
  projectId?: string
  selectedConnectorKeys?: string[]
}

function buildCustomConnectorSelectionKey(input: {
  connectorType: 'custom_api' | 'custom_mcp'
  id: string
  slug: string
}) {
  return `${input.connectorType}:${input.id}:${input.slug}`
}

function formatFallbackLabel(key: string) {
  return key
    .split(':')
    .at(-1)
    ?.split(/[_-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || key
}

function mapIntegrationReadiness(tool: RuntimeIntegrationTool): RuntimeToolReadiness {
  if (tool.status.effectiveState === 'connected') return 'ready'
  if (tool.status.effectiveState === 'pending_admin') return 'pending'
  return 'requires_setup'
}

function mapCustomConnectorReadiness(
  status: 'active' | 'pending' | 'disabled'
): RuntimeToolReadiness {
  if (status === 'active') return 'ready'
  if (status === 'pending') return 'pending'
  return 'disabled'
}

function buildIntegrationStatusSummary(tool: RuntimeIntegrationTool) {
  if (tool.status.effectiveState === 'connected') {
    return tool.status.userConnectionLabel
      ? `${tool.name} ready via ${tool.status.userConnectionLabel}`
      : `${tool.name} ready`
  }
  if (tool.status.effectiveState === 'pending_admin') {
    return tool.status.workspaceSummary
      ? `${tool.name} is pending workspace setup: ${tool.status.workspaceSummary}`
      : `${tool.name} is pending workspace setup`
  }
  if (tool.requiresAdmin) {
    return tool.status.workspaceSummary
      ? `${tool.name} needs admin configuration: ${tool.status.workspaceSummary}`
      : `${tool.name} needs admin configuration`
  }
  return `Connect ${tool.name} before trying to use it in chat`
}

export function buildRuntimeToolSessionFromSources(input: RuntimeToolSessionSources): RuntimeToolSession {
  const selectedKeys = new Set(input.selectedConnectorKeys || [])
  const tools: RuntimeToolDescriptor[] = []

  for (const tool of input.integrationTools) {
    tools.push({
      key: tool.key,
      label: tool.name,
      category: 'integration',
      availability: selectedKeys.has(tool.key) ? 'selected' : 'available',
      readiness: mapIntegrationReadiness(tool),
      description: tool.description,
      statusSummary: buildIntegrationStatusSummary(tool),
      authKind: tool.authKind,
      selected: selectedKeys.has(tool.key),
      requiresAuth: tool.authKind !== 'admin',
      source: {
        type: 'integration',
        integrationKey: tool.key,
        workspaceStatus: tool.status.workspaceStatus,
        effectiveState: tool.status.effectiveState,
      },
    })
  }

  for (const connector of input.customConnectors) {
    const key = buildCustomConnectorSelectionKey({
      connectorType: connector.connector_type,
      id: connector.id,
      slug: connector.slug,
    })
    tools.push({
      key,
      label: connector.name,
      category: 'custom_connector',
      availability: selectedKeys.has(key) ? 'selected' : 'available',
      readiness: mapCustomConnectorReadiness(connector.status),
      description: connector.description,
      statusSummary:
        connector.status === 'active'
          ? `${connector.name} is available as a ${connector.connector_type === 'custom_mcp' ? 'custom MCP' : 'custom API'} connector`
          : connector.status === 'pending'
            ? `${connector.name} is saved but still pending`
            : `${connector.name} is disabled`,
      authKind: connector.auth_mode,
      selected: selectedKeys.has(key),
      requiresAuth: connector.auth_mode !== 'none',
      source: {
        type: 'custom_connector',
        connectorType: connector.connector_type,
        connectorId: connector.id,
        accessScope: connector.access_scope,
        transport: connector.transport,
        authMode: connector.auth_mode,
      },
    })
  }

  if (input.projectGithubLink?.repo_full_name) {
    tools.push({
      key: `project_repo:${input.projectGithubLink.repo_full_name}`,
      label: 'Linked Project Repo',
      category: 'project_repo',
      availability: 'available',
      readiness: 'ready',
      description: 'Project-linked GitHub repository context for repo review and implementation runs.',
      statusSummary: `${input.projectGithubLink.repo_full_name} (${input.projectGithubLink.collaboration_mode || 'agent_build'}, review_on_push=${input.projectGithubLink.review_on_push ? 'true' : 'false'})`,
      authKind: 'workspace_link',
      selected: false,
      requiresAuth: false,
      source: {
        type: 'project_repo',
        repoFullName: input.projectGithubLink.repo_full_name,
        collaborationMode: input.projectGithubLink.collaboration_mode,
        reviewOnPush: Boolean(input.projectGithubLink.review_on_push),
      },
    })
  }

  const toolByKey = new Map(tools.map((tool) => [tool.key, tool]))
  const selectedConnectorLabels = (input.selectedConnectorKeys || []).map((key) => toolByKey.get(key)?.label || formatFallbackLabel(key))
  const readyCount = tools.filter((tool) => tool.readiness === 'ready').length
  const requiresSetupCount = tools.filter((tool) => tool.readiness === 'requires_setup').length
  const lines = [
    'Runtime tool session:',
    `- Selected connectors in scope: ${selectedConnectorLabels.length ? selectedConnectorLabels.join(', ') : 'none'}`,
    `- Ready tools: ${readyCount}/${tools.length}`,
    `- Needs setup: ${requiresSetupCount}`,
    ...tools.map((tool) => {
      const flags: string[] = [tool.category, tool.availability, tool.readiness]
      if (tool.authKind) flags.push(`auth=${tool.authKind}`)
      return `- ${tool.label} [${flags.join(', ')}] ${tool.statusSummary}`
    }),
  ]

  return {
    selectedConnectorLabels,
    summaryText: lines.join('\n'),
    counts: {
      total: tools.length,
      selected: tools.filter((tool) => tool.selected).length,
      ready: readyCount,
      requiresSetup: requiresSetupCount,
    },
    tools,
  }
}

export async function loadRuntimeToolSession(
  env: EnvBindings,
  scope: RuntimeToolSessionScope
): Promise<RuntimeToolSession> {
  const [integrationTools, customConnectors, projectGithubLink] = await Promise.all([
    listIntegrationCatalogStatus(env, { tenantId: scope.tenantId, userId: scope.userId }),
    env.DB.prepare(
      `SELECT id, connector_type, name, slug, description, status, access_scope, transport, auth_mode
       FROM custom_connectors
       WHERE tenant_id = ?
         AND status != 'disabled'
         AND (access_scope = 'workspace' OR user_id = ?)
       ORDER BY access_scope DESC, updated_at DESC`
    )
      .bind(scope.tenantId, scope.userId)
      .all<RuntimeToolSessionSources['customConnectors'][number]>(),
    scope.projectId
      ? env.DB.prepare(
          `SELECT repo_full_name, collaboration_mode, review_on_push
           FROM project_github_links
           WHERE tenant_id = ? AND project_id = ?
           LIMIT 1`
        )
          .bind(scope.tenantId, scope.projectId)
          .first<RuntimeToolSessionSources['projectGithubLink']>()
      : Promise.resolve(null),
  ])

  return buildRuntimeToolSessionFromSources({
    integrationTools,
    customConnectors: customConnectors.results,
    projectGithubLink,
    selectedConnectorKeys: scope.selectedConnectorKeys,
  })
}

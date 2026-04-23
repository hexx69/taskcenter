import { describe, expect, it } from 'vitest'
import { buildRuntimeToolSessionFromSources } from './tool-registry'

describe('runtime tool session', () => {
  it('builds a session-scoped registry with readiness and selected tools', () => {
    const session = buildRuntimeToolSessionFromSources({
      integrationTools: [
        {
          key: 'github',
          name: 'GitHub',
          description: 'Repo access',
          category: 'development',
          authKind: 'oauth',
          serviceType: 'github',
          requiresAdmin: false,
          userConnectable: true,
          adminConfigurable: false,
          showcase: true,
          handledByAgent: 'integration_specialist',
          setupFields: [],
          status: {
            connected: true,
            effectiveState: 'connected',
            userConnected: true,
            userConnectionLabel: 'zex@github',
            userConnectionUpdatedAt: '2026-04-04 12:00:00',
            workspaceStatus: 'not_required',
            workspaceConfigured: false,
            workspaceSummary: null,
          },
        },
        {
          key: 'notion',
          name: 'Notion',
          description: 'Docs access',
          category: 'planning',
          authKind: 'token',
          serviceType: 'notion',
          requiresAdmin: false,
          userConnectable: true,
          adminConfigurable: false,
          showcase: true,
          handledByAgent: 'integration_specialist',
          setupFields: [],
          status: {
            connected: false,
            effectiveState: 'needs_user_connect',
            userConnected: false,
            userConnectionLabel: null,
            userConnectionUpdatedAt: null,
            workspaceStatus: 'not_required',
            workspaceConfigured: false,
            workspaceSummary: null,
          },
        },
      ],
      customConnectors: [
        {
          id: 'conn_1',
          connector_type: 'custom_mcp',
          name: 'Linear MCP',
          slug: 'linear-mcp',
          description: 'Custom Linear access',
          status: 'active',
          access_scope: 'workspace',
          transport: 'http',
          auth_mode: 'bearer',
        },
      ],
      projectGithubLink: {
        repo_full_name: 'acme/taskcenter',
        collaboration_mode: 'collaborative_review',
        review_on_push: 1,
      },
      selectedConnectorKeys: ['github', 'custom_mcp:conn_1:linear-mcp'],
    })

    expect(session.selectedConnectorLabels).toEqual(['GitHub', 'Linear MCP'])
    expect(session.counts.total).toBe(4)
    expect(session.counts.selected).toBe(2)
    expect(session.counts.ready).toBe(3)
    expect(session.counts.requiresSetup).toBe(1)
    expect(session.summaryText).toContain('Runtime tool session:')
    expect(session.summaryText).toContain('GitHub')
    expect(session.summaryText).toContain('Connect Notion before trying to use it in chat')
  })
})

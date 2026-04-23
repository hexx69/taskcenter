export type ProjectAgentRuntimeContext = {
  currentPage?: string
  currentRoute?: string
  activeView?: string
  currentUserId?: string
  currentUserName?: string
  currentUserEmail?: string
  projectName?: string
  projectViewMode?: 'detailed' | 'compact'
  workspaceName?: string
  selectedTaskId?: string
  selectedTaskTitle?: string
  selectedTaskStatus?: string
  pendingProposalId?: string
  selectedConnectorKeys?: string[]
  selectedConnectorLabels?: string[]
  screenSummary?: string
  conversationSummary?: string
  toolSummary?: string
  activeGoal?: string
}

function compact(value: string, max = 260) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

export function summarizeNorthstarHistory(rows: Array<{ role: string; content: string }>) {
  if (rows.length === 0) return ''

  const userTurns = rows.filter((row) => row.role === 'user').slice(-4)
  const assistantTurns = rows.filter((row) => row.role === 'assistant').slice(-4)
  const summaryLines = [
    userTurns.length
      ? `Recent user intent before the latest turns: ${userTurns.map((row) => compact(row.content, 180)).join(' | ')}`
      : null,
    assistantTurns.length
      ? `Recent assistant carry-forward: ${assistantTurns.map((row) => compact(row.content, 180)).join(' | ')}`
      : null,
  ].filter(Boolean)

  return summaryLines.join('\n')
}

export function buildNorthstarRuntimePrompt(context?: ProjectAgentRuntimeContext, historySummary?: string) {
  const lines = [
    'Northstar runtime guidance:',
    '- Treat screen context as the current user-visible truth for navigation, page-specific guidance, and what is on screen right now.',
    '- Use the tool registry to decide whether the next move is awareness, routing, project retrieval, execution planning, support, or carry-forward memory.',
    '- If the request is broad enough to require coordinated multi-step work, say so explicitly and propose an execution run or proposal sequence instead of pretending one short answer completes it.',
    '- If the user sounds stuck or the assistant lacks evidence, switch into support mode: restate the current screen, name the missing evidence, and give the next one or two actions.',
    '- When context is crowded, preserve the end goal, the latest user ask, and pending approvals instead of rehashing the whole transcript.',
    context?.currentPage ? `Current page: ${context.currentPage}` : null,
    context?.currentRoute ? `Current route: ${context.currentRoute}` : null,
    context?.activeView ? `Active view: ${context.activeView}` : null,
    context?.currentUserId ? `Current user id: ${context.currentUserId}` : null,
    context?.currentUserName ? `Current user name: ${context.currentUserName}` : null,
    context?.currentUserEmail ? `Current user email: ${context.currentUserEmail}` : null,
    context?.workspaceName ? `Workspace: ${context.workspaceName}` : null,
    context?.projectName ? `Focused project: ${context.projectName}` : null,
    context?.projectViewMode ? `Project view mode: ${context.projectViewMode}` : null,
    context?.selectedTaskTitle ? `Focused task: ${context.selectedTaskTitle}${context.selectedTaskStatus ? ` (${context.selectedTaskStatus})` : ''}` : null,
    context?.selectedTaskId ? `Focused task id: ${context.selectedTaskId}` : null,
    context?.pendingProposalId ? `Pending proposal id: ${context.pendingProposalId}` : null,
    context?.selectedConnectorLabels?.length ? `Selected thread connectors: ${context.selectedConnectorLabels.join(', ')}` : null,
    context?.selectedConnectorKeys?.length ? `Selected thread connector keys: ${context.selectedConnectorKeys.join(', ')}` : null,
    context?.activeGoal ? `Active goal: ${context.activeGoal}` : null,
    context?.screenSummary ? `Screen context:\n${context.screenSummary}` : null,
    context?.conversationSummary ? `Conversation carry-forward:\n${context.conversationSummary}` : null,
    historySummary ? `Compressed earlier history:\n${historySummary}` : null,
    context?.toolSummary ? `Northstar tool registry:\n${context.toolSummary}` : null,
  ].filter(Boolean)

  return lines.join('\n')
}

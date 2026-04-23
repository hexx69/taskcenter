import { describe, expect, it } from 'vitest'
import { extractAgentActions } from './orchestrator'

describe('extractAgentActions', () => {
  it('parses task.assign actions from fenced JSON', () => {
    const actions = extractAgentActions(`
Northstar can handle that.

\`\`\`json
{"actions":[{"type":"task.assign","payload":{"taskId":"item_123","assigneeId":"user_456"}}]}
\`\`\`
`)

    expect(actions).toEqual([
      {
        type: 'task.assign',
        payload: {
          taskId: 'item_123',
          assigneeId: 'user_456',
        },
      },
    ])
  })

  it('normalizes alternate task.assign payload keys', () => {
    const actions = extractAgentActions('{"actions":[{"type":"task.assign","payload":{"id":"item_9","memberId":"user_2"}}]}')

    expect(actions).toEqual([
      {
        type: 'task.assign',
        payload: {
          taskId: 'item_9',
          assigneeId: 'user_2',
        },
      },
    ])
  })
})

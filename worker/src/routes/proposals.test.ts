import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyProposalActions } from './proposals'

vi.mock('../lib/app-memory', () => ({
  upsertAppMemoryEntry: vi.fn().mockResolvedValue(undefined),
}))

type ItemRow = {
  id: string
  tenant_id: string
  project_id: string
  title: string
  status: string
  assignee_id: string | null
}

function createFakeDb(item: ItemRow) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes('SELECT id, project_id, title, status')) {
                const [tenantId, projectId, taskId] = args
                if (tenantId === item.tenant_id && projectId === item.project_id && taskId === item.id) {
                  return {
                    id: item.id,
                    project_id: item.project_id,
                    title: item.title,
                    status: item.status,
                  }
                }
              }

              return null
            },
            async run() {
              if (sql.includes('UPDATE items') && sql.includes('SET assignee_id = ?')) {
                item.assignee_id = String(args[0])
                return { success: true }
              }

              return { success: true }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

describe('applyProposalActions', () => {
  let item: ItemRow

  beforeEach(() => {
    item = {
      id: 'item_123',
      tenant_id: 'tenant_1',
      project_id: 'project_1',
      title: 'Investigate routing regression',
      status: 'todo',
      assignee_id: null,
    }
  })

  it('reassigns an existing task through task.assign', async () => {
    await applyProposalActions(
      {
        DB: createFakeDb(item),
      } as never,
      {
        tenantId: 'tenant_1',
        userId: 'owner_1',
        projectId: 'project_1',
        actions: [
          {
            type: 'task.assign',
            payload: {
              taskId: 'item_123',
              assigneeId: 'user_9',
            },
          },
        ],
      }
    )

    expect(item.assignee_id).toBe('user_9')
  })
})

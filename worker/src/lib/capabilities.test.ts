import { describe, expect, it } from 'vitest'
import { getWorkspaceCapabilities } from './capabilities'

function createDb(hasRepoLink: boolean) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return hasRepoLink ? { id: 'link_123' } : null
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

describe('workspace capabilities', () => {
  it('marks billing ready only when all Stripe env vars exist', async () => {
    const result = await getWorkspaceCapabilities(
      {
        DB: createDb(false),
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_PRICE_PRO_MONTHLY: 'price_pm',
        STRIPE_PRICE_PRO_YEARLY: 'price_py',
        STRIPE_PRICE_TEAM_MONTHLY: 'price_tm',
        STRIPE_PRICE_TEAM_YEARLY: 'price_ty',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      },
      { tenantId: 'tenant_1' }
    )

    expect(result.billingReady).toBe(true)
  })

  it('detects repo review readiness from linked repos', async () => {
    const withRepo = await getWorkspaceCapabilities({ DB: createDb(true) } as never, { tenantId: 'tenant_1' })
    const withoutRepo = await getWorkspaceCapabilities({ DB: createDb(false) } as never, { tenantId: 'tenant_1' })

    expect(withRepo.repoReviewReady).toBe(true)
    expect(withoutRepo.repoReviewReady).toBe(false)
  })
})

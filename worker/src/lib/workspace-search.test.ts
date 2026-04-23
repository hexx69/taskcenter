import { describe, expect, it } from 'vitest'
import { buildWorkspaceSearchExcerpt, scoreWorkspaceCandidate, tokenizeWorkspaceQuery } from './workspace-search'

describe('workspace search helpers', () => {
  it('tokenizes and deduplicates workspace queries', () => {
    expect(tokenizeWorkspaceQuery('Debug the failing failing Stripe webhook flow')).toEqual([
      'debug',
      'the',
      'failing',
      'stripe',
      'webhook',
      'flow',
    ])
  })

  it('scores candidates higher when more query tokens match', () => {
    const tokens = tokenizeWorkspaceQuery('stripe checkout billing')
    const strong = scoreWorkspaceCandidate({ text: 'Stripe checkout is blocked because billing metadata is missing.' }, tokens)
    const weak = scoreWorkspaceCandidate({ text: 'Calendar sync issue in a different project.' }, tokens)

    expect(strong).toBeGreaterThan(weak)
    expect(strong).toBeGreaterThan(0)
  })

  it('builds a focused excerpt around the first match', () => {
    const excerpt = buildWorkspaceSearchExcerpt(
      'This project has several notes, but the critical billing webhook reconciliation issue is happening after checkout completes.',
      tokenizeWorkspaceQuery('billing webhook')
    )

    expect(excerpt.toLowerCase()).toContain('billing webhook')
    expect(excerpt.length).toBeLessThanOrEqual(183)
  })
})

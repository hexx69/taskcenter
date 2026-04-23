export type WorkspaceSearchToken = string

export type WorkspaceSearchCandidate = {
  text: string
  recencyBoost?: number
}

export function tokenizeWorkspaceQuery(input: string): WorkspaceSearchToken[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ).slice(0, 12)
}

export function scoreWorkspaceCandidate(candidate: WorkspaceSearchCandidate, tokens: WorkspaceSearchToken[]) {
  const normalized = candidate.text.toLowerCase()
  if (!normalized.trim()) return 0
  if (tokens.length === 0) return normalized.length > 0 ? 1 + (candidate.recencyBoost || 0) : 0

  let score = candidate.recencyBoost || 0
  for (const token of tokens) {
    if (!normalized.includes(token)) continue
    score += token.length >= 7 ? 8 : token.length >= 4 ? 5 : 3
  }

  return score
}

export function buildWorkspaceSearchExcerpt(input: string, tokens: WorkspaceSearchToken[], limit = 180) {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (!tokens.length || compact.length <= limit) return compact.slice(0, limit)

  const lowered = compact.toLowerCase()
  const firstIndex = tokens
    .map((token) => lowered.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]

  if (firstIndex === undefined) return compact.slice(0, limit)

  const start = Math.max(0, firstIndex - Math.floor(limit / 3))
  const excerpt = compact.slice(start, start + limit).trim()
  return start > 0 ? `...${excerpt}` : excerpt
}

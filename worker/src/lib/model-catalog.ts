import { newId } from './ids'

type EnvBindings = {
  DB: D1Database
  OPENROUTER_API_KEY?: string
}

type OpenRouterModel = {
  id: string
  name?: string
  description?: string
  pricing?: {
    prompt?: string
    completion?: string
  }
  context_length?: number
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  supported_parameters?: string[]
}

export type CatalogCategory = 'general' | 'fast' | 'reasoning' | 'coding' | 'vision'

export type CatalogModelRow = {
  provider: string
  modelId: string
  label: string
  tier: string
  category: CatalogCategory
  isFree: boolean
  contextLength: number
  supportsStructuredOutput: boolean
  supportsVision: boolean
  qualityScore: number
  sortScore: number
  source: string
  lastSeenAt: number
}

const CATALOG_TTL_MS = 1000 * 60 * 60 * 12
const FREE_MODEL_FLOOR = 4096

const CAPABILITY_HINTS = {
  coding: [
    'code',
    'coder',
    'coding',
    'programming',
    'developer',
    'software',
    'swe-bench',
    'humaneval',
    'codestral',
    'devstral',
    'qwen3-coder',
  ],
  reasoning: [
    'reason',
    'reasoning',
    'think',
    'thinking',
    'analysis',
    'analytical',
    'logic',
    'math',
    'gsm8k',
    'r1',
    'o1',
    'o3',
    'step by step',
    'problem solving',
  ],
  structured: [
    'json',
    'structured output',
    'structured',
    'extract',
    'extraction',
    'parse',
    'parsing',
    'function calling',
    'tool use',
    'instruct',
    'chat',
  ],
  vision: ['vision', 'visual', 'image', 'multimodal', 'ocr', 'photo', 'picture'],
} as const

const CURATED_FREE_MODEL_BONUSES: Record<string, number> = {
  'openrouter/aurora-alpha': 30,
  'openrouter/pony-alpha': 28,
  'openai/gpt-oss-120b:free': 26,
  'qwen/qwen3-next-80b-a3b-thinking:free': 24,
  'qwen/qwen3-next-80b-a3b-instruct:free': 22,
  'arcee-ai/trinity-large-preview:free': 21,
  'meta-llama/llama-3.3-70b-instruct:free': 18,
  'microsoft/mai-ds-r1:free': 17,
  'deepseek/deepseek-r1-0528:free': 16,
  'google/gemini-2.0-flash-exp:free': 15,
  'google/gemma-3-27b-it:free': 13,
  'mistralai/mistral-small-3.1-24b-instruct:free': 12,
}

function toNumber(value?: string | number | null): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function titleCaseLabel(modelId: string, name?: string): string {
  if (name?.trim()) return name.trim()
  return modelId
    .split('/')
    .pop()
    ?.replace(/[:_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase()) || modelId
}

function countCapabilityMatches(model: OpenRouterModel, hints: readonly string[]): number {
  const haystack = `${model.id} ${model.name || ''} ${model.description || ''}`.toLowerCase()
  return hints.reduce((score, hint) => score + (haystack.includes(hint.toLowerCase()) ? 1 : 0), 0)
}

function isReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return ['thinking', 'reasoning', 'r1', '/o1', '/o3', 'deepseek-r1'].some((token) => lower.includes(token))
}

function isCodingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return ['coder', 'code', 'devstral', 'qwen3-coder'].some((token) => lower.includes(token))
}

function isVisionModel(model: OpenRouterModel): boolean {
  const modalities = [
    ...(model.architecture?.input_modalities || []),
    ...(model.architecture?.output_modalities || []),
    model.architecture?.modality || '',
  ]
  return modalities.some((entry) => entry.toLowerCase().includes('image') || entry.toLowerCase().includes('vision'))
}

function supportsStructuredOutput(model: OpenRouterModel): boolean {
  return (model.supported_parameters || []).some((parameter) =>
    ['response_format', 'json_schema', 'structured_outputs'].includes(parameter)
  )
}

function isFreeModel(model: OpenRouterModel): boolean {
  const prompt = toNumber(model.pricing?.prompt)
  const completion = toNumber(model.pricing?.completion)
  return prompt === 0 && completion === 0
}

function inferCategory(model: OpenRouterModel): CatalogCategory {
  if (isVisionModel(model)) return 'vision'
  if (isCodingModel(model.id)) return 'coding'
  if (isReasoningModel(model.id)) return 'reasoning'

  const lower = model.id.toLowerCase()
  if (lower.includes('flash') || lower.includes('mini') || lower.includes('nano') || lower.includes('small')) {
    return 'fast'
  }

  return 'general'
}

function computeQualityScore(model: OpenRouterModel, category: CatalogCategory): number {
  let score = 50
  const lower = model.id.toLowerCase()
  const contextLength = model.context_length || 0
  const structuredSignals = countCapabilityMatches(model, CAPABILITY_HINTS.structured)
  const reasoningSignals = countCapabilityMatches(model, CAPABILITY_HINTS.reasoning)
  const codingSignals = countCapabilityMatches(model, CAPABILITY_HINTS.coding)
  const visionSignals = countCapabilityMatches(model, CAPABILITY_HINTS.vision)

  if (contextLength >= 128000) score += 12
  else if (contextLength >= 32000) score += 8
  else if (contextLength >= 16000) score += 4

  if (supportsStructuredOutput(model)) score += 14
  if (isVisionModel(model)) score += 4
  if (structuredSignals > 0) score += Math.min(8, structuredSignals * 2)
  if (reasoningSignals > 0) score += Math.min(8, reasoningSignals * 2)
  if (codingSignals > 0 && category === 'coding') score += Math.min(10, codingSignals * 2)
  if (visionSignals > 0) score += Math.min(6, visionSignals * 2)

  if (category === 'general') {
    if (lower.includes('gpt-oss-120b')) score += 18
    if (lower.includes('qwen3-next-80b')) score += 16
    if (lower.includes('trinity-large-preview')) score += 15
    if (lower.includes('glm-4.5-air')) score += 14
    if (lower.includes('llama-3.3-70b')) score += 12
    if (lower.includes('gemma-3n')) score += 8
  }

  if (category === 'fast') {
    if (lower.includes('flash') || lower.includes('nano') || lower.includes('mini')) score += 14
    if (lower.includes('3b') || lower.includes('4b') || lower.includes('8b')) score += 6
  }

  if (category === 'reasoning') {
    if (lower.includes('thinking')) score += 16
    if (lower.includes('120b') || lower.includes('80b') || lower.includes('70b')) score += 10
  }

  if (category === 'coding') {
    if (lower.includes('coder')) score += 18
    if (lower.includes('gpt-oss')) score += 12
  }

  score += CURATED_FREE_MODEL_BONUSES[lower] || 0
  if (lower.includes('preview')) score += 2
  if (lower.includes('alpha')) score += 2
  if (lower.includes('3b') || lower.includes('1b')) score -= 12
  if (lower.includes('7b') || lower.includes('8b')) score -= 8
  if (lower.includes('mini') && category === 'general') score -= 5

  return score
}

function computeSortScore(model: OpenRouterModel, category: CatalogCategory): number {
  let score = computeQualityScore(model, category)
  const lower = model.id.toLowerCase()

  if (model.id.endsWith(':free')) score += 6
  if (lower.startsWith('openai/') || lower.startsWith('qwen/') || lower.startsWith('google/')) score += 4
  if (isReasoningModel(model.id) && category !== 'reasoning') score -= 18

  return score
}

export async function refreshOpenRouterModelCatalog(env: EnvBindings): Promise<{ count: number; updatedAt: number }> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      'HTTP-Referer': 'https://taskcenter.app',
      'X-Title': 'TaskCenter',
      ...(env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`OpenRouter model catalog request failed with ${response.status}`)
  }

  const payload = (await response.json()) as { data?: OpenRouterModel[] }
  const models = (payload.data || []).filter((model) => isFreeModel(model) && (model.context_length || 0) >= FREE_MODEL_FLOOR)
  const now = Date.now()

  await env.DB.prepare(`DELETE FROM ai_model_catalog WHERE provider = 'openrouter'`).run()

  for (const model of models) {
    const category = inferCategory(model)
    const qualityScore = computeQualityScore(model, category)
    const sortScore = computeSortScore(model, category)
    await env.DB.prepare(
      `INSERT INTO ai_model_catalog (
        id, provider, model_id, label, tier, category, is_free, context_length,
        supports_structured_output, supports_vision, quality_score, sort_score,
        source, metadata_json, last_seen_at, updated_at
      ) VALUES (?, 'openrouter', ?, ?, 'free', ?, 1, ?, ?, ?, ?, ?, 'openrouter', ?, ?, ?)`
    )
      .bind(
        newId('mdl'),
        model.id,
        titleCaseLabel(model.id, model.name),
        category,
        model.context_length || 0,
        supportsStructuredOutput(model) ? 1 : 0,
        isVisionModel(model) ? 1 : 0,
        qualityScore,
        sortScore,
        JSON.stringify({
          supportedParameters: model.supported_parameters || [],
          architecture: model.architecture || null,
          pricing: model.pricing || null,
          description: model.description || null,
        }),
        now,
        now
      )
      .run()
  }

  return { count: models.length, updatedAt: now }
}

export async function maybeRefreshOpenRouterModelCatalog(env: EnvBindings): Promise<void> {
  const latest = await env.DB.prepare(
    `SELECT MAX(updated_at) AS updated_at FROM ai_model_catalog WHERE provider = 'openrouter'`
  ).first<{ updated_at: number | null } | null>()

  if (latest?.updated_at && Date.now() - latest.updated_at < CATALOG_TTL_MS) {
    return
  }

  await refreshOpenRouterModelCatalog(env)
}

export async function listCatalogModels(
  env: EnvBindings,
  provider = 'openrouter'
): Promise<{ updatedAt: number | null; models: CatalogModelRow[] }> {
  const rows = await env.DB.prepare(
    `SELECT provider, model_id, label, tier, category, is_free, context_length,
            supports_structured_output, supports_vision, quality_score, sort_score,
            source, last_seen_at
     FROM ai_model_catalog
     WHERE provider = ?
     ORDER BY sort_score DESC, quality_score DESC, model_id ASC`
  )
    .bind(provider)
    .all<{
      provider: string
      model_id: string
      label: string
      tier: string
      category: CatalogCategory
      is_free: number
      context_length: number
      supports_structured_output: number
      supports_vision: number
      quality_score: number
      sort_score: number
      source: string
      last_seen_at: number
    }>()

  return {
    updatedAt: rows.results[0]?.last_seen_at || null,
    models: rows.results.map((row) => ({
      provider: row.provider,
      modelId: row.model_id,
      label: row.label,
      tier: row.tier,
      category: row.category,
      isFree: Boolean(row.is_free),
      contextLength: row.context_length,
      supportsStructuredOutput: Boolean(row.supports_structured_output),
      supportsVision: Boolean(row.supports_vision),
      qualityScore: row.quality_score,
      sortScore: row.sort_score,
      source: row.source,
      lastSeenAt: row.last_seen_at,
    })),
  }
}

export async function getOpenRouterPresetCandidates(
  env: EnvBindings,
  preset: 'best-free' | 'fast-free' | 'reasoning-free'
): Promise<string[]> {
  await maybeRefreshOpenRouterModelCatalog(env)

  const category = preset === 'fast-free' ? 'fast' : preset === 'reasoning-free' ? 'reasoning' : 'general'
  const minContextLength = preset === 'fast-free' ? 8192 : preset === 'reasoning-free' ? 24576 : 32768
  const minQualityScore = preset === 'fast-free' ? 60 : preset === 'reasoning-free' ? 72 : 76
  const preferred = await env.DB.prepare(
    `SELECT model_id
     FROM ai_model_catalog
     WHERE provider = 'openrouter'
       AND is_free = 1
       AND category = ?
       AND context_length >= ?
       AND quality_score >= ?
       AND model_id != 'openrouter/free'
       AND (? = 1 OR supports_vision = 0)
       AND (? = 0 OR supports_structured_output = 1)
       AND (
         ? != 'best-free'
         OR (model_id NOT LIKE '%3b%' AND model_id NOT LIKE '%7b%' AND model_id NOT LIKE '%8b%')
       )
     ORDER BY sort_score DESC, quality_score DESC, context_length DESC
     LIMIT 6`
  )
    .bind(category, minContextLength, minQualityScore, preset === 'fast-free' ? 1 : 0, preset === 'best-free' || preset === 'reasoning-free' ? 1 : 0, preset)
    .all<{ model_id: string }>()

  const backup = await env.DB.prepare(
    `SELECT model_id
     FROM ai_model_catalog
     WHERE provider = 'openrouter'
       AND is_free = 1
       AND context_length >= ?
       AND quality_score >= ?
       AND model_id != 'openrouter/free'
       AND (? = 1 OR supports_vision = 0)
     ORDER BY sort_score DESC, quality_score DESC, context_length DESC
     LIMIT 10`
  )
    .bind(minContextLength, Math.max(54, minQualityScore - 8), preset === 'fast-free' ? 1 : 0)
    .all<{ model_id: string }>()

  return [...new Set([...preferred.results.map((row) => row.model_id), ...backup.results.map((row) => row.model_id)])]
}

export async function resolveAllowedOpenRouterModels(
  env: EnvBindings,
  requestedModel?: string | null
): Promise<string[]> {
  await maybeRefreshOpenRouterModelCatalog(env)

  const normalized = requestedModel?.trim()
  if (!normalized) {
    return getOpenRouterPresetCandidates(env, 'best-free')
  }

  if (normalized === 'best-free' || normalized === 'openrouter/best-free' || normalized === 'openrouter:free' || normalized === 'openrouter:auto' || normalized === 'free' || normalized === 'auto') {
    return getOpenRouterPresetCandidates(env, 'best-free')
  }

  if (normalized === 'fast-free' || normalized === 'openrouter/fast-free' || normalized === 'openrouter:fast-free') {
    return getOpenRouterPresetCandidates(env, 'fast-free')
  }

  if (normalized === 'reasoning-free' || normalized === 'openrouter/reasoning-free' || normalized === 'openrouter:reasoning-free') {
    return getOpenRouterPresetCandidates(env, 'reasoning-free')
  }

  const direct = await env.DB.prepare(
    `SELECT model_id
     FROM ai_model_catalog
     WHERE provider = 'openrouter' AND is_free = 1 AND model_id = ?
     LIMIT 1`
  )
    .bind(normalized)
    .first<{ model_id: string } | null>()

  if (direct?.model_id) {
    const backups = await getOpenRouterPresetCandidates(env, 'best-free')
    return [...new Set([direct.model_id, ...backups])]
  }

  return getOpenRouterPresetCandidates(env, 'best-free')
}

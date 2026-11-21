import { DISPLAY_NAMES } from './formatters.js'

export function safeGroups(account) {
  if (!account || !Array.isArray(account.quotaGroups)) return []
  return account.quotaGroups.filter((g) => g && typeof g === 'object')
}

export function safeBuckets(group) {
  if (!group || !Array.isArray(group.buckets)) return []
  return group.buckets.filter((b) => b && typeof b === 'object')
}

export function findBucket(group, window) {
  const buckets = safeBuckets(group)
  return (
    buckets.find((b) => String(b.window || '').toLowerCase() === window) ||
    buckets.find((b) => {
      const text = `${b.bucketId || ''} ${b.displayName || ''}`.toLowerCase()
      return window === 'weekly'
        ? text.includes('weekly')
        : text.includes('5h') || text.includes('five')
    })
  )
}

export function isArgonModelId(id) {
  const lower = String(id || '').trim().toLowerCase()
  return lower.startsWith('gemini-4-argon') && !lower.includes('disabled')
}

export function isMainGeminiModelId(id) {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.includes('gemini') || lower.includes('disabled')) return false
  if (lower.startsWith('gemini-4-argon')) return false
  return true
}

export function isGemini4CoreModelId(id) {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.startsWith('gemini-4-') || lower.includes('disabled')) return false
  // gemini-4-argon-* has an independent quota bucket on Pro plans.
  if (lower.includes('sonar') || lower.startsWith('gemini-4-argon')) return false
  return true
}

export function isThirdPartyModel(id) {
  const v = String(id || '').toLowerCase()
  return v.startsWith('claude') || v.startsWith('gpt') || v.startsWith('openai')
}

export function supportsGemini4(account) {
  if (!account || typeof account !== 'object') return false
  const hintIds = account?.capabilityHints?.model_ids
  if (Array.isArray(hintIds) && hintIds.length > 0) {
    return hintIds.some((id) => isGemini4CoreModelId(id))
  }
  const models = Array.isArray(account.models) ? account.models : []
  return models.some((m) => isGemini4CoreModelId(m?.model || m?.modelId || ''))
}

export function classifyGroup(group) {
  if (!group || typeof group !== 'object') return 'other'
  const name = String(group.displayName || '').toLowerCase()
  const buckets = safeBuckets(group)
  const hasArgonBucket = buckets.some((b) =>
    /argon/i.test(`${b.bucketId || ''} ${b.displayName || ''}`)
  )
  // Match Argon before generic Gemini because "Gemini 4 Argon" contains "gemini".
  if (name.includes('argon') || hasArgonBucket) return 'argon'

  const hasGeminiBucket = buckets.some((b) => /^gemini[-_]/i.test(String(b.bucketId || '')))
  if (name.includes('gemini') || hasGeminiBucket) return 'gemini'

  const hasThirdPartyBucket = buckets.some((b) => /^3p[-_]/i.test(String(b.bucketId || '')))
  if (
    name.includes('claude') ||
    name.includes('gpt') ||
    name.includes('third') ||
    hasThirdPartyBucket
  ) {
    return 'third-party'
  }
  return 'other'
}

export function shouldFallbackArgonFromModels(account) {
  const models = Array.isArray(account?.models) ? account.models : []
  const argonModels = models.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      isArgonModelId(m.model || m.modelId || '') &&
      typeof m.remainingFraction === 'number' &&
      Number.isFinite(m.remainingFraction)
  )
  if (!argonModels.length) return false

  const groups = safeGroups(account)
  if (!groups.length) return true
  if (groups.some((g) => classifyGroup(g) === 'argon')) return false

  const geminiGroup = groups.find((g) => classifyGroup(g) === 'gemini')
  const desc = String(geminiGroup?.description || '').toLowerCase()
  if (desc.includes('argon')) return false
  // Legacy desktop-UA snapshots omit the Argon group and only list "Gemini 3.8 Flash".
  if (!desc.includes('gemini 4')) return true

  const mainGeminiModels = models.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      isMainGeminiModelId(m.model || m.modelId || '') &&
      typeof m.remainingFraction === 'number' &&
      Number.isFinite(m.remainingFraction)
  )
  if (!mainGeminiModels.length) return true

  let argonMin = null
  let argonReset = null
  for (const m of argonModels) {
    const f = Math.max(0, Math.min(1, m.remainingFraction))
    argonMin = argonMin == null ? f : Math.min(argonMin, f)
    const ms = m.resetTime ? Date.parse(m.resetTime) : NaN
    if (Number.isFinite(ms)) argonReset = argonReset == null ? ms : Math.min(argonReset, ms)
  }

  let mainMin = null
  let mainReset = null
  for (const m of mainGeminiModels) {
    const f = Math.max(0, Math.min(1, m.remainingFraction))
    mainMin = mainMin == null ? f : Math.min(mainMin, f)
    const ms = m.resetTime ? Date.parse(m.resetTime) : NaN
    if (Number.isFinite(ms)) mainReset = mainReset == null ? ms : Math.min(mainReset, ms)
  }

  if (argonMin != null && mainMin != null && Math.abs(argonMin - mainMin) > 0.01) return true
  if (argonReset != null && mainReset != null && Math.abs(argonReset - mainReset) > 120_000) {
    return true
  }
  return false
}

export function capabilityTags(account) {
  const ids = account?.capabilityHints?.model_ids
  if (!Array.isArray(ids) || !ids.length) return []
  const enabled = ids
    .map((id) => String(id || '').toLowerCase())
    .filter((id) => id && !id.includes('disabled'))
  const tags = []
  if (enabled.some((id) => id.startsWith('gemini-4-neon'))) tags.push({ text: 'Neon', accent: true })
  if (enabled.some((id) => id.startsWith('gemini-4-hydrogen') && !id.includes('sonar'))) {
    tags.push({ text: 'Hydrogen', accent: true })
  }
  if (enabled.some((id) => id.startsWith('gemini-4-argon'))) {
    tags.push({ text: 'Argon', accent: true })
  }
  if (enabled.some((id) => id.startsWith('gemini-3.8-flash'))) {
    tags.push({ text: '3.8 Flash', accent: false })
  }
  if (enabled.some((id) => id.startsWith('claude-opus-5-5') || id.startsWith('claude-sonnet-5-5'))) {
    tags.push({ text: 'Claude 5.5', accent: false })
  }
  return tags
}

function baseModelId(id) {
  return String(id || '')
    .replace(/-tiered-(high|xhigh)$/i, '')
    .replace(/-(high|medium|low|xhigh|tiered)$/i, '')
}

function prettyModel(id) {
  if (DISPLAY_NAMES[id]) return DISPLAY_NAMES[id]
  return String(id || '')
    .split('-')
    .map((part) => {
      if (part.toLowerCase() === 'gpt') return 'GPT'
      if (part.toLowerCase() === 'oss') return 'OSS'
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : part
    })
    .join(' ')
}

function modelRank(id) {
  const value = String(id || '')
  if (value.startsWith('gemini-4-neon')) return 0
  if (value.startsWith('gemini-4-hydrogen') && !value.includes('sonar')) return 1
  if (value.startsWith('gemini-4-argon')) return 2
  if (value.includes('sonar')) return 3
  if (value.startsWith('gemini-3.8')) return 4
  if (value.startsWith('gemini-3.5')) return 5
  if (value.startsWith('gemini-3.1')) return 6
  if (value.startsWith('gemini-3-flash')) return 7
  if (value.startsWith('gemini-2.5-pro')) return 8
  if (value.startsWith('gemini-2.5')) return 9
  if (value.startsWith('claude-opus')) return 12
  if (value.startsWith('claude-sonnet')) return 13
  if (value.startsWith('claude')) return 14
  if (value.startsWith('gpt')) return 20
  return 10
}

export function groupModels(models) {
  const map = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model !== 'object') continue
    const rawId = model.model || model.modelId
    if (typeof rawId !== 'string' || !rawId) continue
    const id = baseModelId(rawId)
    let entry = map.get(id)
    if (!entry) {
      entry = { id, remaining: null, reset: null, resetLocal: null, variants: [] }
      map.set(id, entry)
    }
    entry.variants.push(rawId)
    if (typeof model.remainingFraction === 'number' && Number.isFinite(model.remainingFraction)) {
      entry.remaining =
        entry.remaining == null
          ? model.remainingFraction
          : Math.min(entry.remaining, model.remainingFraction)
    }
    const resetMs = model.resetTime ? Date.parse(model.resetTime) : NaN
    if (Number.isFinite(resetMs) && (entry.reset == null || resetMs < entry.reset)) {
      entry.reset = resetMs
      entry.resetLocal = typeof model.resetTimeLocal === 'string' ? model.resetTimeLocal : null
    }
  }
  return [...map.values()]
    .map((item) => ({
      id: item.id,
      name: prettyModel(item.id),
      argon: isArgonModelId(item.id),
      thirdParty: isThirdPartyModel(item.id),
      percent: item.remaining == null ? null : Math.max(0, Math.min(100, item.remaining * 100)),
      reset: item.reset,
      resetLocal: item.resetLocal,
      variants: item.variants
    }))
    .sort((a, b) => modelRank(a.id) - modelRank(b.id) || a.name.localeCompare(b.name))
}

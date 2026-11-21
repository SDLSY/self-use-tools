import type { QuotaAccount, QuotaBucket, QuotaGroup, QuotaSnapshot } from './protocol'
import { clampFraction } from './snapshot-sanitizer'

export type GroupKind = 'gemini' | 'argon' | 'third-party' | 'other'

export type PoolStats = {
  geminiAvg: number | null
  gemini5hAvg: number | null
  geminiWeeklyAvg: number | null
  gemini5hLowest: number | null
  geminiWeeklyLowest: number | null
  geminiLowest: number | null
  geminiEligibleCount: number
  geminiExcludedCount: number
  argonAvg: number | null
  argonWeeklyAvg: number | null
  argonLowest: number | null
  argonAccountCount: number
  thirdPartyAvg: number | null
  thirdParty5hAvg: number | null
  thirdPartyWeeklyAvg: number | null
}

export function minVal(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
}

function avgVal(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((acc, v) => acc + v, 0) / values.length
}

function bucketWindow(bucket: QuotaBucket): 'weekly' | '5h' | 'other' {
  const win = (bucket.window || '').toLowerCase()
  if (win === 'weekly') return 'weekly'
  if (win === '5h') return '5h'
  const text = `${bucket.bucketId || ''} ${bucket.displayName || ''}`.toLowerCase()
  if (text.includes('weekly')) return 'weekly'
  if (text.includes('5h') || text.includes('five')) return '5h'
  return 'other'
}

export function isArgonModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  return lower.startsWith('gemini-4-argon') && !lower.includes('disabled')
}

export function isMainGeminiModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.includes('gemini') || lower.includes('disabled')) return false
  // gemini-4-argon-* has an independent quota bucket on Pro plans.
  if (lower.startsWith('gemini-4-argon')) return false
  return true
}

export function isGemini4CoreModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.startsWith('gemini-4-') || lower.includes('disabled')) return false
  // gemini-4-hydrogen-sonar remains enabled on accounts without core Gemini-4 models.
  if (lower.includes('sonar') || lower.startsWith('gemini-4-argon')) return false
  return true
}

export function supportsGemini4(account: QuotaAccount | null | undefined): boolean {
  if (!account) return false
  const hintIds = account.capabilityHints?.model_ids
  if (Array.isArray(hintIds) && hintIds.length > 0) {
    return hintIds.some((id) => isGemini4CoreModelId(id))
  }
  const models = Array.isArray(account.models) ? account.models : []
  return models.some((m) => isGemini4CoreModelId(m.model || m.modelId || ''))
}

function isThirdPartyModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  return lower.startsWith('claude') || lower.startsWith('gpt') || lower.startsWith('openai')
}

export function classifyGroup(group: QuotaGroup | null | undefined): GroupKind {
  if (!group) return 'other'
  const name = String(group.displayName || '').toLowerCase()
  const buckets = Array.isArray(group.buckets) ? group.buckets : []
  const hasArgonBucket = buckets.some((b) =>
    /argon/i.test(`${b?.bucketId || ''} ${b?.displayName || ''}`)
  )
  // Match Argon before generic Gemini because "Gemini 4 Argon" contains "gemini".
  if (name.includes('argon') || hasArgonBucket) return 'argon'

  const hasGeminiBucket = buckets.some((b) => /^gemini[-_]/i.test(String(b?.bucketId || '')))
  if (name.includes('gemini') || hasGeminiBucket) return 'gemini'

  const hasThirdPartyBucket = buckets.some((b) => /^3p[-_]/i.test(String(b?.bucketId || '')))
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

function shouldFallbackArgonFromModels(account: QuotaAccount): boolean {
  const models = Array.isArray(account.models) ? account.models : []
  const argonModels = models.filter(
    (m) => m && isArgonModelId(m.model || m.modelId || '') && clampFraction(m.remainingFraction) != null
  )
  if (argonModels.length === 0) return false

  const groups = Array.isArray(account.quotaGroups) ? account.quotaGroups : []
  if (groups.length === 0) return true
  if (groups.some((g) => classifyGroup(g) === 'argon')) return false

  const geminiGroup = groups.find((g) => classifyGroup(g) === 'gemini')
  const desc = String(geminiGroup?.description || '').toLowerCase()
  if (desc.includes('argon')) return false
  // Legacy desktop-UA snapshots omit the Argon group and only list "Gemini 3.8 Flash" in Gemini Models.
  if (!desc.includes('gemini 4')) return true

  const mainGeminiModels = models.filter(
    (m) =>
      m &&
      isMainGeminiModelId(m.model || m.modelId || '') &&
      clampFraction(m.remainingFraction) != null
  )
  if (mainGeminiModels.length === 0) return true

  let argonMin: number | null = null
  let argonReset: number | null = null
  for (const m of argonModels) {
    const f = clampFraction(m.remainingFraction)
    if (f != null) argonMin = minVal(argonMin, f)
    const ms = m.resetTime ? Date.parse(m.resetTime) : NaN
    if (Number.isFinite(ms)) argonReset = minVal(argonReset, ms)
  }

  let mainMin: number | null = null
  let mainReset: number | null = null
  for (const m of mainGeminiModels) {
    const f = clampFraction(m.remainingFraction)
    if (f != null) mainMin = minVal(mainMin, f)
    const ms = m.resetTime ? Date.parse(m.resetTime) : NaN
    if (Number.isFinite(ms)) mainReset = minVal(mainReset, ms)
  }

  if (argonMin != null && mainMin != null && Math.abs(argonMin - mainMin) > 0.01) return true
  if (argonReset != null && mainReset != null && Math.abs(argonReset - mainReset) > 120_000) {
    return true
  }
  return false
}

export function computePoolStats(snapshot: QuotaSnapshot): PoolStats {
  const geminiAccountValues: number[] = []
  const gemini5hValues: number[] = []
  const geminiWeeklyValues: number[] = []
  const argonAccountValues: number[] = []
  const argonWeeklyValues: number[] = []
  const thirdPartyAccountValues: number[] = []
  const thirdParty5hValues: number[] = []
  const thirdPartyWeeklyValues: number[] = []
  let geminiLowest: number | null = null
  let gemini5hLowest: number | null = null
  let geminiWeeklyLowest: number | null = null
  let geminiEligibleCount = 0
  let geminiExcludedCount = 0
  let argonLowest: number | null = null

  for (const account of snapshot.accounts || []) {
    if (!account || account.status !== 'ok') continue

    const g4Capable = supportsGemini4(account)
    if (g4Capable) geminiEligibleCount += 1
    else geminiExcludedCount += 1

    let acctGemini: number | null = null
    let acctGemini5h: number | null = null
    let acctGeminiWeekly: number | null = null
    let acctArgon: number | null = null
    let acctArgonWeekly: number | null = null
    let acctThirdParty: number | null = null
    let acctThirdParty5h: number | null = null
    let acctThirdPartyWeekly: number | null = null

    for (const group of account.quotaGroups || []) {
      if (!group) continue
      const kind = classifyGroup(group)
      if (kind === 'other') continue
      for (const bucket of group.buckets || []) {
        if (!bucket) continue
        const fraction = clampFraction(bucket.remainingFraction)
        if (fraction == null) continue
        const pct = fraction * 100
        const win = bucketWindow(bucket)
        if (kind === 'gemini') {
          if (!g4Capable) continue
          acctGemini = minVal(acctGemini, pct)
          if (win === '5h') acctGemini5h = minVal(acctGemini5h, pct)
          else if (win === 'weekly') acctGeminiWeekly = minVal(acctGeminiWeekly, pct)
        } else if (kind === 'argon') {
          acctArgon = minVal(acctArgon, pct)
          if (win === 'weekly' || win === 'other') acctArgonWeekly = minVal(acctArgonWeekly, pct)
        } else if (kind === 'third-party') {
          acctThirdParty = minVal(acctThirdParty, pct)
          if (win === '5h') acctThirdParty5h = minVal(acctThirdParty5h, pct)
          else if (win === 'weekly') acctThirdPartyWeekly = minVal(acctThirdPartyWeekly, pct)
        }
      }
    }

    const needGeminiFallback = g4Capable && acctGemini == null
    const needArgonFallback = acctArgon == null && shouldFallbackArgonFromModels(account)
    const needThirdPartyFallback = acctThirdParty == null
    if (needGeminiFallback || needArgonFallback || needThirdPartyFallback) {
      for (const model of account.models || []) {
        if (!model) continue
        const id = model.model || model.modelId || ''
        if (!id) continue
        const fraction = clampFraction(model.remainingFraction)
        if (fraction == null) continue
        const pct = fraction * 100
        if (needArgonFallback && isArgonModelId(id)) {
          acctArgon = minVal(acctArgon, pct)
          acctArgonWeekly = minVal(acctArgonWeekly, pct)
        } else if (needGeminiFallback && isMainGeminiModelId(id)) {
          acctGemini = minVal(acctGemini, pct)
        } else if (needThirdPartyFallback && isThirdPartyModelId(id)) {
          acctThirdParty = minVal(acctThirdParty, pct)
        }
      }
    }

    if (g4Capable) {
      if (acctGemini != null) {
        geminiAccountValues.push(acctGemini)
        geminiLowest = minVal(geminiLowest, acctGemini)
      }
      if (acctGemini5h != null) {
        gemini5hValues.push(acctGemini5h)
        gemini5hLowest = minVal(gemini5hLowest, acctGemini5h)
      }
      if (acctGeminiWeekly != null) {
        geminiWeeklyValues.push(acctGeminiWeekly)
        geminiWeeklyLowest = minVal(geminiWeeklyLowest, acctGeminiWeekly)
      }
    }
    if (acctArgon != null) {
      argonAccountValues.push(acctArgon)
      argonLowest = minVal(argonLowest, acctArgon)
    }
    if (acctArgonWeekly != null) argonWeeklyValues.push(acctArgonWeekly)
    if (acctThirdParty != null) thirdPartyAccountValues.push(acctThirdParty)
    if (acctThirdParty5h != null) thirdParty5hValues.push(acctThirdParty5h)
    if (acctThirdPartyWeekly != null) thirdPartyWeeklyValues.push(acctThirdPartyWeekly)
  }

  return {
    geminiAvg: avgVal(geminiAccountValues),
    gemini5hAvg: avgVal(gemini5hValues),
    geminiWeeklyAvg: avgVal(geminiWeeklyValues),
    gemini5hLowest,
    geminiWeeklyLowest,
    geminiLowest,
    geminiEligibleCount,
    geminiExcludedCount,
    argonAvg: avgVal(argonAccountValues),
    argonWeeklyAvg: avgVal(argonWeeklyValues),
    argonLowest,
    argonAccountCount: argonAccountValues.length,
    thirdPartyAvg: avgVal(thirdPartyAccountValues),
    thirdParty5hAvg: avgVal(thirdParty5hValues),
    thirdPartyWeeklyAvg: avgVal(thirdPartyWeeklyValues)
  }
}

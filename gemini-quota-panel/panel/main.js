const api = window.orca
const app = document.getElementById('app')
const tooltipEl = document.getElementById('tooltip')

const state = {
  snapshot: null,
  settings: {},
  loading: true,
  refreshing: false,
  error: null,
  selectedAccount: 'all',
  expanded: {}
}

const DISPLAY_NAMES = {
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-4-hydrogen-sonar': 'Gemini 4 Hydrogen Sonar',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash Image',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
  'gemini-2.5-flash-thinking': 'Gemini 2.5 Flash Thinking',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gpt-oss-120b': 'GPT-OSS 120B'
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function sparkleSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="url(#gemini-gradient)" d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z"/></svg>'
}

function layersSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/></svg>'
}

function refreshSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>'
}

function chevronSvg() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 4 10 8 6 12"/></svg>'
}

function getThresholds() {
  const warn = Number(state.settings?.warnBelow)
  const danger = Number(state.settings?.dangerBelow)
  return {
    warn: Number.isFinite(warn) ? warn : 20,
    danger: Number.isFinite(danger) ? danger : 5
  }
}

function toneForPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const { warn, danger } = getThresholds()
  if (value < danger) return 'danger'
  if (value < warn) return 'warning'
  return ''
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

function systemOffsetMinutes() {
  const snap = state.snapshot
  if (snap?.generatedAt && snap?.collectedAtLocal) {
    const utcMs = Date.parse(snap.generatedAt)
    const m = String(snap.collectedAtLocal).match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/
    )
    if (Number.isFinite(utcMs) && m) {
      const localAsUtc = Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] || 0)
      )
      const diffMin = Math.round((localAsUtc - utcMs) / 60000 / 15) * 15
      if (Number.isFinite(diffMin) && Math.abs(diffMin) <= 840) return diffMin
    }
  }
  return -new Date().getTimezoneOffset()
}

function formatLocalDateTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const shifted = new Date(ms + systemOffsetMinutes() * 60000)
  if (Number.isNaN(shifted.getTime())) return ''
  return `${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日 ${String(
    shifted.getUTCHours()
  ).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}

function resetsInText(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const diff = ms - Date.now()
  if (diff <= 0) return '即将重置'
  const minutes = Math.floor(diff / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${days}d ${hours}h 后重置`
  if (hours > 0) return `${hours}h ${rest}m 后重置`
  return `${Math.max(1, rest)}m 后重置`
}

function safeGroups(account) {
  if (!account || !Array.isArray(account.quotaGroups)) return []
  return account.quotaGroups.filter((g) => g && typeof g === 'object')
}

function safeBuckets(group) {
  if (!group || !Array.isArray(group.buckets)) return []
  return group.buckets.filter((b) => b && typeof b === 'object')
}

function findBucket(group, window) {
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

function isArgonModelId(id) {
  const lower = String(id || '').trim().toLowerCase()
  return lower.startsWith('gemini-4-argon') && !lower.includes('disabled')
}

function isMainGeminiModelId(id) {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.includes('gemini')) return false
  if (lower.includes('disabled')) return false
  if (lower.startsWith('gemini-4-argon')) return false
  return true
}

function isGemini4CoreModelId(id) {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.startsWith('gemini-4-')) return false
  if (lower.includes('disabled')) return false
  if (lower.includes('sonar')) return false
  // gemini-4-argon-* has an independent quota bucket on Pro plans
  if (lower.startsWith('gemini-4-argon')) return false
  return true
}

function supportsGemini4(account) {
  if (!account || typeof account !== 'object') return false
  const hintIds = account?.capabilityHints?.model_ids
  if (Array.isArray(hintIds) && hintIds.length > 0) {
    return hintIds.some((id) => isGemini4CoreModelId(id))
  }
  const models = Array.isArray(account.models) ? account.models : []
  if (models.length > 0) {
    return models.some((m) => isGemini4CoreModelId(m?.model || m?.modelId || ''))
  }
  return false
}

function classifyGroup(group) {
  if (!group || typeof group !== 'object') return 'other'
  const name = String(group.displayName || '').toLowerCase()
  const buckets = safeBuckets(group)
  const hasArgonBucket = buckets.some((b) =>
    /argon/i.test(`${b.bucketId || ''} ${b.displayName || ''}`)
  )
  // Match Argon before generic Gemini because "Gemini 4 Argon" contains "gemini"
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

function shouldFallbackArgonFromModels(account) {
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
  // Legacy desktop-UA snapshots omit the Argon group and only list "Gemini 3.8 Flash"
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
  if (argonReset != null && mainReset != null && Math.abs(argonReset - mainReset) > 120_000) return true
  return false
}

function accountArgonBreakdown(account) {
  let weekly = null
  let overall = null
  let reset = null
  let hasExplicitGroup = false
  let description = null

  for (const group of safeGroups(account)) {
    if (classifyGroup(group) !== 'argon') continue
    hasExplicitGroup = true
    if (!description && group.description) description = group.description
    const w = findBucket(group, 'weekly')
    if (w && typeof w.remainingFraction === 'number' && Number.isFinite(w.remainingFraction)) {
      const pct = Math.max(0, Math.min(100, w.remainingFraction * 100))
      weekly = weekly == null ? pct : Math.min(weekly, pct)
      overall = overall == null ? pct : Math.min(overall, pct)
      if (w.resetTime) {
        const ms = Date.parse(w.resetTime)
        if (Number.isFinite(ms) && (reset == null || ms < reset.ms)) {
          reset = { ms, iso: w.resetTime }
        }
      }
    }
    for (const bucket of safeBuckets(group)) {
      if (bucket === w) continue
      if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction))
        continue
      const pct = Math.max(0, Math.min(100, bucket.remainingFraction * 100))
      overall = overall == null ? pct : Math.min(overall, pct)
      if (weekly == null) weekly = pct
      if (bucket.resetTime) {
        const ms = Date.parse(bucket.resetTime)
        if (Number.isFinite(ms) && (reset == null || ms < reset.ms)) {
          reset = { ms, iso: bucket.resetTime }
        }
      }
    }
  }

  if (overall == null && shouldFallbackArgonFromModels(account)) {
    for (const model of Array.isArray(account?.models) ? account.models : []) {
      if (!model || typeof model !== 'object') continue
      const id = model.model || model.modelId
      if (!isArgonModelId(id)) continue
      if (typeof model.remainingFraction !== 'number' || !Number.isFinite(model.remainingFraction))
        continue
      const pct = Math.max(0, Math.min(100, model.remainingFraction * 100))
      weekly = weekly == null ? pct : Math.min(weekly, pct)
      overall = overall == null ? pct : Math.min(overall, pct)
      if (model.resetTime) {
        const ms = Date.parse(model.resetTime)
        if (Number.isFinite(ms) && (reset == null || ms < reset.ms)) {
          reset = { ms, iso: model.resetTime }
        }
      }
    }
  }

  return { weekly, overall, reset, hasExplicitGroup, description }
}

function accountThirdPartyPercent(account) {
  let lowest = null
  for (const group of safeGroups(account)) {
    if (classifyGroup(group) !== 'third-party') continue
    for (const bucket of safeBuckets(group)) {
      if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction))
        continue
      const pct = Math.max(0, Math.min(100, bucket.remainingFraction * 100))
      lowest = lowest == null ? pct : Math.min(lowest, pct)
    }
  }
  if (lowest != null) return lowest
  for (const model of Array.isArray(account?.models) ? account.models : []) {
    if (!model || typeof model !== 'object') continue
    const id = model.model || model.modelId
    if (!isThirdPartyModel(id)) continue
    if (typeof model.remainingFraction !== 'number' || !Number.isFinite(model.remainingFraction))
      continue
    const pct = Math.max(0, Math.min(100, model.remainingFraction * 100))
    lowest = lowest == null ? pct : Math.min(lowest, pct)
  }
  return lowest
}

function accountGeminiBreakdown(account) {
  let fiveHour = null
  let weekly = null
  let overall = null
  let fiveHourReset = null
  let weeklyReset = null

  for (const group of safeGroups(account)) {
    if (classifyGroup(group) !== 'gemini') continue
    const f = findBucket(group, '5h')
    const w = findBucket(group, 'weekly')
    if (f && typeof f.remainingFraction === 'number' && Number.isFinite(f.remainingFraction)) {
      const pct = Math.max(0, Math.min(100, f.remainingFraction * 100))
      fiveHour = fiveHour == null ? pct : Math.min(fiveHour, pct)
      overall = overall == null ? pct : Math.min(overall, pct)
      if (f.resetTime) {
        const ms = Date.parse(f.resetTime)
        if (Number.isFinite(ms) && (fiveHourReset == null || ms < fiveHourReset.ms)) {
          fiveHourReset = { ms, iso: f.resetTime }
        }
      }
    }
    if (w && typeof w.remainingFraction === 'number' && Number.isFinite(w.remainingFraction)) {
      const pct = Math.max(0, Math.min(100, w.remainingFraction * 100))
      weekly = weekly == null ? pct : Math.min(weekly, pct)
      overall = overall == null ? pct : Math.min(overall, pct)
      if (w.resetTime) {
        const ms = Date.parse(w.resetTime)
        if (Number.isFinite(ms) && (weeklyReset == null || ms < weeklyReset.ms)) {
          weeklyReset = { ms, iso: w.resetTime }
        }
      }
    }
    for (const bucket of safeBuckets(group)) {
      if (bucket === f || bucket === w) continue
      if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction))
        continue
      const pct = Math.max(0, Math.min(100, bucket.remainingFraction * 100))
      overall = overall == null ? pct : Math.min(overall, pct)
    }
  }

  if (overall == null) {
    for (const model of Array.isArray(account?.models) ? account.models : []) {
      if (!model || typeof model !== 'object') continue
      const id = model.model || model.modelId
      if (!isMainGeminiModelId(id)) continue
      if (typeof model.remainingFraction !== 'number' || !Number.isFinite(model.remainingFraction))
        continue
      const pct = Math.max(0, Math.min(100, model.remainingFraction * 100))
      overall = overall == null ? pct : Math.min(overall, pct)
    }
  }

  return { fiveHour, weekly, overall, fiveHourReset, weeklyReset }
}

function accountGeminiPercent(account) {
  return accountGeminiBreakdown(account).overall
}

function sortAccounts(accounts) {
  const rank = (account) => {
    if (account.status === 'ok') {
      if (supportsGemini4(account)) return 0
      if (accountArgonBreakdown(account).overall != null) return 1
      return 2
    }
    if (account.status === 'error') return 3
    return 4
  }
  return [...accounts].filter(Boolean).sort((a, b) => {
    const diff = rank(a) - rank(b)
    if (diff !== 0) return diff
    return String(a.label || a.account || '').localeCompare(String(b.label || b.account || ''))
  })
}

function capabilityTags(account) {
  const ids = account?.capabilityHints?.model_ids
  if (!Array.isArray(ids) || !ids.length) return []
  const enabled = ids
    .map((id) => String(id || '').toLowerCase())
    .filter((id) => id && !id.includes('disabled'))
  const tags = []
  if (enabled.some((id) => id.startsWith('gemini-4-neon'))) tags.push({ text: 'Neon', accent: true })
  if (enabled.some((id) => id.startsWith('gemini-4-hydrogen') && !id.includes('sonar')))
    tags.push({ text: 'Hydrogen', accent: true })
  if (enabled.some((id) => id.startsWith('gemini-4-argon')))
    tags.push({ text: 'Argon', accent: true })
  if (enabled.some((id) => id.startsWith('gemini-3.8-flash')))
    tags.push({ text: '3.8 Flash', accent: false })
  if (enabled.some((id) => id.startsWith('claude-opus-5-5') || id.startsWith('claude-sonnet-5-5')))
    tags.push({ text: 'Claude 5.5', accent: false })
  return tags
}

function localizeReason(account) {
  const raw = String(account?.reason || account?.error || '').trim()
  if (!raw) return account?.status === 'skipped' ? '该账号当前已跳过。' : '查询失败。'

  const expiredMatch = raw.match(/access token expired at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*UTC/i)
  if (expiredMatch) {
    const iso = `${expiredMatch[1].replace(' ', 'T')}:00Z`
    const local = formatLocalDateTime(iso)
    return `Token 已于 ${local || expiredMatch[1] + ' UTC'} 过期，等待 CPA 使用时自动刷新`
  }
  if (/disabled in auth file/i.test(raw)) {
    return '已在 CPA 认证配置中禁用'
  }
  if (/no access_token/i.test(raw)) {
    return '认证文件缺少 access_token'
  }
  return raw
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

function isThirdPartyModel(id) {
  const v = String(id || '').toLowerCase()
  return v.startsWith('claude') || v.startsWith('gpt') || v.startsWith('openai')
}

function groupModels(models) {
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

function avgValues(values) {
  if (!values.length) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function computePoolTile(accounts, kind) {
  let minAll = null
  let min5h = null
  let minWeekly = null
  const acctAllValues = []
  const acct5hValues = []
  const acctWeeklyValues = []
  let earliest5hReset = null
  let earliestWeeklyReset = null

  for (const account of accounts) {
    if (!account || account.status !== 'ok') continue
    let acctAll = null
    let acct5h = null
    let acctWeekly = null

    for (const group of safeGroups(account)) {
      if (classifyGroup(group) !== kind) continue
      const w = findBucket(group, 'weekly')
      const f = findBucket(group, '5h')
      if (w && typeof w.remainingFraction === 'number' && Number.isFinite(w.remainingFraction)) {
        const pct = Math.max(0, Math.min(100, w.remainingFraction * 100))
        acctWeekly = acctWeekly == null ? pct : Math.min(acctWeekly, pct)
        acctAll = acctAll == null ? pct : Math.min(acctAll, pct)
      }
      if (f && typeof f.remainingFraction === 'number' && Number.isFinite(f.remainingFraction)) {
        const pct = Math.max(0, Math.min(100, f.remainingFraction * 100))
        acct5h = acct5h == null ? pct : Math.min(acct5h, pct)
        acctAll = acctAll == null ? pct : Math.min(acctAll, pct)
      }
      for (const b of safeBuckets(group)) {
        if (b === w || b === f) continue
        if (typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)) {
          const pct = Math.max(0, Math.min(100, b.remainingFraction * 100))
          acctAll = acctAll == null ? pct : Math.min(acctAll, pct)
          if (kind === 'argon' && acctWeekly == null) acctWeekly = pct
        }
      }
      if (f?.resetTime) {
        const ms = Date.parse(f.resetTime)
        if (Number.isFinite(ms) && (earliest5hReset == null || ms < earliest5hReset.ms)) {
          earliest5hReset = { ms, iso: f.resetTime }
        }
      }
      if (w?.resetTime) {
        const ms = Date.parse(w.resetTime)
        if (Number.isFinite(ms) && (earliestWeeklyReset == null || ms < earliestWeeklyReset.ms)) {
          earliestWeeklyReset = { ms, iso: w.resetTime }
        }
      }
    }

    if (acctAll == null) {
      if (kind === 'gemini') {
        acctAll = accountGeminiPercent(account)
      } else if (kind === 'argon') {
        const ab = accountArgonBreakdown(account)
        acctAll = ab.overall
        acctWeekly = ab.weekly
        if (ab.reset && (earliestWeeklyReset == null || ab.reset.ms < earliestWeeklyReset.ms)) {
          earliestWeeklyReset = ab.reset
        }
      } else if (kind === 'third-party') {
        acctAll = accountThirdPartyPercent(account)
      }
    }

    if (acctAll != null) {
      acctAllValues.push(acctAll)
      minAll = minAll == null ? acctAll : Math.min(minAll, acctAll)
    }
    if (acct5h != null) {
      acct5hValues.push(acct5h)
      min5h = min5h == null ? acct5h : Math.min(min5h, acct5h)
    }
    if (acctWeekly != null) {
      acctWeeklyValues.push(acctWeekly)
      minWeekly = minWeekly == null ? acctWeekly : Math.min(minWeekly, acctWeekly)
    }
  }

  return {
    avgAll: avgValues(acctAllValues),
    avg5h: avgValues(acct5hValues),
    avgWeekly: avgValues(acctWeeklyValues),
    minAll,
    min5h,
    minWeekly,
    accountCount: acctAllValues.length,
    earliest5hReset,
    earliestWeeklyReset
  }
}

function poolOverviewHtml(accounts) {
  const okAccounts = accounts.filter((a) => a && a.status === 'ok')
  if (state.selectedAccount !== 'all' || okAccounts.length === 0) return ''

  const g4Accounts = okAccounts.filter((a) => supportsGemini4(a))
  const excludedAccounts = okAccounts.filter((a) => !supportsGemini4(a))
  const gemini = computePoolTile(g4Accounts, 'gemini')
  const argon = computePoolTile(okAccounts, 'argon')
  const third = computePoolTile(okAccounts, 'third-party')

  const excludedNames = excludedAccounts
    .map((a) => a.label || a.account.split('@')[0])
    .join('、')

  const windowTile = (title, pct, minPct, resetObj, perAccountLines) => {
    const tone = toneForPercent(pct)
    const width = pct == null ? 0 : Math.max(0, Math.min(100, pct))
    const tipLines = [
      `Gemini 4 主池 · ${title}（${g4Accounts.length} 个支持 G4 账号平均）`,
      `平均剩余：${formatPercent(pct)}`
    ]
    if (minPct != null && g4Accounts.length > 1) {
      tipLines.push(`最低账号：${formatPercent(minPct)}`)
    }
    if (resetObj) {
      tipLines.push(`最近重置：${formatLocalDateTime(resetObj.ms)}`)
    }
    if (perAccountLines.length) {
      tipLines.push(...perAccountLines)
    }
    if (excludedAccounts.length > 0) {
      tipLines.push(`已排除无 G4 账号：${excludedNames}`)
    }

    const resetHtml = resetObj
      ? `<span class="reset-relative" data-reset-iso="${escapeHtml(resetObj.iso)}">${escapeHtml(
          resetsInText(resetObj.iso)
        )}</span>`
      : '—'
    const lowText =
      minPct != null && g4Accounts.length > 1 ? `最低 ${formatPercent(minPct)}` : `${g4Accounts.length} 账号`

    return `
      <div class="pool-tile" data-tooltip="${escapeHtml(tipLines.join('\n'))}">
        <div class="pool-head">
          <span class="pool-name">${escapeHtml(title)}</span>
          <span class="pool-badge">平均</span>
        </div>
        <div class="pool-pct ${tone}">${formatPercent(pct)}</div>
        <div class="bar-track" role="progressbar" aria-label="Gemini 4 ${escapeHtml(
          title
        )}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width.toFixed(1)}">
          <div class="bar-fill ${tone}" style="width:${width.toFixed(1)}%"></div>
        </div>
        <div class="pool-meta">
          <span class="pool-meta-item">${escapeHtml(lowText)}</span>
          <span class="pool-meta-item pool-meta-reset">${resetHtml}</span>
        </div>
      </div>
    `
  }

  let geminiBody = ''
  if (g4Accounts.length === 0) {
    geminiBody = `
      <div class="callout warning">
        <div>
          <strong>暂无支持 Gemini 4 的可用账号</strong>
          <p>当前 ${okAccounts.length} 个在线账号均未开通 Gemini 4 主模型，已全部排除出 Gemini 额度计算。</p>
        </div>
      </div>
    `
  } else {
    const fiveHourLines = []
    const weeklyLines = []
    for (const a of g4Accounts) {
      const name = a.label || a.account.split('@')[0]
      const b = accountGeminiBreakdown(a)
      if (b.fiveHour != null) fiveHourLines.push(`· ${name}：${formatPercent(b.fiveHour)}`)
      if (b.weekly != null) weeklyLines.push(`· ${name}：${formatPercent(b.weekly)}`)
    }
    const fiveHourPct = gemini.avg5h ?? gemini.avgAll
    const weeklyPct = gemini.avgWeekly
    geminiBody = `
      <div class="pool-grid">
        ${windowTile('5h 额度', fiveHourPct, gemini.min5h ?? gemini.minAll, gemini.earliest5hReset, fiveHourLines)}
        ${windowTile('周额度', weeklyPct, gemini.minWeekly, gemini.earliestWeeklyReset, weeklyLines)}
      </div>
    `
  }

  const excludedBadge =
    excludedAccounts.length > 0
      ? `<span class="pool-excluded-tag" data-tooltip="以下账号未开通 Gemini 4 主模型，不计入上方汇总：\n${escapeHtml(
          excludedNames
        )}">已排除 ${excludedAccounts.length} 个无 G4</span>`
      : ''

  let argonStrip = ''
  const argonPct = argon.avgWeekly ?? argon.avgAll
  if (argonPct != null) {
    const argonTone = toneForPercent(argonPct)
    const argonWidth = Math.max(0, Math.min(100, argonPct))
    const argonLines = []
    for (const a of okAccounts) {
      const ab = accountArgonBreakdown(a)
      const val = ab.weekly ?? ab.overall
      if (val != null) {
        const name = a.label || a.account.split('@')[0]
        argonLines.push(`· ${name}：${formatPercent(val)}`)
      }
    }
    const argonTipLines = [
      `Gemini 4 Argon · 独立每周额度桶（${argon.accountCount} 个账号平均）`,
      `平均剩余：${formatPercent(argonPct)}`
    ]
    const argonMin = argon.minWeekly ?? argon.minAll
    if (argonMin != null && argon.accountCount > 1) {
      argonTipLines.push(`最低账号：${formatPercent(argonMin)}`)
    }
    if (argon.earliestWeeklyReset) {
      argonTipLines.push(`最近重置：${formatLocalDateTime(argon.earliestWeeklyReset.ms)}`)
    }
    if (argonLines.length) {
      argonTipLines.push(...argonLines)
    }

    argonStrip = `
      <div class="pool-secondary" data-tooltip="${escapeHtml(argonTipLines.join('\n'))}">
        <div class="pool-secondary-left">
          <span class="pool-icon">${sparkleSvg()}</span>
          <span class="pool-secondary-name">Gemini 4 Argon</span>
          <span class="pool-secondary-tag">独立周桶</span>
        </div>
        <div class="pool-secondary-metrics">
          <span class="pool-meta-item"><span>周</span><strong class="${argonTone}">${escapeHtml(
            formatPercent(argonPct)
          )}</strong></span>
          <span class="pool-secondary-bar" aria-hidden="true">
            <span class="bar-fill ${argonTone}" style="display:block;width:${argonWidth.toFixed(1)}%"></span>
          </span>
        </div>
      </div>
    `
  }

  let thirdStrip = ''
  if (third.avgAll != null) {
    const thirdTone = toneForPercent(third.avgAll)
    const thirdWidth = Math.max(0, Math.min(100, third.avgAll))
    const thirdTip = [
      `Claude · GPT 池（${third.accountCount || okAccounts.length} 个在线账号平均）`,
      third.avg5h != null ? `5h 窗口平均：${formatPercent(third.avg5h)}` : '',
      third.avgWeekly != null ? `每周额度平均：${formatPercent(third.avgWeekly)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    thirdStrip = `
      <div class="pool-secondary" data-tooltip="${escapeHtml(thirdTip)}">
        <div class="pool-secondary-left">
          <span class="pool-icon">${layersSvg()}</span>
          <span class="pool-secondary-name">Claude · GPT 池</span>
        </div>
        <div class="pool-secondary-metrics">
          <span class="pool-meta-item"><span>5h</span><strong>${escapeHtml(
            formatPercent(third.avg5h ?? third.avgAll)
          )}</strong></span>
          <span class="pool-meta-sep" aria-hidden="true">·</span>
          <span class="pool-meta-item"><span>周</span><strong>${escapeHtml(
            formatPercent(third.avgWeekly)
          )}</strong></span>
          <span class="pool-secondary-bar" aria-hidden="true">
            <span class="bar-fill ${thirdTone}" style="display:block;width:${thirdWidth.toFixed(1)}%"></span>
          </span>
        </div>
      </div>
    `
  }

  return `
    <section class="pool-section" aria-label="Gemini 4 共享池总览">
      <div class="pool-section-head">
        <div class="pool-section-title">
          <span class="pool-icon">${sparkleSvg()}</span>
          <span>Gemini 4 额度池</span>
          <span class="pool-count">${g4Accounts.length} 账号</span>
        </div>
        ${excludedBadge}
      </div>
      ${geminiBody}
      ${argonStrip}
      ${thirdStrip}
    </section>
  `
}

function headerHtml(snapshot) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : []
  const ok = snapshot?.summary?.ok ?? 0
  const total = snapshot?.summary?.accounts ?? 0
  const failed = snapshot?.summary?.failed ?? 0
  const okAccounts = accounts.filter((a) => a && a.status === 'ok')
  const g4Ok = okAccounts.filter((a) => supportsGemini4(a)).length
  const excludedOk = okAccounts.length - g4Ok

  let pill = ''
  if (snapshot) {
    if (snapshot.error && !snapshot.stale) {
      pill = '<span class="status-pill danger">查询异常</span>'
    } else if (snapshot.stale) {
      pill = '<span class="status-pill warning">缓存中</span>'
    } else if (failed > 0) {
      pill = `<span class="status-pill warning">${g4Ok}/${total} 支持 G4</span>`
    } else if (g4Ok > 0) {
      const label = excludedOk > 0 ? `${g4Ok}/${total} 支持 G4` : `${g4Ok}/${total} 可用`
      const tip =
        excludedOk > 0
          ? `${ok}/${total} 账号在线 · ${g4Ok} 个支持 Gemini 4 · ${excludedOk} 个无 Gemini 4 已排除`
          : `${ok}/${total} 账号可用`
      pill = `<span class="status-pill" data-tooltip="${escapeHtml(tip)}">${label}</span>`
    } else if (ok > 0) {
      pill = `<span class="status-pill warning" data-tooltip="在线账号均未开通 Gemini 4 主模型">0/${total} 支持 G4</span>`
    } else if (total > 0) {
      pill = `<span class="status-pill neutral">0/${total} 可用</span>`
    }
  }

  return `
    <header class="topbar">
      <div class="brand">
        <span class="spark">${sparkleSvg()}</span>
        <span class="title">Gemini Quota</span>
        ${pill}
      </div>
      <button class="icon-btn ${state.refreshing ? 'spinning' : ''}" data-action="refresh" ${
        state.refreshing ? 'disabled' : ''
      } aria-label="刷新额度" data-tooltip="立即刷新额度 (R)">
        ${refreshSvg()}
      </button>
    </header>
  `
}

function chipsHtml(accounts) {
  if (accounts.length <= 1) return ''
  const allChip = `
    <button class="chip" role="tab" aria-selected="${state.selectedAccount === 'all'}" data-action="account" data-account="all">
      <span class="chip-name">全部</span>
      <span class="chip-metric">${accounts.length}</span>
    </button>
  `
  const accountChips = accounts
    .map((account) => {
      const name = account.label || account.account.split('@')[0]
      let dotClass = ''
      let metric = ''
      let tip = account.account
      if (account.status === 'ok') {
        const g4 = supportsGemini4(account)
        const b = accountGeminiBreakdown(account)
        const ab = accountArgonBreakdown(account)
        const argonPct = ab.weekly ?? ab.overall
        if (!g4 && argonPct != null) {
          dotClass = toneForPercent(argonPct)
          metric = `Argon ${formatPercent(argonPct)}`
          tip = `${account.account}\n未开通 Neon / Hydrogen 主模型，仅支持 Gemini 4 Argon\nArgon 周额度：${formatPercent(
            argonPct
          )}`
        } else if (!g4) {
          dotClass = 'skipped'
          metric = '无 G4'
          tip = `${account.account}\n未开通 Gemini 4 主模型，不计入汇总`
        } else {
          dotClass = toneForPercent(b.overall)
          if (b.fiveHour != null && b.weekly != null) {
            metric = `${formatPercent(b.fiveHour)} / ${formatPercent(b.weekly)}`
            tip = `${account.account}\n5h 额度：${formatPercent(b.fiveHour)} · 周额度：${formatPercent(b.weekly)}`
          } else {
            metric = formatPercent(b.overall)
          }
          if (argonPct != null) {
            tip += `\nArgon 周额度：${formatPercent(argonPct)}`
          }
        }
      } else if (account.status === 'skipped') {
        dotClass = 'skipped'
        metric = '跳过'
      } else {
        dotClass = 'danger'
        metric = '失败'
      }
      return `
        <button class="chip" role="tab" aria-selected="${state.selectedAccount === account.account}" data-action="account" data-account="${escapeHtml(
          account.account
        )}" data-tooltip="${escapeHtml(tip)}">
          <span class="chip-dot ${dotClass}" aria-hidden="true"></span>
          <span class="chip-name">${escapeHtml(name)}</span>
          <span class="chip-metric">${escapeHtml(metric)}</span>
        </button>
      `
    })
    .join('')

  return `<div class="chips" role="tablist" aria-label="账号筛选">${allChip}${accountChips}</div>`
}

function calloutsHtml(snapshot) {
  const error = snapshot?.error || state.error
  if (error) {
    return `
      <div class="callout ${snapshot?.stale ? 'warning' : 'danger'}">
        <div>
          <strong>${snapshot?.stale ? '刷新失败 · 显示缓存' : '额度获取失败'}</strong>
          <p>${escapeHtml(error)}</p>
        </div>
        <button class="text-btn" data-action="refresh">重试</button>
      </div>
    `
  }
  return ''
}

function meterTileHtml(bucket, label) {
  if (!bucket) return ''
  const fraction =
    typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
      ? bucket.remainingFraction
      : null
  const percent = fraction == null ? null : Math.max(0, Math.min(100, fraction * 100))
  const width = percent == null ? 0 : percent
  const tone = toneForPercent(percent)
  const resetIso = bucket.resetTime || ''
  const resetRel = resetIso ? resetsInText(resetIso) : ''
  const resetLocal = resetIso ? formatLocalDateTime(resetIso) : ''

  const tipLines = [`${label}：剩余 ${formatPercent(percent)}`]
  if (resetLocal) tipLines.push(`重置时间：${resetLocal}`)

  return `
    <div class="meter-tile" data-tooltip="${escapeHtml(tipLines.join('\n'))}">
      <div class="meter-top">
        <span class="meter-label">${escapeHtml(label)}</span>
        <span class="meter-pct ${tone}">${formatPercent(percent)}</span>
      </div>
      <div class="bar-track" role="progressbar" aria-label="${escapeHtml(label)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width.toFixed(1)}">
        <div class="bar-fill ${tone}" style="width:${width.toFixed(1)}%"></div>
      </div>
      <div class="meter-reset">${
        resetRel
          ? `<span class="reset-relative" data-reset-iso="${escapeHtml(resetIso)}">${escapeHtml(
              resetRel
            )}</span>`
          : '—'
      }</div>
    </div>
  `
}

function prettyGroupTitle(group) {
  const kind = classifyGroup(group)
  if (kind === 'argon') return 'Gemini 4 Argon'
  if (kind === 'gemini') return 'Gemini 模型'
  if (kind === 'third-party') return 'Claude · GPT 模型'
  const name = String(group?.displayName || '').trim()
  return name || '模型额度'
}

function groupOrderRank(group) {
  const kind = classifyGroup(group)
  if (kind === 'gemini') return 0
  if (kind === 'argon') return 1
  if (kind === 'third-party') return 2
  return 3
}

function displayGroupsForAccount(account) {
  const groups = [...safeGroups(account)]
  const hasExplicitArgon = groups.some((g) => classifyGroup(g) === 'argon')
  if (!hasExplicitArgon && groups.length > 0 && shouldFallbackArgonFromModels(account)) {
    const ab = accountArgonBreakdown(account)
    const pct = ab.weekly ?? ab.overall
    if (pct != null) {
      groups.push({
        displayName: 'Gemini 4 Argon',
        description: 'Pro 账号的 Gemini 4 Argon 使用独立每周配额桶，不与 Neon / Hydrogen / Flash 共享。',
        buckets: [
          {
            bucketId: 'gemini-argon-wtu-weekly',
            displayName: 'Gemini 4 Argon Weekly Limit',
            window: 'weekly',
            remainingFraction: pct / 100,
            remainingPercent: pct,
            resetTime: ab.reset?.iso || null
          }
        ]
      })
    }
  }
  return groups.sort((a, b) => groupOrderRank(a) - groupOrderRank(b))
}

function usageGroupHtml(group) {
  const kind = classifyGroup(group)
  const title = prettyGroupTitle(group)
  const icon = kind === 'gemini' || kind === 'argon' ? sparkleSvg() : layersSvg()
  const fiveHour = findBucket(group, '5h')
  const weekly = findBucket(group, 'weekly')

  let tiles = []
  if (fiveHour) tiles.push(meterTileHtml(fiveHour, '5h 窗口'))
  if (weekly) tiles.push(meterTileHtml(weekly, '每周额度'))
  if (!tiles.length) {
    tiles = safeBuckets(group).map((b) => meterTileHtml(b, b.displayName || '额度'))
  }

  let groupTag = ''
  if (kind === 'argon') {
    const tip =
      'Pro 账号的 Gemini 4 Argon 使用独立每周配额桶，不与 Neon / Hydrogen / Flash 共享。'
    groupTag = `<span class="group-tag" data-tooltip="${escapeHtml(tip)}">独立桶</span>`
  }

  const titleTip = group.description ? ` data-tooltip="${escapeHtml(group.description)}"` : ''

  return `
    <div class="group">
      <div class="group-head">
        <h2 class="group-title"${titleTip}>${icon}<span>${escapeHtml(title)}</span></h2>
        ${groupTag}
      </div>
      <div class="bucket-grid ${tiles.length === 1 ? 'single' : ''}">${tiles.join('')}</div>
    </div>
  `
}

function detailRowHtml(model) {
  const tone = toneForPercent(model.percent)
  const width = model.percent == null ? 0 : Math.max(0, Math.min(100, model.percent))
  const resetShort = model.resetLocal ? model.resetLocal.slice(5, 16) : ''
  const tipLines = [`${model.name} · 剩余 ${formatPercent(model.percent)}`]
  if (model.resetLocal) tipLines.push(`重置时间：${model.resetLocal}`)
  if (model.variants.length) tipLines.push(`变体：${model.variants.join(', ')}`)

  return `
    <div class="detail-row" data-tooltip="${escapeHtml(tipLines.join('\n'))}">
      <span class="detail-name">${escapeHtml(model.name)}</span>
      <span class="detail-bar-mini" aria-hidden="true">
        <span class="bar-fill ${tone}" style="display:block;width:${width.toFixed(1)}%"></span>
      </span>
      <span class="detail-pct ${tone}">${formatPercent(model.percent)}</span>
      <span class="detail-reset">${escapeHtml(resetShort)}</span>
    </div>
  `
}

function detailSectionHtml(account) {
  const models = groupModels(account.models)
  if (!models.length) return ''
  const expanded = Boolean(state.expanded[account.account])

  let body = ''
  if (expanded) {
    const geminiModels = models.filter((m) => !m.thirdParty && !m.argon)
    const argonModels = models.filter((m) => m.argon)
    const thirdModels = models.filter((m) => m.thirdParty)
    const sections = []
    if (geminiModels.length) {
      sections.push({
        label: argonModels.length ? 'Gemini（主池）' : 'Gemini',
        items: geminiModels
      })
    }
    if (argonModels.length) {
      sections.push({
        label: 'Gemini 4 Argon（独立周桶）',
        items: argonModels
      })
    }
    if (thirdModels.length) {
      sections.push({
        label: 'Claude · GPT',
        items: thirdModels
      })
    }

    const listHtml =
      sections.length > 1
        ? sections
            .map(
              (sec) =>
                `<div class="detail-section-label">${escapeHtml(sec.label)}</div>${sec.items
                  .map(detailRowHtml)
                  .join('')}`
            )
            .join('')
        : models.map(detailRowHtml).join('')

    const note = argonModels.length
      ? '同组模型共享对应额度桶（Pro 账号的 Argon 为独立周桶），以下为上游逐模型快照。'
      : '同组模型共享上方 5h / 每周额度池，以下为上游逐模型快照。'

    body = `
      <div class="detail">
        <div class="detail-note">${note}</div>
        ${listHtml}
      </div>
    `
  }

  return `
    <div class="detail-bar">
      <button class="detail-toggle" aria-expanded="${expanded}" data-action="toggle-detail" data-account="${escapeHtml(
        account.account
      )}">
        <span class="detail-toggle-left">
          <span>${expanded ? '收起模型明细' : '模型明细'}</span>
          <span class="detail-count">${models.length}</span>
        </span>
        <span class="chevron" aria-hidden="true">${chevronSvg()}</span>
      </button>
      ${body}
    </div>
  `
}

function capabilityRowHtml(account) {
  const tags = capabilityTags(account)
  if (!tags.length) return ''
  return `<div class="cap-row">${tags
    .map((t) => `<span class="cap-tag ${t.accent ? 'accent' : ''}">${escapeHtml(t.text)}</span>`)
    .join('')}</div>`
}

function accountCardHtml(account) {
  const primary = account.label || account.account
  const showEmail = Boolean(account.label && account.account && account.label !== account.account)

  if (account.status === 'skipped') {
    return `
      <section class="account-card is-muted">
        <div class="account-body">
          <div class="account-head">
            <div class="account-id">
              <div class="account-name-row">
                <span class="account-primary" data-tooltip="${escapeHtml(primary)}">${escapeHtml(
                  primary
                )}</span>
              </div>
              ${
                showEmail
                  ? `<div class="account-email" data-tooltip="${escapeHtml(
                      account.account
                    )}">${escapeHtml(account.account)}</div>`
                  : ''
              }
            </div>
            <span class="status-pill neutral">已跳过</span>
          </div>
          <div class="skipped-reason">${escapeHtml(localizeReason(account))}</div>
        </div>
      </section>
    `
  }

  const groups = displayGroupsForAccount(account)
  if (account.status === 'error' && !groups.length) {
    return `
      <section class="account-card is-muted">
        <div class="account-body">
          <div class="account-head">
            <div class="account-id">
              <div class="account-name-row">
                <span class="account-primary" data-tooltip="${escapeHtml(primary)}">${escapeHtml(
                  primary
                )}</span>
              </div>
              ${
                showEmail
                  ? `<div class="account-email" data-tooltip="${escapeHtml(
                      account.account
                    )}">${escapeHtml(account.account)}</div>`
                  : ''
              }
            </div>
            <span class="status-pill danger">查询失败</span>
          </div>
          <div class="skipped-reason">${escapeHtml(localizeReason(account))}</div>
        </div>
      </section>
    `
  }

  const g4Capable = supportsGemini4(account)
  const breakdown = accountGeminiBreakdown(account)
  const argonBreakdown = accountArgonBreakdown(account)
  const argonPct = argonBreakdown.weekly ?? argonBreakdown.overall
  let healthBadge = ''
  if (!g4Capable && argonPct != null) {
    healthBadge = `<span class="account-badge compact ${toneForPercent(
      argonPct
    )}" data-tooltip="未开通 Neon / Hydrogen 主模型，仅计入 Gemini 4 Argon 独立周桶">Argon ${formatPercent(
      argonPct
    )}</span>`
  } else if (!g4Capable) {
    healthBadge = `<span class="account-badge muted" data-tooltip="未开通 Gemini 4 主模型，剩余额度不计入 Gemini 汇总计算">不计入 G4</span>`
  } else if (breakdown.fiveHour != null || breakdown.weekly != null) {
    const badges = []
    if (breakdown.fiveHour != null) {
      badges.push(
        `<span class="account-badge compact ${toneForPercent(
          breakdown.fiveHour
        )}" data-tooltip="Gemini 主池 5h 窗口剩余额度">5h ${formatPercent(breakdown.fiveHour)}</span>`
      )
    }
    if (breakdown.weekly != null) {
      badges.push(
        `<span class="account-badge compact ${toneForPercent(
          breakdown.weekly
        )}" data-tooltip="Gemini 主池每周剩余额度">周 ${formatPercent(breakdown.weekly)}</span>`
      )
    }
    healthBadge = `<div class="account-badges">${badges.join('')}</div>`
  } else if (breakdown.overall != null) {
    healthBadge = `<span class="account-badge ${toneForPercent(
      breakdown.overall
    )}" data-tooltip="Gemini 主池最低剩余额度">${formatPercent(breakdown.overall)}</span>`
  }

  let body
  if (groups.length) {
    body = `<div class="groups">${groups.map(usageGroupHtml).join('')}</div>`
  } else {
    const msg = account.quotaSummaryError?.message || account.error || '上游未返回 Usage 汇总。'
    body = `<div class="callout warning"><div><strong>Usage 汇总暂不可用</strong><p>${escapeHtml(
      msg
    )}</p></div></div>`
  }

  const partialError =
    account.status === 'error' && groups.length
      ? `<div class="callout warning"><div><p>部分数据获取失败：${escapeHtml(
          account.error || 'unknown error'
        )}</p></div></div>`
      : ''

  return `
    <section class="account-card ${g4Capable || argonPct != null ? '' : 'is-excluded'}">
      <div class="account-body">
        <div class="account-head">
          <div class="account-id">
            <div class="account-name-row">
              <span class="account-primary" data-tooltip="${escapeHtml(primary)}">${escapeHtml(
                primary
              )}</span>
            </div>
            ${
              showEmail
                ? `<div class="account-email" data-tooltip="${escapeHtml(
                    account.account
                  )}">${escapeHtml(account.account)}</div>`
                : ''
            }
          </div>
          ${healthBadge}
        </div>
        ${capabilityRowHtml(account)}
        ${body}
        ${partialError}
      </div>
      ${detailSectionHtml(account)}
    </section>
  `
}

function footerHtml(snapshot) {
  const minutes = Number(state.settings?.refreshMinutes)
  const refreshText = Number.isFinite(minutes) && minutes >= 1 ? `${minutes} 分钟` : '5 分钟'
  const dot = snapshot.error && !snapshot.stale ? 'error' : snapshot.stale ? 'stale' : ''
  const fullStamp = snapshot.collectedAtLocal || formatLocalDateTime(snapshot.fetchedAt) || '—'
  const shortStamp =
    typeof snapshot.collectedAtLocal === 'string' && snapshot.collectedAtLocal.length >= 16
      ? snapshot.collectedAtLocal.slice(11, 16)
      : fullStamp

  const left = state.refreshing
    ? '<span class="spinner" aria-hidden="true"></span><span>刷新中…</span>'
    : `<span class="live-dot ${dot}" aria-hidden="true"></span><span>CPA · Antigravity</span><span class="sep">·</span><span>每 ${refreshText}</span>`

  return `
    <footer class="foot">
      ${left}
      <span class="updated" data-tooltip="上次同步：${escapeHtml(fullStamp)}">更新于 ${escapeHtml(
        shortStamp
      )}</span>
    </footer>
  `
}

function skeletonHtml() {
  return `
    <div class="skeleton" aria-label="正在加载额度">
      <div class="sk-card">
        <div class="sk-line" style="width:42%"></div>
        <div class="sk-line" style="width:76%"></div>
        <div class="sk-line" style="width:58%"></div>
      </div>
      <div class="sk-card">
        <div class="sk-line" style="width:36%"></div>
        <div class="sk-line" style="width:68%"></div>
      </div>
    </div>
  `
}

function emptyStateHtml(message) {
  return `
    <div class="empty">
      <span class="spark">${sparkleSvg()}</span>
      <h2>暂无额度数据</h2>
      <p>${escapeHtml(message)}</p>
      <button class="text-btn" data-action="refresh">重新查询</button>
    </div>
  `
}

function render() {
  hideTooltip()
  if (!api || !api.plugin) {
    app.setAttribute('aria-busy', 'false')
    app.innerHTML =
      headerHtml(null) + emptyStateHtml('Orca 插件桥不可用，请确认插件已启用并重新打开面板。')
    return
  }

  const snapshot = state.snapshot
  app.setAttribute('aria-busy', state.loading || state.refreshing ? 'true' : 'false')

  if (!snapshot) {
    app.innerHTML = headerHtml(null) + (state.error ? emptyStateHtml(state.error) : skeletonHtml())
    return
  }

  const accounts = sortAccounts(Array.isArray(snapshot.accounts) ? snapshot.accounts : [])
  if (!accounts.length) {
    app.innerHTML =
      headerHtml(snapshot) +
      calloutsHtml(snapshot) +
      emptyStateHtml(snapshot.error || '没有可用的 CPA Antigravity 账号。')
    return
  }

  const visible =
    state.selectedAccount === 'all'
      ? accounts
      : accounts.filter((a) => a.account === state.selectedAccount)

  app.innerHTML = [
    headerHtml(snapshot),
    poolOverviewHtml(accounts),
    chipsHtml(accounts),
    calloutsHtml(snapshot),
    `<div class="accounts">${visible.map(accountCardHtml).join('')}</div>`,
    footerHtml(snapshot)
  ].join('')

  tick()
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    state.error = '额度返回格式无效。'
    state.loading = false
    state.refreshing = false
    render()
    return
  }
  state.snapshot = snapshot
  state.error = snapshot.error || null
  state.loading = false
  state.refreshing = false
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : []
  if (
    state.selectedAccount !== 'all' &&
    !accounts.some((a) => a && a.account === state.selectedAccount)
  ) {
    state.selectedAccount = 'all'
  }
  render()
}

async function load(force) {
  state.error = null
  if (force) state.refreshing = true
  if (!state.snapshot) state.loading = true
  render()
  try {
    const result = force
      ? await api.plugin.request('quota.refresh', undefined, { timeoutMs: 120000 })
      : await api.plugin.request('quota.get', {}, { timeoutMs: 120000 })
    applySnapshot(result)
  } catch (error) {
    state.error = error?.message || String(error)
    state.loading = false
    state.refreshing = false
    render()
  }
}

function tick() {
  document.querySelectorAll('.reset-relative[data-reset-iso]').forEach((el) => {
    const iso = el.getAttribute('data-reset-iso')
    if (!iso) return
    const next = resetsInText(iso)
    if (next) el.textContent = next
  })
}

// Viewport-clamped floating tooltip
let activeTipTarget = null

function showTooltip(target) {
  if (!tooltipEl || !target) return
  const text = target.getAttribute('data-tooltip')
  if (!text) return
  activeTipTarget = target
  tooltipEl.textContent = text
  tooltipEl.setAttribute('aria-hidden', 'false')
  tooltipEl.classList.add('visible')

  const rect = target.getBoundingClientRect()
  const tipRect = tooltipEl.getBoundingClientRect()
  const pad = 8
  let left = rect.left + rect.width / 2 - tipRect.width / 2
  left = Math.max(pad, Math.min(window.innerWidth - tipRect.width - pad, left))

  let top = rect.top - tipRect.height - 6
  if (top < pad) {
    top = rect.bottom + 6
  }
  if (top + tipRect.height > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - tipRect.height - pad)
  }

  tooltipEl.style.left = `${Math.round(left)}px`
  tooltipEl.style.top = `${Math.round(top)}px`
}

function hideTooltip() {
  activeTipTarget = null
  if (!tooltipEl) return
  tooltipEl.classList.remove('visible')
  tooltipEl.setAttribute('aria-hidden', 'true')
}

app.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tooltip]')
  if (target === activeTipTarget) return
  if (target) {
    showTooltip(target)
  } else {
    hideTooltip()
  }
})

app.addEventListener('pointerleave', () => hideTooltip())
window.addEventListener('scroll', () => hideTooltip(), true)

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.getAttribute('data-action')
  if (action === 'refresh') {
    if (!state.refreshing) void load(true)
  } else if (action === 'account') {
    state.selectedAccount = target.getAttribute('data-account') || 'all'
    render()
  } else if (action === 'toggle-detail') {
    const account = target.getAttribute('data-account') || ''
    state.expanded[account] = !state.expanded[account]
    render()
  }
})

window.addEventListener('keydown', (event) => {
  if (
    event.key.toLowerCase() === 'r' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.repeat
  ) {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (!state.refreshing) void load(true)
  }
})

async function init() {
  if (!api || !api.plugin) {
    render()
    return
  }

  try {
    state.settings = (await api.settings.get()) || {}
    api.settings.onDidChange(async () => {
      state.settings = (await api.settings.get()) || {}
      render()
    })
  } catch {
    state.settings = {}
  }

  try {
    api.plugin.on('quota.changed', (snapshot) => applySnapshot(snapshot))
    api.plugin.on('quota.refreshing', () => {
      state.refreshing = true
      render()
    })
  } catch (error) {
    state.error = error?.message || String(error)
  }

  if (typeof api.on === 'function') {
    api.on('theme', ({ colorScheme }) => {
      document.documentElement.classList.toggle('dark', colorScheme === 'dark')
      document.documentElement.classList.toggle('light', colorScheme !== 'dark')
    })
  }

  await load(false)
  setInterval(tick, 30_000)
}

void init()

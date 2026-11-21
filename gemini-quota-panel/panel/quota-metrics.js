import {
  classifyGroup,
  findBucket,
  isArgonModelId,
  isMainGeminiModelId,
  isThirdPartyModel,
  safeBuckets,
  safeGroups,
  shouldFallbackArgonFromModels,
  supportsGemini4
} from './quota-classifier.js'

function avgValues(values) {
  if (!values.length) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

export function accountArgonBreakdown(account) {
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

export function accountThirdPartyPercent(account) {
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

export function accountGeminiBreakdown(account) {
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

export function sortAccounts(accounts) {
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

export function computePoolTile(accounts, kind) {
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
        acctAll = accountGeminiBreakdown(account).overall
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

export function prettyGroupTitle(group) {
  const kind = classifyGroup(group)
  if (kind === 'argon') return 'Gemini 4 Argon'
  if (kind === 'gemini') return 'Gemini 模型'
  if (kind === 'third-party') return 'Claude · GPT 模型'
  return String(group?.displayName || '').trim() || '模型额度'
}

function groupOrderRank(group) {
  const kind = classifyGroup(group)
  if (kind === 'gemini') return 0
  if (kind === 'argon') return 1
  if (kind === 'third-party') return 2
  return 3
}

export function displayGroupsForAccount(account) {
  const groups = [...safeGroups(account)]
  const hasExplicitArgon = groups.some((g) => classifyGroup(g) === 'argon')
  if (!hasExplicitArgon && groups.length > 0 && shouldFallbackArgonFromModels(account)) {
    const ab = accountArgonBreakdown(account)
    const pct = ab.weekly ?? ab.overall
    if (pct != null) {
      groups.push({
        displayName: 'Gemini 4 Argon',
        description:
          'Pro 账号的 Gemini 4 Argon 使用独立每周配额桶，不与 Neon / Hydrogen / Flash 共享。',
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

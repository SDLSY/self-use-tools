import type {
  CapabilityHints,
  QuotaAccount,
  QuotaBucket,
  QuotaGroup,
  QuotaModel,
  QuotaSnapshot
} from './protocol'

export function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

export function clampFraction(value: unknown): number | null {
  const num = asFiniteNumber(value)
  if (num == null) return null
  return Math.min(1, Math.max(0, num))
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

export function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return new Date(at).toISOString().slice(11, 16)
  }
}

function sanitizeBucket(raw: unknown): QuotaBucket | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const fraction = clampFraction(item.remainingFraction)
  const percent =
    asFiniteNumber(item.remainingPercent) ?? (fraction != null ? fraction * 100 : null)
  return {
    bucketId: asString(item.bucketId),
    displayName: asString(item.displayName),
    window: asString(item.window),
    remainingFraction: fraction,
    remainingPercent: percent,
    resetTime: asString(item.resetTime),
    description: asString(item.description)
  }
}

function sanitizeGroup(raw: unknown): QuotaGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const buckets = Array.isArray(item.buckets)
    ? item.buckets.map(sanitizeBucket).filter((b): b is QuotaBucket => b !== null)
    : []
  const displayName = asString(item.displayName)
  const description = asString(item.description)
  if (!displayName && buckets.length === 0) return null
  return { displayName, description, buckets }
}

function sanitizeModel(raw: unknown): QuotaModel | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const name = asString(item.model) ?? asString(item.modelId)
  if (!name) return null
  const fraction = clampFraction(item.remainingFraction)
  const percent =
    asFiniteNumber(item.remainingPercent) ?? (fraction != null ? fraction * 100 : null)
  return {
    model: name,
    modelId: name,
    remainingFraction: fraction,
    remainingPercent: percent,
    remainingPercentText: asString(item.remainingPercentText) ?? formatPercent(percent),
    resetTime: asString(item.resetTime),
    resetTimeLocal: asString(item.resetTimeLocal),
    tokenType: asString(item.tokenType)
  }
}

function sanitizeCapabilityHints(raw: unknown): CapabilityHints | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const modelIds = Array.isArray(item.model_ids)
    ? item.model_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : undefined
  const webSearchIds = Array.isArray(item.web_search_model_ids)
    ? item.web_search_model_ids.filter(
        (x): x is string => typeof x === 'string' && x.trim().length > 0
      )
    : undefined
  return {
    model_ids: modelIds,
    endpoint: asString(item.endpoint) ?? undefined,
    project_id: asString(item.project_id) ?? undefined,
    web_search_model_ids: webSearchIds
  }
}

function sanitizeAccount(raw: unknown): QuotaAccount | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const account = asString(item.account) ?? asString(item.email) ?? asString(item.label)
  if (!account) return null

  const models = Array.isArray(item.models)
    ? item.models.map(sanitizeModel).filter((m): m is QuotaModel => m !== null)
    : []
  const quotaGroups = Array.isArray(item.quotaGroups)
    ? item.quotaGroups.map(sanitizeGroup).filter((g): g is QuotaGroup => g !== null)
    : []
  const summaryErrRaw =
    item.quotaSummaryError && typeof item.quotaSummaryError === 'object'
      ? (item.quotaSummaryError as Record<string, unknown>)
      : null

  return {
    account,
    email: asString(item.email),
    label: asString(item.label),
    status: asString(item.status) ?? 'error',
    reason: asString(item.reason),
    error: asString(item.error),
    project: asString(item.project),
    sourceHost: asString(item.sourceHost),
    tokenExpiresAt: asString(item.tokenExpiresAt),
    modelCount: asFiniteNumber(item.modelCount) ?? models.length,
    lowestRemainingPercent: asFiniteNumber(item.lowestRemainingPercent),
    lowestRemainingText: asString(item.lowestRemainingText),
    nextResetTimeLocal: asString(item.nextResetTimeLocal),
    models,
    capabilityHints: sanitizeCapabilityHints(item.capabilityHints),
    quotaGroups,
    quotaSummaryDescription: asString(item.quotaSummaryDescription),
    quotaSummaryError: summaryErrRaw
      ? {
          host: asString(summaryErrRaw.host),
          status: asFiniteNumber(summaryErrRaw.status),
          message: asString(summaryErrRaw.message)
        }
      : null
  }
}

export function sanitizeSnapshot(raw: unknown): QuotaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  if (!Array.isArray(doc.accounts)) return null

  const accounts = doc.accounts
    .map(sanitizeAccount)
    .filter((a): a is QuotaAccount => a !== null)
  const summaryRaw =
    doc.summary && typeof doc.summary === 'object'
      ? (doc.summary as Record<string, unknown>)
      : null

  const okCount =
    asFiniteNumber(summaryRaw?.ok) ?? accounts.filter((a) => a.status === 'ok').length
  const failedCount =
    asFiniteNumber(summaryRaw?.failed) ?? accounts.filter((a) => a.status === 'error').length
  const skippedCount =
    asFiniteNumber(summaryRaw?.skipped) ?? accounts.filter((a) => a.status === 'skipped').length
  const modelsCount =
    asFiniteNumber(summaryRaw?.models) ??
    accounts.reduce((sum, a) => sum + (a.modelCount || a.models.length), 0)

  const warnings = Array.isArray(doc.warnings)
    ? doc.warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
    : []

  const snapshot: QuotaSnapshot = {
    schema: asString(doc.schema) ?? 'cpa-quota/1',
    generatedAt: asString(doc.generatedAt) ?? new Date().toISOString(),
    collectedAtLocal: asString(doc.collectedAtLocal) ?? undefined,
    sshHost: asString(doc.sshHost),
    proxy: asString(doc.proxy),
    fetchedAt: asFiniteNumber(doc.fetchedAt) ?? Date.now(),
    exitCode: asFiniteNumber(doc.exitCode) ?? 0,
    summary: {
      accounts: asFiniteNumber(summaryRaw?.accounts) ?? accounts.length,
      ok: okCount,
      failed: failedCount,
      skipped: skippedCount,
      models: modelsCount,
      lowestRemainingPercent: asFiniteNumber(summaryRaw?.lowestRemainingPercent)
    },
    accounts,
    warnings
  }

  const err = asString(doc.error)
  if (err) snapshot.error = err
  if (typeof doc.stale === 'boolean') snapshot.stale = doc.stale
  return snapshot
}

export function parseSnapshot(stdout: string): QuotaSnapshot {
  const text = stdout.replace(/^﻿/, '').trim()
  const candidates = [text]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.error === 'string' && !parsed.summary) {
          throw new Error(parsed.error)
        }
        const clean = sanitizeSnapshot(parsed)
        if (clean) return clean
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  throw new Error('额度脚本没有返回可解析的 JSON')
}

export function failedSnapshot(message: string): QuotaSnapshot {
  return {
    schema: 'cpa-quota/1',
    generatedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
    exitCode: 1,
    summary: {
      accounts: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      models: 0,
      lowestRemainingPercent: null
    },
    accounts: [],
    warnings: [],
    error: message,
    stale: false
  }
}

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  CapabilityHints,
  QuotaAccount,
  QuotaBucket,
  QuotaGroup,
  QuotaModel,
  QuotaSnapshot
} from './protocol'

const CACHE_KEY = 'quota.snapshot'
const STATUS_ID = 'gemini-quota'
const DEFAULT_SCRIPT = 'D:\\self_use_tools\\cpa-quota\\Get-CpaQuota.ps1'
const DEFAULT_SSH_HOST = 'tencent-vps'
const DEFAULT_SSH_DIR = 'D:\\git\\Git\\usr\\bin'
const DEFAULT_REFRESH_MINUTES = 20
const WARN_BELOW = 20
const DANGER_BELOW = 5
const CACHE_TTL_MS = 60_000
const SCRIPT_TIMEOUT_MS = 120_000

type Settings = {
  scriptPath: string
  sshHost: string
  sshDir: string
  refreshMinutes: number
  warnBelow: number
  dangerBelow: number
}

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

type GroupKind = 'gemini' | 'argon' | 'third-party' | 'other'

type PoolStats = {
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

let timer: ReturnType<typeof setInterval> | undefined
let settingsSubscription: { dispose(): void } | undefined
let inFlight: Promise<QuotaSnapshot> | null = null

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function clampFraction(value: unknown): number | null {
  const num = asFiniteNumber(value)
  if (num == null) return null
  return Math.min(1, Math.max(0, num))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
  return {
    displayName,
    description,
    buckets
  }
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

function sanitizeSnapshot(raw: unknown): QuotaSnapshot | null {
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

async function readSettings(orca: OrcaWorkerApi): Promise<Settings> {
  try {
    const raw = ((await orca.settings.get()) || {}) as Record<string, unknown>
    return {
      scriptPath: asString(raw.scriptPath) ?? DEFAULT_SCRIPT,
      sshHost: asString(raw.sshHost) ?? DEFAULT_SSH_HOST,
      sshDir: asString(raw.sshDir) ?? DEFAULT_SSH_DIR,
      refreshMinutes: clamp(raw.refreshMinutes, DEFAULT_REFRESH_MINUTES, 1, 60),
      warnBelow: clamp(raw.warnBelow, WARN_BELOW, 0, 100),
      dangerBelow: clamp(raw.dangerBelow, DANGER_BELOW, 0, 100)
    }
  } catch (error) {
    orca.log(`settings read failed, using defaults: ${errorMessage(error)}`)
    return {
      scriptPath: DEFAULT_SCRIPT,
      sshHost: DEFAULT_SSH_HOST,
      sshDir: DEFAULT_SSH_DIR,
      refreshMinutes: DEFAULT_REFRESH_MINUTES,
      warnBelow: WARN_BELOW,
      dangerBelow: DANGER_BELOW
    }
  }
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number,
  envOverride?: Record<string, string | undefined>
): Promise<RunResult> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const path = [
    process.env.PATH || '',
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    `${systemRoot}\\System32\\OpenSSH`,
    `${systemRoot}\\System32`
  ]
    .filter(Boolean)
    .join(';')
  const env = envOverride ?? {
    ...process.env,
    PATH: path,
    HOME: process.env.HOME || homedir(),
    USERPROFILE: process.env.USERPROFILE || homedir()
  }
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env
      },
      (error, stdout, stderr) => {
        const output = String(stdout ?? '')
        const errors = String(stderr ?? '')
        if (error) {
          reject(Object.assign(error, { stdout: output, stderr: errors }))
          return
        }
        resolve({ stdout: output, stderr: errors, code: 0 })
      }
    )
  })
}

function parseSnapshot(stdout: string): QuotaSnapshot {
  const text = stdout.replace(/^\uFEFF/, '').trim()
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

async function runQuotaScript(settings: Settings): Promise<QuotaSnapshot> {
  const powershell =
    process.platform === 'win32' && process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : 'powershell.exe'
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    settings.scriptPath,
    '-Json'
  ]
  if (settings.sshHost) args.push('-SshHost', settings.sshHost)

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const path = [
    settings.sshDir,
    process.env.PATH || '',
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    `${systemRoot}\\System32\\OpenSSH`,
    `${systemRoot}\\System32`
  ]
    .filter(Boolean)
    .join(';')
  const env = {
    ...process.env,
    PATH: path,
    HOME: process.env.HOME || homedir(),
    USERPROFILE: process.env.USERPROFILE || homedir()
  }

  let result: RunResult
  try {
    result = await execFileAsync(powershell, args, SCRIPT_TIMEOUT_MS, env)
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number }
    if (failed.stdout) {
      try {
        const snapshot = parseSnapshot(failed.stdout)
        return {
          ...snapshot,
          exitCode: typeof failed.code === 'number' ? failed.code : 1
        }
      } catch {
        // Fall through to stderr/message below.
      }
    }
    const output = [failed.stderr, failed.stdout].filter(Boolean).join('\n').trim()
    const detail = output || failed.message
    throw new Error(detail || '额度脚本执行失败')
  }

  const snapshot = parseSnapshot(result.stdout)
  return {
    ...snapshot,
    exitCode: result.code
  }
}

async function readCache(orca: OrcaWorkerApi): Promise<QuotaSnapshot | null> {
  try {
    const value = await orca.storage.get(CACHE_KEY)
    return sanitizeSnapshot(value)
  } catch (error) {
    orca.log(`quota cache read failed: ${errorMessage(error)}`)
    return null
  }
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

function formatTime(at: number): string {
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

function minVal(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
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

function avgVal(values: number[]): number | null {
  if (values.length === 0) return null
  const sum = values.reduce((acc, v) => acc + v, 0)
  return sum / values.length
}

function isArgonModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  return lower.startsWith('gemini-4-argon') && !lower.includes('disabled')
}

function isMainGeminiModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.includes('gemini')) return false
  if (lower.includes('disabled')) return false
  // gemini-4-argon-* has an independent quota bucket on Pro plans
  if (lower.startsWith('gemini-4-argon')) return false
  return true
}

function isGemini4CoreModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  if (!lower.startsWith('gemini-4-')) return false
  if (lower.includes('disabled')) return false
  // gemini-4-hydrogen-sonar remains enabled on accounts where core Gemini-4 models are disabled
  if (lower.includes('sonar')) return false
  // gemini-4-argon-* uses its own quota bucket on Pro plans, separate from the main Neon/Hydrogen pool
  if (lower.startsWith('gemini-4-argon')) return false
  return true
}

function supportsGemini4(account: QuotaAccount | null | undefined): boolean {
  if (!account) return false
  const hintIds = account.capabilityHints?.model_ids
  if (Array.isArray(hintIds) && hintIds.length > 0) {
    return hintIds.some((id) => isGemini4CoreModelId(id))
  }
  const models = Array.isArray(account.models) ? account.models : []
  if (models.length > 0) {
    return models.some((m) => isGemini4CoreModelId(m.model || m.modelId || ''))
  }
  return false
}

function isThirdPartyModelId(id: string): boolean {
  const lower = String(id || '').trim().toLowerCase()
  return lower.startsWith('claude') || lower.startsWith('gpt') || lower.startsWith('openai')
}

function classifyGroup(group: QuotaGroup | null | undefined): GroupKind {
  if (!group) return 'other'
  const name = String(group.displayName || '').toLowerCase()
  const buckets = Array.isArray(group.buckets) ? group.buckets : []
  const hasArgonBucket = buckets.some((b) =>
    /argon/i.test(`${b?.bucketId || ''} ${b?.displayName || ''}`)
  )
  // Match Argon before generic Gemini because "Gemini 4 Argon" contains "gemini"
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
  // Legacy desktop-UA snapshots omit the Argon group and only list "Gemini 3.8 Flash" in Gemini Models
  if (!desc.includes('gemini 4')) return true

  // Otherwise only synthesize if Argon per-model quota clearly diverges from main Gemini models
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
  if (argonReset != null && mainReset != null && Math.abs(argonReset - mainReset) > 120_000) return true
  return false
}

function computePoolStats(snapshot: QuotaSnapshot): PoolStats {
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

    // Fallback to per-model fractions if summary groups are unavailable or omit Argon
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
    if (acctArgonWeekly != null) {
      argonWeeklyValues.push(acctArgonWeekly)
    }
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

function statusTone(
  snapshot: QuotaSnapshot,
  stats: PoolStats,
  settings: Settings
): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  if (snapshot.error) return snapshot.stale ? 'warning' : 'danger'
  if (snapshot.stale) return 'warning'
  if ((snapshot.summary?.failed ?? 0) > 0) return 'warning'
  if ((snapshot.summary?.ok ?? 0) === 0) return 'danger'
  if (stats.geminiEligibleCount === 0 && stats.argonAccountCount === 0) return 'warning'

  const bottleneck =
    minVal(stats.gemini5hAvg, stats.geminiWeeklyAvg) ??
    stats.geminiAvg ??
    stats.argonWeeklyAvg ??
    stats.argonAvg
  if (typeof bottleneck !== 'number' || !Number.isFinite(bottleneck)) return 'warning'
  if (bottleneck < settings.dangerBelow) return 'danger'
  if (bottleneck < settings.warnBelow) return 'warning'
  return 'success'
}

async function updateStatusBar(
  orca: OrcaWorkerApi,
  snapshot: QuotaSnapshot,
  settings: Settings
): Promise<void> {
  try {
    const stats = computePoolStats(snapshot)
    const avg = stats.geminiAvg
    const argonVal = stats.argonWeeklyAvg ?? stats.argonAvg
    const updated = snapshot.collectedAtLocal
      ? snapshot.collectedAtLocal.slice(11, 16) || snapshot.collectedAtLocal
      : formatTime(snapshot.fetchedAt || Date.now())

    const argonSuffix = argonVal != null ? ` · Argon ${formatPercent(argonVal)}` : ''
    let text: string
    if (stats.gemini5hAvg != null && stats.geminiWeeklyAvg != null) {
      text = `Gemini 5h ${formatPercent(stats.gemini5hAvg)} · 周 ${formatPercent(stats.geminiWeeklyAvg)}${argonSuffix}`
    } else if (stats.gemini5hAvg != null) {
      text = `Gemini 5h ${formatPercent(stats.gemini5hAvg)}${argonSuffix}`
    } else if (stats.geminiWeeklyAvg != null) {
      text = `Gemini 周 ${formatPercent(stats.geminiWeeklyAvg)}${argonSuffix}`
    } else if (typeof avg === 'number' && Number.isFinite(avg)) {
      text = `Gemini ${formatPercent(avg)}${argonSuffix}`
    } else if (argonVal != null) {
      text = `Argon ${formatPercent(argonVal)}`
    } else if ((snapshot.summary?.ok ?? 0) > 0 && stats.geminiEligibleCount === 0) {
      text = 'Gemini 无G4'
    } else {
      text = 'Gemini !'
    }

    const parts: string[] = []
    if (stats.gemini5hAvg != null || stats.geminiWeeklyAvg != null) {
      const g: string[] = []
      if (stats.gemini5hAvg != null) {
        const low5 =
          stats.gemini5hLowest != null && stats.geminiEligibleCount > 1
            ? `(最低 ${formatPercent(stats.gemini5hLowest)})`
            : ''
        g.push(`5h ${formatPercent(stats.gemini5hAvg)}${low5}`)
      }
      if (stats.geminiWeeklyAvg != null) {
        const lowW =
          stats.geminiWeeklyLowest != null && stats.geminiEligibleCount > 1
            ? `(最低 ${formatPercent(stats.geminiWeeklyLowest)})`
            : ''
        g.push(`周 ${formatPercent(stats.geminiWeeklyAvg)}${lowW}`)
      }
      parts.push(`Gemini 4 平均：${g.join(' / ')}`)
    } else if (avg != null) {
      parts.push(`Gemini 4 平均 ${formatPercent(avg)}`)
    } else if ((snapshot.summary?.ok ?? 0) > 0 && stats.geminiEligibleCount === 0) {
      parts.push('暂无支持 Gemini 4 主池的可用账号')
    }
    if (argonVal != null) {
      const lowA =
        stats.argonLowest != null && stats.argonAccountCount > 1
          ? `(最低 ${formatPercent(stats.argonLowest)})`
          : ''
      parts.push(`Argon 周 ${formatPercent(argonVal)}${lowA}`)
    }
    if (stats.thirdPartyAvg != null) {
      parts.push(`Claude/GPT 平均 ${formatPercent(stats.thirdPartyAvg)}`)
    }

    const total = snapshot.summary?.accounts ?? 0
    const skipped = snapshot.summary?.skipped ?? 0
    const failed = snapshot.summary?.failed ?? 0
    const acctParts = [`${stats.geminiEligibleCount}/${total} 支持 G4`]
    if (stats.geminiExcludedCount > 0) acctParts.push(`已排除 ${stats.geminiExcludedCount} 无 G4`)
    if (skipped > 0) acctParts.push(`${skipped} 跳过`)
    if (failed > 0) acctParts.push(`${failed} 失败`)

    const summaryLine = `${parts.join(' · ') || 'Gemini Quota'} | ${acctParts.join('，')} · 更新于 ${updated} · 点击打开面板`
    const tooltipText = snapshot.error
      ? `Gemini 额度刷新失败：${snapshot.error}${snapshot.stale ? `（显示 ${updated} 缓存）` : ''}`
      : summaryLine
    const tooltip =
      tooltipText.length > 250 ? `${tooltipText.slice(0, 247)}...` : tooltipText

    await orca.host.call('statusBar.update', {
      id: STATUS_ID,
      text,
      tone: statusTone(snapshot, stats, settings),
      tooltip
    })
  } catch (error) {
    orca.log(`status bar update failed: ${errorMessage(error)}`)
  }
}

function failedSnapshot(message: string): QuotaSnapshot {
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

async function refresh(orca: OrcaWorkerApi, force: boolean): Promise<QuotaSnapshot> {
  if (inFlight) return inFlight

  inFlight = (async () => {
    const settings = await readSettings(orca)
    const cached = await readCache(orca)

    if (!force && cached && Date.now() - (cached.fetchedAt || 0) < CACHE_TTL_MS) {
      await updateStatusBar(orca, cached, settings)
      return cached
    }

    try {
      orca.panels.post('quota.refreshing', { at: Date.now() })
    } catch {
      // Ignore panel post errors if no panels are open.
    }

    try {
      const fresh = await runQuotaScript(settings)
      const snapshot: QuotaSnapshot = {
        ...fresh,
        fetchedAt: Date.now(),
        stale: false
      }
      try {
        await orca.storage.set(CACHE_KEY, snapshot)
      } catch (storageErr) {
        orca.log(`quota cache write failed: ${errorMessage(storageErr)}`)
      }
      await updateStatusBar(orca, snapshot, settings)
      try {
        orca.panels.post('quota.changed', snapshot)
      } catch {
        // Ignore panel post errors.
      }
      return snapshot
    } catch (error) {
      const message = errorMessage(error)
      orca.log(`quota refresh failed: ${message}`)
      const fallback: QuotaSnapshot = cached
        ? { ...cached, stale: true, error: message }
        : failedSnapshot(message)
      await updateStatusBar(orca, fallback, settings)
      try {
        orca.panels.post('quota.changed', fallback)
      } catch {
        // Ignore panel post errors.
      }
      return fallback
    }
  })().finally(() => {
    inFlight = null
  })

  return inFlight
}

function resolveOrcaCli(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND
  const execDir = dirname(process.execPath)
  const candidates = [
    join(execDir, 'resources', 'bin', 'orca.exe'),
    join(execDir, '..', 'resources', 'bin', 'orca.exe'),
    join(execDir, 'orca.exe'),
    'D:\\Apps\\Orca\\resources\\bin\\orca.exe'
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Try next candidate.
    }
  }
  return 'orca'
}

function openPanel(orca: OrcaWorkerApi): Promise<boolean> {
  const profile = process.env.USERPROFILE || homedir()
  const env = {
    ...process.env,
    APPDATA: process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    USERPROFILE: profile,
    HOME: process.env.HOME || homedir()
  }
  return new Promise((resolve) => {
    execFile(
      resolveOrcaCli(),
      ['plugin', 'open', 'local.gemini-quota-panel', '--panel', 'gemini-quota'],
      {
        windowsHide: true,
        timeout: 15_000,
        cwd: profile,
        env
      },
      (error, _stdout, stderr) => {
        if (error) {
          orca.log(
            `open panel failed: ${error.message}${stderr ? ` ${stderr}` : ''} (execPath=${
              process.execPath
            })`
          )
          resolve(false)
          return
        }
        resolve(true)
      }
    )
  })
}

async function schedule(orca: OrcaWorkerApi): Promise<void> {
  try {
    const settings = await readSettings(orca)
    if (timer) clearInterval(timer)
    const minutes = Math.max(1, settings.refreshMinutes)
    timer = setInterval(() => {
      void refresh(orca, true).catch((err) => {
        orca.log(`scheduled refresh error: ${errorMessage(err)}`)
      })
    }, minutes * 60_000)

    // Re-apply status bar tone immediately when thresholds change
    const cached = await readCache(orca)
    if (cached) {
      await updateStatusBar(orca, cached, settings)
    }
  } catch (error) {
    orca.log(`schedule failed: ${errorMessage(error)}`)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('quota.get', async (input) => {
    const cached = await readCache(orca)
    if (cached && !input?.force) {
      void refresh(orca, false).catch((err) => {
        orca.log(`background refresh error: ${errorMessage(err)}`)
      })
      return cached
    }
    return refresh(orca, Boolean(input?.force))
  })

  orca.panels.handle('quota.refresh', async () => refresh(orca, true))

  orca.panels.handle('quota.openPanel', async () => {
    const opened = await openPanel(orca)
    return { opened }
  })

  orca.commands.register('gemini-quota.refresh', async () => {
    const snapshot = await refresh(orca, true)
    if (snapshot.error) return `Gemini 额度刷新失败：${snapshot.error}`
    const stats = computePoolStats(snapshot)
    const excludedNote =
      stats.geminiExcludedCount > 0 ? `，已排除 ${stats.geminiExcludedCount} 个无 G4` : ''
    const argonVal = stats.argonWeeklyAvg ?? stats.argonAvg
    const argonNote = argonVal != null ? ` · Argon 周平均 ${formatPercent(argonVal)}` : ''
    if (stats.gemini5hAvg != null || stats.geminiWeeklyAvg != null) {
      return `Gemini 4 额度：5h 平均 ${formatPercent(stats.gemini5hAvg)} · 周平均 ${formatPercent(
        stats.geminiWeeklyAvg
      )}${argonNote}（${stats.geminiEligibleCount} 个支持 G4 账号${excludedNote}）`
    }
    return `Gemini 4 额度：平均剩余 ${formatPercent(stats.geminiAvg)}${argonNote}（${stats.geminiEligibleCount}/${snapshot.summary.accounts} 个支持 G4 账号${excludedNote}）`
  })

  orca.commands.register('gemini-quota.open', async () => {
    const opened = await openPanel(orca)
    void refresh(orca, false).catch((err) => {
      orca.log(`open refresh error: ${errorMessage(err)}`)
    })
    return opened ? 'Gemini Quota 面板已打开' : '打开 Gemini Quota 面板失败，请查看插件日志'
  })

  settingsSubscription = orca.settings.onDidChange(() => {
    void schedule(orca)
  })

  // Paint immediately from sanitized cache if available, then refresh
  void (async () => {
    const [settings, cached] = await Promise.all([readSettings(orca), readCache(orca)])
    if (cached) {
      await updateStatusBar(orca, cached, settings)
    }
    await schedule(orca)
    await refresh(orca, false)
  })().catch((err) => {
    orca.log(`startup error: ${errorMessage(err)}`)
  })
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  settingsSubscription?.dispose()
  settingsSubscription = undefined
}

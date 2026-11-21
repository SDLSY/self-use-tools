export type QuotaModel = {
  model: string
  modelId?: string
  remainingFraction: number | null
  remainingPercent: number | null
  remainingPercentText: string
  resetTime: string | null
  resetTimeLocal: string | null
  tokenType?: string | null
}

export type QuotaBucket = {
  bucketId?: string | null
  displayName?: string | null
  window?: string | null
  remainingFraction: number | null
  remainingPercent?: number | null
  resetTime?: string | null
  description?: string | null
}

export type QuotaGroup = {
  displayName?: string | null
  description?: string | null
  buckets: QuotaBucket[]
}

export type CapabilityHints = {
  model_ids?: string[]
  endpoint?: string
  project_id?: string
  web_search_model_ids?: string[]
}

export type QuotaAccount = {
  account: string
  email?: string | null
  label?: string | null
  status: string
  reason?: string | null
  error?: string | null
  project?: string | null
  sourceHost?: string | null
  tokenExpiresAt?: string | null
  modelCount: number
  lowestRemainingPercent: number | null
  lowestRemainingText?: string | null
  nextResetTimeLocal: string | null
  models: QuotaModel[]
  capabilityHints?: CapabilityHints | null
  quotaGroups: QuotaGroup[]
  quotaSummaryDescription?: string | null
  quotaSummaryError?: {
    host?: string | null
    status?: number | null
    message?: string | null
  } | null
}

export type QuotaSummary = {
  accounts: number
  ok: number
  failed: number
  skipped: number
  models: number
  lowestRemainingPercent: number | null
}

export type QuotaSnapshot = {
  schema: string
  generatedAt: string
  collectedAtLocal?: string
  sshHost?: string | null
  proxy?: string | null
  fetchedAt: number
  exitCode: number
  summary: QuotaSummary
  accounts: QuotaAccount[]
  warnings: string[]
  error?: string
  stale?: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /** Cached snapshot, refreshed in the background when older than a minute. */
    'quota.get': { input: { force?: boolean } | undefined; output: QuotaSnapshot }
    /** Force a live query and answer with the new snapshot. */
    'quota.refresh': { output: QuotaSnapshot }
    /** Open this plugin's panel in Orca's sidebar. */
    'quota.openPanel': { output: { opened: boolean } }
  }

  interface PluginPanelEvents {
    'quota.changed': QuotaSnapshot
    'quota.refreshing': { at: number }
  }
}

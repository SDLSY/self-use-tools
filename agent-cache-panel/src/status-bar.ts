import type { OrcaWorkerApi } from 'orca/worker'
import type { CacheSnapshot, SessionCacheStats } from './protocol'
import { agentShortLabel } from './session-discovery'

const STATUS_ID = 'agent-cache'
const DEFAULT_METRIC = 'session'
const DEFAULT_REFRESH_SECONDS = 3
const DEFAULT_GOOD_ABOVE = 85
const DEFAULT_WARN_BELOW = 65

export type StatusMetric = 'session' | 'recent5' | 'latest'

export type Settings = {
  statusBarMetric: StatusMetric
  refreshSeconds: number
  goodAbove: number
  warnBelow: number
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(Math.round(n))
}

export async function readSettings(orca: OrcaWorkerApi): Promise<Settings> {
  try {
    const raw = ((await orca.settings.get()) || {}) as Record<string, unknown>
    const metricRaw = typeof raw.statusBarMetric === 'string' ? raw.statusBarMetric : DEFAULT_METRIC
    const statusBarMetric: StatusMetric =
      metricRaw === 'latest' || metricRaw === 'recent5' || metricRaw === 'session'
        ? metricRaw
        : DEFAULT_METRIC
    return {
      statusBarMetric,
      refreshSeconds: clamp(raw.refreshSeconds, DEFAULT_REFRESH_SECONDS, 2, 60),
      goodAbove: clamp(raw.goodAbove, DEFAULT_GOOD_ABOVE, 0, 100),
      warnBelow: clamp(raw.warnBelow, DEFAULT_WARN_BELOW, 0, 100)
    }
  } catch (error) {
    orca.log(`settings read failed: ${errorMessage(error)}`)
    return {
      statusBarMetric: DEFAULT_METRIC,
      refreshSeconds: DEFAULT_REFRESH_SECONDS,
      goodAbove: DEFAULT_GOOD_ABOVE,
      warnBelow: DEFAULT_WARN_BELOW
    }
  }
}

function metricValue(session: SessionCacheStats, metric: StatusMetric): number | null {
  if (!session.cacheTelemetryAvailable) return null
  if (metric === 'latest') return session.latestHitRate ?? session.sessionHitRate
  if (metric === 'recent5') return session.recent5HitRate ?? session.sessionHitRate
  return session.sessionHitRate
}

function metricLabel(metric: StatusMetric): string {
  if (metric === 'latest') return '最近 1 轮'
  if (metric === 'recent5') return '最近 5 轮'
  return '会话累计'
}

function toneForHitRate(
  rate: number | null,
  settings: Settings
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'neutral'
  if (rate >= settings.goodAbove) return 'success'
  if (rate >= settings.warnBelow) return 'warning'
  return 'danger'
}

export async function updateStatusBar(
  orca: OrcaWorkerApi,
  snapshot: CacheSnapshot,
  settings: Settings
): Promise<void> {
  try {
    const primary =
      snapshot.sessions.find((s) => s.id === snapshot.primarySessionId) || snapshot.sessions[0]
    if (!primary) {
      await orca.host.call('statusBar.update', {
        id: STATUS_ID,
        text: 'Cache —',
        tone: 'neutral',
        tooltip: '当前工作区没有打开的 Coding Agent / Bot 会话 · 点击打开面板'
      })
      return
    }

    const shortAgent = agentShortLabel(primary.agent, primary.agentLabel)

    if (!primary.cacheTelemetryAvailable) {
      await orca.host.call('statusBar.update', {
        id: STATUS_ID,
        text: `${shortAgent} Cache —`,
        tone: 'neutral',
        tooltip: `当前窗口：${primary.title} (${primary.model}) · ${primary.turnCount} 轮 · 本地库暂未记录缓存字段 · 点击打开面板`
      })
      return
    }

    const rate = metricValue(primary, settings.statusBarMetric)
    const text = `${shortAgent} ${formatPercent(rate)}`
    const focusPrefix = primary.focused ? '当前窗口' : '活跃窗口'
    const tooltipParts = [
      `${focusPrefix}：${primary.title} (${primary.agentLabel} · ${primary.model})`,
      `会话 ${formatPercent(primary.sessionHitRate)} · 近 5 轮 ${formatPercent(
        primary.recent5HitRate
      )} · 最近 ${formatPercent(primary.latestHitRate)}`,
      `${primary.turnCount} 轮 · 命中 ${formatTokens(primary.cacheReadTokens)} / ${formatTokens(
        primary.totalInputTokens
      )} · 主指标：${metricLabel(settings.statusBarMetric)} · 点击打开面板`
    ]
    const tooltip = tooltipParts.join(' | ').slice(0, 250)

    await orca.host.call('statusBar.update', {
      id: STATUS_ID,
      text,
      tone: toneForHitRate(rate, settings),
      tooltip
    })
  } catch (error) {
    orca.log(`statusBar.update failed: ${errorMessage(error)}`)
  }
}

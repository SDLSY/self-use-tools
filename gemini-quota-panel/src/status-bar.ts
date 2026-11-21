import type { OrcaWorkerApi } from 'orca/worker'
import type { QuotaSnapshot } from './protocol'
import type { Settings } from './quota-script-runner'
import { computePoolStats, minVal, type PoolStats } from './quota-stats'
import { errorMessage, formatPercent, formatTime } from './snapshot-sanitizer'

const STATUS_ID = 'gemini-quota'

export function statusTone(
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

export function formatStatusBarPayload(snapshot: QuotaSnapshot, settings: Settings) {
  const stats = computePoolStats(snapshot)
  const avg = stats.geminiAvg
  const argonVal = stats.argonWeeklyAvg ?? stats.argonAvg
  const updated = snapshot.collectedAtLocal
    ? snapshot.collectedAtLocal.slice(11, 16) || snapshot.collectedAtLocal
    : formatTime(snapshot.fetchedAt || Date.now())

  const argonSuffix = argonVal != null ? ` · Argon ${formatPercent(argonVal)}` : ''
  let text: string
  if (stats.gemini5hAvg != null && stats.geminiWeeklyAvg != null) {
    text = `Gemini 5h ${formatPercent(stats.gemini5hAvg)} · 周 ${formatPercent(
      stats.geminiWeeklyAvg
    )}${argonSuffix}`
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

  const summaryLine = `${
    parts.join(' · ') || 'Gemini Quota'
  } | ${acctParts.join('，')} · 更新于 ${updated} · 点击打开面板`
  const tooltipText = snapshot.error
    ? `Gemini 额度刷新失败：${snapshot.error}${snapshot.stale ? `（显示 ${updated} 缓存）` : ''}`
    : summaryLine
  const tooltip = tooltipText.length > 250 ? `${tooltipText.slice(0, 247)}...` : tooltipText

  return {
    id: STATUS_ID,
    text,
    tone: statusTone(snapshot, stats, settings),
    tooltip
  }
}

export async function updateStatusBar(
  orca: OrcaWorkerApi,
  snapshot: QuotaSnapshot,
  settings: Settings
): Promise<void> {
  try {
    await orca.host.call('statusBar.update', formatStatusBarPayload(snapshot, settings))
  } catch (error) {
    orca.log(`status bar update failed: ${errorMessage(error)}`)
  }
}

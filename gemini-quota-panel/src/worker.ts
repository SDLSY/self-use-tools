import type { OrcaWorkerApi } from 'orca/worker'
import type { QuotaSnapshot } from './protocol'
import { openQuotaPanel, readSettings, runQuotaScript } from './quota-script-runner'
import { computePoolStats } from './quota-stats'
import {
  errorMessage,
  failedSnapshot,
  formatPercent,
  sanitizeSnapshot
} from './snapshot-sanitizer'
import { updateStatusBar } from './status-bar'

const CACHE_KEY = 'quota.snapshot'
const CACHE_TTL_MS = 60_000

let timer: ReturnType<typeof setInterval> | undefined
let settingsSubscription: { dispose(): void } | undefined
let inFlight: Promise<QuotaSnapshot> | null = null

async function readCache(orca: OrcaWorkerApi): Promise<QuotaSnapshot | null> {
  try {
    const value = await orca.storage.get(CACHE_KEY)
    return sanitizeSnapshot(value)
  } catch (error) {
    orca.log(`quota cache read failed: ${errorMessage(error)}`)
    return null
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
      const snapshot: QuotaSnapshot = { ...fresh, fetchedAt: Date.now(), stale: false }
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

  orca.panels.handle('quota.openPanel', async () => ({ opened: await openQuotaPanel(orca) }))

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
    const opened = await openQuotaPanel(orca)
    void refresh(orca, false).catch((err) => {
      orca.log(`open refresh error: ${errorMessage(err)}`)
    })
    return opened ? 'Gemini Quota 面板已打开' : '打开 Gemini Quota 面板失败，请查看插件日志'
  })

  settingsSubscription = orca.settings.onDidChange(() => {
    void schedule(orca)
  })

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

import type { OrcaWorkerApi } from 'orca/worker'
import { openCachePanel } from './orca-cli-bridge'
import type { CacheSnapshot } from './protocol'
import { collectSnapshot, snapshotSignature } from './snapshot-collector'
import { errorMessage, formatPercent, readSettings, updateStatusBar } from './status-bar'

let pollTimer: ReturnType<typeof setInterval> | undefined
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let disposables: { dispose(): void }[] = []
let lastSnapshot: CacheSnapshot | null = null
let lastSignature = ''

async function refresh(orca: OrcaWorkerApi, forcePush = false): Promise<CacheSnapshot> {
  const [settings, snapshot] = await Promise.all([readSettings(orca), collectSnapshot(orca)])
  lastSnapshot = snapshot
  await updateStatusBar(orca, snapshot, settings)

  const sig = snapshotSignature(snapshot)
  if (forcePush || sig !== lastSignature) {
    lastSignature = sig
    try {
      orca.panels.post('cache.changed', snapshot)
    } catch {
      // Ignore if no panel is open.
    }
  }
  return snapshot
}

function scheduleSoon(orca: OrcaWorkerApi): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    void refresh(orca, false).catch((err) => {
      orca.log(`debounced refresh error: ${errorMessage(err)}`)
    })
  }, 400)
}

async function restartPoller(orca: OrcaWorkerApi): Promise<void> {
  const settings = await readSettings(orca)
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    void refresh(orca, false).catch((err) => {
      orca.log(`poll refresh error: ${errorMessage(err)}`)
    })
  }, settings.refreshSeconds * 1000)

  if (lastSnapshot) {
    await updateStatusBar(orca, lastSnapshot, settings)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  disposables.push(
    orca.panels.handle('cache.get', async (input) => {
      if (lastSnapshot && !input?.force) {
        scheduleSoon(orca)
        return lastSnapshot
      }
      return refresh(orca, true)
    }),
    orca.panels.handle('cache.refresh', async () => refresh(orca, true)),
    orca.panels.handle('cache.openPanel', async () => ({ opened: await openCachePanel(orca) })),
    orca.commands.register('agent-cache.refresh', async () => {
      const snap = await refresh(orca, true)
      const primary =
        snap.sessions.find((s) => s.id === snap.primarySessionId) || snap.sessions[0]
      if (!primary) return '当前工作区没有打开的 Coding Agent / Bot 会话'
      if (!primary.cacheTelemetryAvailable) {
        return `${primary.title}：共 ${primary.turnCount} 轮（本地库暂未记录缓存命中字段）`
      }
      return `${primary.title} 缓存命中率：会话 ${formatPercent(
        primary.sessionHitRate
      )} / 近 5 轮 ${formatPercent(primary.recent5HitRate)} / 最近 ${formatPercent(
        primary.latestHitRate
      )}`
    }),
    orca.commands.register('agent-cache.open', async () => {
      const opened = await openCachePanel(orca)
      scheduleSoon(orca)
      return opened ? 'Agent Cache 面板已打开' : '打开 Agent Cache 面板失败，请查看插件日志'
    }),
    orca.events.on('agent.status.changed', () => scheduleSoon(orca)),
    orca.events.on('workspace.changed', () => scheduleSoon(orca)),
    orca.settings.onDidChange(() => {
      void restartPoller(orca)
    })
  )

  void (async () => {
    await restartPoller(orca)
    await refresh(orca, true)
  })().catch((err) => {
    orca.log(`startup error: ${errorMessage(err)}`)
  })
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  for (const d of disposables) {
    try {
      d.dispose()
    } catch {
      // Ignore cleanup errors.
    }
  }
  disposables = []
}

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceInfo } from './protocol'
import { normalizePath } from './session-discovery'

export type FocusInfo = {
  focusedTerminalId: string | null
  terminalOrder: Map<string, number>
}

export type LiveChatAgent = {
  orcaSessionId: string
  worktreeId: string
  workspace: string
  agent: string
  state: string
  title: string
  updatedAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function resolveOrcaCli(): string {
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
      // Try next.
    }
  }
  return 'orca'
}

export function orcaCliEnv(): NodeJS.ProcessEnv {
  const profile = process.env.USERPROFILE || homedir()
  return {
    ...process.env,
    APPDATA: process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    USERPROFILE: profile,
    HOME: process.env.HOME || homedir()
  }
}

function findPaneHandle(
  node: unknown,
  activeLeafId: string | null,
  orderMap: Map<string, number>
): string | null {
  if (!node || typeof node !== 'object') return null
  const item = node as Record<string, unknown>

  if (item.type === 'terminal' && typeof item.handle === 'string') {
    if (!orderMap.has(item.handle)) orderMap.set(item.handle, orderMap.size)
    if (activeLeafId && item.leafId === activeLeafId) return item.handle
    if (!activeLeafId && item.active === true) return item.handle
    return null
  }

  let matched: string | null = null
  for (const childKey of ['children', 'panes']) {
    const val = item[childKey]
    if (Array.isArray(val)) {
      for (const child of val) {
        const hit = findPaneHandle(child, activeLeafId, orderMap)
        if (hit && !matched) matched = hit
      }
    } else if (val && typeof val === 'object') {
      const hit = findPaneHandle(val, activeLeafId, orderMap)
      if (hit && !matched) matched = hit
    }
  }
  return matched
}

function walkLayoutNode(
  node: unknown,
  orderMap: Map<string, number>,
  activeCandidates: string[]
): void {
  if (!node || typeof node !== 'object') return
  const item = node as Record<string, unknown>

  if (item.type === 'group' && Array.isArray(item.tabs)) {
    const activeTabId = typeof item.activeTabId === 'string' ? item.activeTabId : null
    for (const rawTab of item.tabs) {
      if (!rawTab || typeof rawTab !== 'object') continue
      const tab = rawTab as Record<string, unknown>
      const isActiveTab = activeTabId ? tab.tabId === activeTabId : item.tabs.length === 1
      const activeLeafId = typeof tab.activeLeafId === 'string' ? tab.activeLeafId : null
      const hit = findPaneHandle(tab.panes, isActiveTab ? activeLeafId : '__none__', orderMap)
      if (isActiveTab && hit) activeCandidates.push(hit)
    }
    return
  }

  if (Array.isArray(item.children)) {
    for (const child of item.children) {
      walkLayoutNode(child, orderMap, activeCandidates)
    }
  }
}

export function queryFocusedTerminal(
  orca: OrcaWorkerApi,
  workspacePath: string | null
): Promise<FocusInfo> {
  const empty: FocusInfo = { focusedTerminalId: null, terminalOrder: new Map() }
  const profile = process.env.USERPROFILE || homedir()
  const cli = resolveOrcaCli()

  return new Promise((resolve) => {
    execFile(
      cli,
      ['terminal', 'list', '--include-visual-layouts', '--json'],
      { windowsHide: true, timeout: 4000, cwd: profile, env: orcaCliEnv(), maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          orca.log(
            `queryFocusedTerminal failed (cli=${cli}): ${error ? error.message : 'empty stdout'} ${String(
              stderr || ''
            ).slice(0, 200)}`
          )
          resolve(empty)
          return
        }
        try {
          const parsed = JSON.parse(String(stdout)) as {
            ok?: boolean
            result?: {
              terminals?: { handle?: string; lastOutputAt?: number }[]
              visualLayouts?: { worktreePath?: string; root?: unknown }[]
            }
          }
          const result = parsed?.result
          const layouts = Array.isArray(result?.visualLayouts) ? result.visualLayouts : []
          if (!layouts.length) {
            resolve(empty)
            return
          }

          const targetNorm = workspacePath ? normalizePath(workspacePath) : null
          const layout = targetNorm
            ? layouts.find(
                (l) => typeof l.worktreePath === 'string' && normalizePath(l.worktreePath) === targetNorm
              )
            : layouts[0]
          if (!layout) {
            resolve(empty)
            return
          }

          const orderMap = new Map<string, number>()
          const activeCandidates: string[] = []
          walkLayoutNode(layout.root, orderMap, activeCandidates)

          let focusedTerminalId: string | null = null
          if (activeCandidates.length === 1) {
            focusedTerminalId = activeCandidates[0]
          } else if (activeCandidates.length > 1) {
            // Multiple split groups: pick the active candidate with most recent output.
            const outputByHandle = new Map<string, number>()
            for (const t of result?.terminals || []) {
              if (typeof t.handle === 'string') {
                outputByHandle.set(t.handle, Number(t.lastOutputAt) || 0)
              }
            }
            activeCandidates.sort(
              (a, b) => (outputByHandle.get(b) || 0) - (outputByHandle.get(a) || 0)
            )
            focusedTerminalId = activeCandidates[0]
          }

          resolve({ focusedTerminalId, terminalOrder: orderMap })
        } catch (parseErr) {
          orca.log(`queryFocusedTerminal parse failed: ${errorMessage(parseErr)}`)
          resolve(empty)
        }
      }
    )
  })
}

export function queryLiveChatAgents(orca: OrcaWorkerApi): Promise<LiveChatAgent[]> {
  const profile = process.env.USERPROFILE || homedir()
  const cli = resolveOrcaCli()
  return new Promise((resolve) => {
    execFile(
      cli,
      ['agent', 'list', '--json'],
      { windowsHide: true, timeout: 4000, cwd: profile, env: orcaCliEnv(), maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          orca.log(
            `queryLiveChatAgents failed: ${error ? error.message : 'empty stdout'} ${String(
              stderr || ''
            ).slice(0, 160)}`
          )
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(String(stdout)) as {
            ok?: boolean
            result?: { agents?: Record<string, unknown>[] }
          }
          const rows = Array.isArray(parsed?.result?.agents) ? parsed.result.agents : []
          const chats: LiveChatAgent[] = []
          for (const row of rows) {
            if (!row || row.kind !== 'chat') continue
            const worktreeId = typeof row.worktreeId === 'string' ? row.worktreeId : ''
            if (!worktreeId) continue
            chats.push({
              orcaSessionId: typeof row.orcaSessionId === 'string' ? row.orcaSessionId : '',
              worktreeId,
              workspace: typeof row.workspace === 'string' ? row.workspace : '',
              agent: typeof row.agent === 'string' ? row.agent : '',
              state: typeof row.state === 'string' ? row.state : 'done',
              title: typeof row.title === 'string' ? row.title : '',
              updatedAt: Number(row.updatedAt) || 0
            })
          }
          resolve(chats)
        } catch {
          resolve([])
        }
      }
    )
  })
}

export function chatMatchesWorkspace(chat: LiveChatAgent, workspace: WorkspaceInfo | null): boolean {
  if (!workspace) return false
  if (workspace.workspaceId && chat.worktreeId === workspace.workspaceId) return true
  if (workspace.path && chat.worktreeId.includes('::')) {
    const wtPath = chat.worktreeId.split('::').slice(1).join('::')
    if (normalizePath(wtPath) === normalizePath(workspace.path)) return true
  }
  return false
}

export function openCachePanel(orca: OrcaWorkerApi): Promise<boolean> {
  const profile = process.env.USERPROFILE || homedir()
  return new Promise((resolve) => {
    execFile(
      resolveOrcaCli(),
      ['plugin', 'open', 'local.agent-cache-panel', '--panel', 'agent-cache'],
      { windowsHide: true, timeout: 15_000, cwd: profile, env: orcaCliEnv() },
      (error, _stdout, stderr) => {
        if (error) {
          orca.log(`open panel failed: ${error.message}${stderr ? ` ${stderr}` : ''}`)
          resolve(false)
          return
        }
        resolve(true)
      }
    )
  })
}

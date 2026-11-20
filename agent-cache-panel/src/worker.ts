import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  parseAgyConversation,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseOpenCodeSession,
  parsePiTranscript
} from './parsers'
import type { AgentKind, CacheSnapshot, SessionCacheStats, WorkspaceInfo } from './protocol'

const STATUS_ID = 'agent-cache'
const DEFAULT_METRIC = 'session'
const DEFAULT_REFRESH_SECONDS = 3
const DEFAULT_GOOD_ABOVE = 85
const DEFAULT_WARN_BELOW = 65

type StatusMetric = 'session' | 'recent5' | 'latest'

type Settings = {
  statusBarMetric: StatusMetric
  refreshSeconds: number
  goodAbove: number
  warnBelow: number
}

type FocusInfo = {
  focusedTerminalId: string | null
  terminalOrder: Map<string, number>
}

type LiveChatAgent = {
  orcaSessionId: string
  worktreeId: string
  workspace: string
  agent: string
  state: string
  title: string
  updatedAt: number
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let disposables: { dispose(): void }[] = []
let lastSnapshot: CacheSnapshot | null = null
let lastSignature = ''

const sessionFileCache = new Map<string, string>()

function detectSystemTzOffsetMinutes(): number {
  if (process.platform === 'win32') {
    try {
      const regExe = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'reg.exe')
        : 'reg.exe'
      const out = execFileSync(
        regExe,
        [
          'query',
          'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation',
          '/v',
          'ActiveTimeBias'
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 }
      )
      const match = out.match(/0x([0-9a-f]+)/i)
      if (match) {
        let bias = parseInt(match[1], 16)
        if (bias > 0x7fffffff) bias -= 0x100000000
        if (Number.isFinite(bias) && Math.abs(bias) <= 840) return -bias
      }
    } catch {
      // Fall back to JS timezone offset.
    }
  }
  return -new Date().getTimezoneOffset()
}

const SYSTEM_TZ_OFFSET_MINUTES = detectSystemTzOffsetMinutes()

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function encodeClaudeProjectPath(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9-]/g, '-')
}

function encodePiProjectPath(workspacePath: string): string {
  const cleaned = workspacePath.replace(/:/g, '-').replace(/[\\/]/g, '-')
  return `--${cleaned}--`
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(Math.round(n))
}

async function readSettings(orca: OrcaWorkerApi): Promise<Settings> {
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

function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

function codexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions')
}

function piSessionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

function openCodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

function agyCliDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

function findClaudeSessionFile(sessionId: string, workspacePath: string | null): string | null {
  const cached = sessionFileCache.get(`claude:${sessionId}`)
  if (cached && existsSync(cached)) return cached

  const base = claudeProjectsDir()
  if (!existsSync(base)) return null

  if (workspacePath) {
    const direct = join(base, encodeClaudeProjectPath(workspacePath), `${sessionId}.jsonl`)
    if (existsSync(direct)) {
      sessionFileCache.set(`claude:${sessionId}`, direct)
      return direct
    }
  }

  try {
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const candidate = join(base, ent.name, `${sessionId}.jsonl`)
      if (existsSync(candidate)) {
        sessionFileCache.set(`claude:${sessionId}`, candidate)
        return candidate
      }
    }
  } catch {
    // Ignore permission errors.
  }
  return null
}

function findCodexSessionFile(sessionId: string): string | null {
  const cached = sessionFileCache.get(`codex:${sessionId}`)
  if (cached && existsSync(cached)) return cached

  const base = codexSessionsDir()
  if (!existsSync(base)) return null

  const targetSuffix = `${sessionId}.jsonl`
  try {
    const years = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
    for (const y of years) {
      const yDir = join(base, y)
      const months = readdirSync(yDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse()
      for (const m of months) {
        const mDir = join(yDir, m)
        const days = readdirSync(mDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse()
        for (const d of days) {
          const dDir = join(mDir, d)
          for (const fn of readdirSync(dDir)) {
            if (fn.endsWith(targetSuffix)) {
              const full = join(dDir, fn)
              sessionFileCache.set(`codex:${sessionId}`, full)
              return full
            }
          }
        }
      }
    }
  } catch {
    // Ignore scan errors.
  }
  return null
}

function findPiSessionFile(sessionId: string, workspacePath: string | null): string | null {
  const cached = sessionFileCache.get(`pi:${sessionId}`)
  if (cached && existsSync(cached)) return cached

  const base = piSessionsDir()
  if (!existsSync(base)) return null

  const targetSuffix = `${sessionId}.jsonl`
  const dirsToCheck: string[] = []
  if (workspacePath) {
    const directDir = join(base, encodePiProjectPath(workspacePath))
    if (existsSync(directDir)) dirsToCheck.push(directDir)
  }
  try {
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const fullDir = join(base, ent.name)
      if (!dirsToCheck.includes(fullDir)) dirsToCheck.push(fullDir)
    }
  } catch {
    return null
  }

  for (const dir of dirsToCheck) {
    try {
      for (const fn of readdirSync(dir)) {
        if (fn.endsWith(targetSuffix)) {
          const full = join(dir, fn)
          sessionFileCache.set(`pi:${sessionId}`, full)
          return full
        }
      }
    } catch {
      // Skip unreadable directory.
    }
  }
  return null
}

function normalizeAgentKind(raw: string | null | undefined): AgentKind {
  const value = String(raw || '').toLowerCase()
  if (value.includes('claude')) return 'claude'
  if (value.includes('codex')) return 'codex'
  if (value.includes('opencode')) return 'opencode'
  if (value === 'pi' || value.startsWith('pi-') || value.includes('pi-agent')) return 'pi'
  if (value.includes('antigravity') || value === 'agy') return 'antigravity'
  return 'other'
}

function agentDisplayLabel(kind: AgentKind, raw: string | null | undefined): string {
  switch (kind) {
    case 'claude':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'OpenCode'
    case 'pi':
      return 'Pi'
    case 'antigravity':
      return 'AGY'
    default:
      return raw ? String(raw) : 'Coding Agent'
  }
}

function agentShortLabel(kind: AgentKind, raw: string | null | undefined): string {
  switch (kind) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'OC'
    case 'pi':
      return 'Pi'
    case 'antigravity':
      return 'AGY'
    default:
      return raw ? String(raw).slice(0, 8) : 'Agent'
  }
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
      // Try next.
    }
  }
  return 'orca'
}

function orcaCliEnv(): NodeJS.ProcessEnv {
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

function queryFocusedTerminal(
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
            // Multiple split groups: pick the active candidate with most recent output
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

function queryLiveChatAgents(orca: OrcaWorkerApi): Promise<LiveChatAgent[]> {
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

function chatMatchesWorkspace(chat: LiveChatAgent, workspace: WorkspaceInfo | null): boolean {
  if (!workspace) return false
  if (workspace.workspaceId && chat.worktreeId === workspace.workspaceId) return true
  if (workspace.path && chat.worktreeId.includes('::')) {
    const wtPath = chat.worktreeId.split('::').slice(1).join('::')
    if (normalizePath(wtPath) === normalizePath(workspace.path)) return true
  }
  return false
}

async function resolveWorkspace(orca: OrcaWorkerApi): Promise<WorkspaceInfo | null> {
  try {
    const ctx = await orca.host.call('workspace.readContext')
    if (!ctx) return null
    let workspacePath: string | null = null
    if (ctx.workspaceId && orca.host.has('workspace.list')) {
      try {
        const list = await orca.host.call('workspace.list')
        const matched = list.workspaces.find((w) => w.id === ctx.workspaceId)
        if (matched?.path) workspacePath = matched.path
      } catch {
        // Optional enrichment.
      }
    }
    return {
      workspaceId: ctx.workspaceId ?? null,
      displayName: ctx.displayName || 'Workspace',
      branch: ctx.branch || null,
      path: workspacePath
    }
  } catch (error) {
    orca.log(`workspace.readContext failed: ${errorMessage(error)}`)
    return null
  }
}

async function collectSnapshot(orca: OrcaWorkerApi): Promise<CacheSnapshot> {
  const workspace = await resolveWorkspace(orca)
  const focusInfo = await queryFocusedTerminal(orca, workspace?.path ?? null)

  const sessions: SessionCacheStats[] = []
  const seenKeys = new Set<string>()
  const ocDb = openCodeDbPath()
  const agyDir = agyCliDir()

  // Show currently open coding agent windows & live Native Chat / Bot sessions in the focused workspace
  try {
    const params = workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : undefined
    const listed = await orca.host.call('agents.list', params)
    const liveAgents = Array.isArray(listed?.agents) ? listed.agents : []

    // Closed terminal panes also appear in agents.list with terminalId === null.
    // Cross-check with `orca agent list --json` (kind === 'chat') so only genuinely open
    // Native Chat / Bot sessions are kept and closed terminals are always excluded.
    const hasNullTerminalCandidates = liveAgents.some(
      (item) =>
        !(typeof item.terminalId === 'string' && item.terminalId) &&
        typeof item.sessionId === 'string' &&
        item.sessionId.length > 0
    )
    const unmatchedChats: LiveChatAgent[] = hasNullTerminalCandidates
      ? (await queryLiveChatAgents(orca)).filter((c) => chatMatchesWorkspace(c, workspace))
      : []

    for (const item of liveAgents) {
      const terminalId =
        typeof item.terminalId === 'string' && item.terminalId ? item.terminalId : null
      const sessionId =
        typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : null
      if (!terminalId && !sessionId) continue

      const kind = normalizeAgentKind(item.agent)

      let matchedChat: LiveChatAgent | null = null
      if (!terminalId) {
        let bestIdx = -1
        let bestDelta = Number.POSITIVE_INFINITY
        for (let i = 0; i < unmatchedChats.length; i++) {
          const candidate = unmatchedChats[i]
          if (normalizeAgentKind(candidate.agent) !== kind) continue
          const delta = Math.abs((candidate.updatedAt || 0) - (item.stateStartedAt || 0))
          if (delta < bestDelta) {
            bestDelta = delta
            bestIdx = i
          }
        }
        if (bestIdx === -1) {
          // No live Native Chat / Bot session matches this entry -> closed terminal ghost
          continue
        }
        matchedChat = unmatchedChats.splice(bestIdx, 1)[0]
      }

      let filePath = ''
      let parsed = null

      if (sessionId) {
        if (kind === 'opencode') {
          parsed = parseOpenCodeSession(ocDb, sessionId)
          filePath = ocDb
        } else if (kind === 'pi') {
          const fp = findPiSessionFile(sessionId, workspace?.path ?? null)
          if (fp) {
            filePath = fp
            parsed = parsePiTranscript(fp)
          }
        } else if (kind === 'antigravity') {
          const agyPath = join(agyDir, 'conversations', `${sessionId}.db`)
          if (existsSync(agyPath)) {
            filePath = agyPath
            parsed = parseAgyConversation(agyPath)
          }
        } else if (kind === 'claude') {
          const fp = findClaudeSessionFile(sessionId, workspace?.path ?? null)
          if (fp) {
            filePath = fp
            parsed = parseClaudeTranscript(fp)
          }
        } else if (kind === 'codex') {
          const fp = findCodexSessionFile(sessionId)
          if (fp) {
            filePath = fp
            parsed = parseCodexTranscript(fp)
          }
        } else {
          const fpC = findClaudeSessionFile(sessionId, workspace?.path ?? null)
          if (fpC) {
            filePath = fpC
            parsed = parseClaudeTranscript(fpC)
          }
          if (!parsed) {
            const fpX = findCodexSessionFile(sessionId)
            if (fpX) {
              filePath = fpX
              parsed = parseCodexTranscript(fpX)
            }
          }
          if (!parsed) {
            const fpP = findPiSessionFile(sessionId, workspace?.path ?? null)
            if (fpP) {
              filePath = fpP
              parsed = parsePiTranscript(fpP)
            }
          }
          if (!parsed && existsSync(ocDb)) {
            parsed = parseOpenCodeSession(ocDb, sessionId)
            if (parsed) filePath = ocDb
          }
          if (!parsed) {
            const agyPath = join(agyDir, 'conversations', `${sessionId}.db`)
            if (existsSync(agyPath)) {
              parsed = parseAgyConversation(agyPath)
              if (parsed) filePath = agyPath
            }
          }
        }
      }

      const resolvedKind = parsed?.agent ?? kind
      const key = terminalId ? `${resolvedKind}:${terminalId}` : `${resolvedKind}:chat:${sessionId}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)

      const isFocused = Boolean(
        terminalId && focusInfo.focusedTerminalId && focusInfo.focusedTerminalId === terminalId
      )

      const fallbackChatTitle =
        matchedChat?.title ||
        workspace?.displayName ||
        agentDisplayLabel(resolvedKind, item.agent)
      const title =
        item.title ||
        item.task?.title ||
        parsed?.title ||
        (terminalId ? agentDisplayLabel(resolvedKind, item.agent) : fallbackChatTitle)

      sessions.push({
        id: key,
        sessionId: sessionId || terminalId || key,
        agent: resolvedKind,
        agentLabel: agentDisplayLabel(resolvedKind, item.agent),
        title,
        terminalId,
        focused: isFocused,
        state: item.state || 'waiting',
        live: true,
        model: parsed?.model || agentDisplayLabel(resolvedKind, item.agent),
        filePath,
        updatedAt: parsed?.updatedAt || item.stateStartedAt || Date.now(),
        turnCount: parsed?.turnCount ?? 0,
        totalInputTokens: parsed?.totalInputTokens ?? 0,
        cacheReadTokens: parsed?.cacheReadTokens ?? 0,
        cacheCreateTokens: parsed?.cacheCreateTokens ?? 0,
        uncachedInputTokens: parsed?.uncachedInputTokens ?? 0,
        outputTokens: parsed?.outputTokens ?? 0,
        sessionHitRate: parsed?.sessionHitRate ?? null,
        recent5HitRate: parsed?.recent5HitRate ?? null,
        latestHitRate: parsed?.latestHitRate ?? null,
        largeMissCount: parsed?.largeMissCount ?? 0,
        largeMissTokens: parsed?.largeMissTokens ?? 0,
        cacheTelemetryAvailable: parsed ? parsed.cacheTelemetryAvailable : true,
        telemetryNote: parsed?.telemetryNote ?? null,
        turns: parsed?.turns ?? []
      })
    }
  } catch (error) {
    orca.log(`agents.list failed: ${errorMessage(error)}`)
  }

  // Disambiguate duplicate titles among multiple Native Chat / Bot sessions in one workspace
  const titleCounts = new Map<string, number>()
  for (const s of sessions) {
    titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1)
  }
  const titleSeen = new Map<string, number>()
  for (const s of sessions) {
    if ((titleCounts.get(s.title) || 0) > 1 && !s.terminalId) {
      const idx = (titleSeen.get(s.title) || 0) + 1
      titleSeen.set(s.title, idx)
      s.title = `${s.title} #${idx}`
    }
  }

  // Keep chips in Orca's visual tab order so tabs don't jump around when switching focus
  sessions.sort((a, b) => {
    const ordA =
      a.terminalId && focusInfo.terminalOrder.has(a.terminalId)
        ? focusInfo.terminalOrder.get(a.terminalId)!
        : 999
    const ordB =
      b.terminalId && focusInfo.terminalOrder.has(b.terminalId)
        ? focusInfo.terminalOrder.get(b.terminalId)!
        : 999
    if (ordA !== ordB) return ordA - ordB
    return b.updatedAt - a.updatedAt
  })

  const focusedSession = sessions.find((s) => s.focused) || null
  const primarySession =
    focusedSession ||
    sessions.find((s) => s.state === 'working') ||
    sessions[0] ||
    null

  return {
    fetchedAt: Date.now(),
    tzOffsetMinutes: SYSTEM_TZ_OFFSET_MINUTES,
    workspace,
    focusedSessionId: focusedSession?.id ?? null,
    primarySessionId: primarySession?.id ?? null,
    sessions
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

async function updateStatusBar(
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

function snapshotSignature(snapshot: CacheSnapshot): string {
  return JSON.stringify({
    w: snapshot.workspace?.workspaceId,
    f: snapshot.focusedSessionId,
    p: snapshot.primarySessionId,
    s: snapshot.sessions.map((s) => [
      s.id,
      s.focused,
      s.state,
      s.turnCount,
      s.totalInputTokens,
      s.cacheReadTokens,
      s.outputTokens,
      s.updatedAt
    ])
  })
}

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

function openPanel(orca: OrcaWorkerApi): Promise<boolean> {
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
    orca.panels.handle('cache.openPanel', async () => ({ opened: await openPanel(orca) })),
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
      const opened = await openPanel(orca)
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

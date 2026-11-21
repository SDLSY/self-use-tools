export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'antigravity' | 'other'

export type CacheTurn = {
  index: number
  timestamp: number | null
  model: string
  inputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  totalInputTokens: number
  outputTokens: number
  hitRate: number | null
}

export type SessionCacheStats = {
  id: string
  sessionId: string
  agent: AgentKind
  agentLabel: string
  title: string
  terminalId: string | null
  focused: boolean
  state: 'working' | 'blocked' | 'waiting' | 'done' | 'idle'
  live: boolean
  model: string
  filePath: string
  updatedAt: number
  turnCount: number
  totalInputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  uncachedInputTokens: number
  outputTokens: number
  sessionHitRate: number | null
  recent5HitRate: number | null
  latestHitRate: number | null
  largeMissCount: number
  largeMissTokens: number
  cacheTelemetryAvailable: boolean
  telemetryNote: string | null
  turns: CacheTurn[]
}

export type WorkspaceInfo = {
  workspaceId: string | null
  displayName: string
  branch: string | null
  path: string | null
}

export type CacheSnapshot = {
  fetchedAt: number
  tzOffsetMinutes: number
  workspace: WorkspaceInfo | null
  focusedSessionId: string | null
  primarySessionId: string | null
  sessions: SessionCacheStats[]
  error?: string
}

declare module 'orca' {
  interface PluginRequests {
    'cache.get': { input: { force?: boolean } | undefined; output: CacheSnapshot }
    'cache.refresh': { output: CacheSnapshot }
    'cache.openPanel': { output: { opened: boolean } }
  }

  interface PluginPanelEvents {
    'cache.changed': CacheSnapshot
  }
}

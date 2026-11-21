import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  chatMatchesWorkspace,
  queryFocusedTerminal,
  queryLiveChatAgents,
  type LiveChatAgent
} from './orca-cli-bridge'
import type { CacheSnapshot, SessionCacheStats, WorkspaceInfo } from './protocol'
import { agentDisplayLabel, normalizeAgentKind, parseAgentSession } from './session-discovery'
import { errorMessage } from './status-bar'

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

export async function collectSnapshot(orca: OrcaWorkerApi): Promise<CacheSnapshot> {
  const workspace = await resolveWorkspace(orca)
  const focusInfo = await queryFocusedTerminal(orca, workspace?.path ?? null)

  const sessions: SessionCacheStats[] = []
  const seenKeys = new Set<string>()

  try {
    const params = workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : undefined
    const listed = await orca.host.call('agents.list', params)
    const liveAgents = Array.isArray(listed?.agents) ? listed.agents : []

    // Closed terminals also appear with terminalId === null; cross-check against `orca agent list`
    // so only genuinely live Native Chat / Bot sessions are kept.
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
        if (bestIdx === -1) continue
        matchedChat = unmatchedChats.splice(bestIdx, 1)[0]
      }

      const { filePath, parsed } = sessionId
        ? parseAgentSession(kind, sessionId, workspace?.path ?? null)
        : { filePath: '', parsed: null }

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

  // Keep chips in Orca's visual tab order so tabs don't jump when switching focus.
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

export function snapshotSignature(snapshot: CacheSnapshot): string {
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

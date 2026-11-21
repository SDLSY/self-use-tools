import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  parseAgyConversation,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseOpenCodeSession,
  parsePiTranscript,
  type ParsedSessionData
} from './parsers'
import type { AgentKind } from './protocol'

const sessionFileCache = new Map<string, string>()

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function encodeClaudeProjectPath(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9-]/g, '-')
}

function encodePiProjectPath(workspacePath: string): string {
  const cleaned = workspacePath.replace(/:/g, '-').replace(/[\\/]/g, '-')
  return `--${cleaned}--`
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

export function openCodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

export function agyCliDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

export function findClaudeSessionFile(
  sessionId: string,
  workspacePath: string | null
): string | null {
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

export function findCodexSessionFile(sessionId: string): string | null {
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

export function findPiSessionFile(
  sessionId: string,
  workspacePath: string | null
): string | null {
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

export function normalizeAgentKind(raw: string | null | undefined): AgentKind {
  const value = String(raw || '').toLowerCase()
  if (value.includes('claude')) return 'claude'
  if (value.includes('codex')) return 'codex'
  if (value.includes('opencode')) return 'opencode'
  if (value === 'pi' || value.startsWith('pi-') || value.includes('pi-agent')) return 'pi'
  if (value.includes('antigravity') || value === 'agy') return 'antigravity'
  return 'other'
}

export function agentDisplayLabel(kind: AgentKind, raw: string | null | undefined): string {
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

export function agentShortLabel(kind: AgentKind, raw: string | null | undefined): string {
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

export function parseAgentSession(
  kind: AgentKind,
  sessionId: string,
  workspacePath: string | null
): { filePath: string; parsed: ParsedSessionData | null } {
  const ocDb = openCodeDbPath()
  const agyDir = agyCliDir()

  if (kind === 'opencode') {
    return { filePath: ocDb, parsed: parseOpenCodeSession(ocDb, sessionId) }
  }
  if (kind === 'pi') {
    const fp = findPiSessionFile(sessionId, workspacePath)
    return fp ? { filePath: fp, parsed: parsePiTranscript(fp) } : { filePath: '', parsed: null }
  }
  if (kind === 'antigravity') {
    const agyPath = join(agyDir, 'conversations', `${sessionId}.db`)
    return existsSync(agyPath)
      ? { filePath: agyPath, parsed: parseAgyConversation(agyPath) }
      : { filePath: '', parsed: null }
  }
  if (kind === 'claude') {
    const fp = findClaudeSessionFile(sessionId, workspacePath)
    return fp
      ? { filePath: fp, parsed: parseClaudeTranscript(fp) }
      : { filePath: '', parsed: null }
  }
  if (kind === 'codex') {
    const fp = findCodexSessionFile(sessionId)
    return fp
      ? { filePath: fp, parsed: parseCodexTranscript(fp) }
      : { filePath: '', parsed: null }
  }

  const fpC = findClaudeSessionFile(sessionId, workspacePath)
  if (fpC) {
    const parsed = parseClaudeTranscript(fpC)
    if (parsed) return { filePath: fpC, parsed }
  }
  const fpX = findCodexSessionFile(sessionId)
  if (fpX) {
    const parsed = parseCodexTranscript(fpX)
    if (parsed) return { filePath: fpX, parsed }
  }
  const fpP = findPiSessionFile(sessionId, workspacePath)
  if (fpP) {
    const parsed = parsePiTranscript(fpP)
    if (parsed) return { filePath: fpP, parsed }
  }
  if (existsSync(ocDb)) {
    const parsed = parseOpenCodeSession(ocDb, sessionId)
    if (parsed) return { filePath: ocDb, parsed }
  }
  const agyPath = join(agyDir, 'conversations', `${sessionId}.db`)
  if (existsSync(agyPath)) {
    const parsed = parseAgyConversation(agyPath)
    if (parsed) return { filePath: agyPath, parsed }
  }
  return { filePath: '', parsed: null }
}

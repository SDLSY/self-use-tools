import { closeSync, openSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AgentKind, CacheTurn } from '../protocol'

export type ParsedSessionData = {
  agent: AgentKind
  model: string
  title?: string
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
  telemetryNote?: string
  turns: CacheTurn[]
}

export type SqliteStmt = {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
}

export type SqliteDb = {
  prepare(sql: string): SqliteStmt
  close(): void
}

export type DatabaseSyncCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDb

export const MAX_STORED_TURNS = 40
export const LARGE_MISS_TOKENS_THRESHOLD = 25_000
export const LARGE_MISS_HIT_THRESHOLD = 20

let sqliteCtorLoaded = false
let DatabaseSyncRef: DatabaseSyncCtor | null = null
const cacheResetters: (() => void)[] = []

export function registerParserCacheReset(fn: () => void): void {
  cacheResetters.push(fn)
}

export function clearAllParserCaches(): void {
  for (const reset of cacheResetters) reset()
}

export function getDatabaseSync(): DatabaseSyncCtor | null {
  if (sqliteCtorLoaded) return DatabaseSyncRef
  sqliteCtorLoaded = true
  try {
    const req = createRequire(import.meta.url)
    const mod = req('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor }
    DatabaseSyncRef = mod?.DatabaseSync ?? null
  } catch {
    DatabaseSyncRef = null
  }
  return DatabaseSyncRef
}

export function readSlice(filePath: string, start: number, end: number): string {
  const length = Math.max(0, end - start)
  if (length === 0) return ''
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function calcRate(cacheRead: number, totalInput: number): number | null {
  if (totalInput <= 0) return null
  return Math.max(0, Math.min(100, (cacheRead / totalInput) * 100))
}

export function computeRollingRate(turns: CacheTurn[], count: number): number | null {
  if (!turns.length) return null
  const slice = turns.slice(-count)
  let cr = 0
  let ti = 0
  for (const t of slice) {
    cr += t.cacheReadTokens
    ti += t.totalInputTokens
  }
  return calcRate(cr, ti)
}

export function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

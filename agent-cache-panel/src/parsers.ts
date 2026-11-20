import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AgentKind, CacheTurn } from './protocol'

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

type SqliteStmt = {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
}

type SqliteDb = {
  prepare(sql: string): SqliteStmt
  close(): void
}

type DatabaseSyncCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDb

let sqliteCtorLoaded = false
let DatabaseSyncRef: DatabaseSyncCtor | null = null

function getDatabaseSync(): DatabaseSyncCtor | null {
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

type ClaudeTurnRecord = {
  id: string
  ts: number | null
  model: string
  input: number
  cacheCreate: number
  cacheRead: number
  out: number
}

type ClaudeCacheEntry = {
  kind: 'claude'
  size: number
  mtimeMs: number
  byteOffset: number
  remainder: string
  turnsById: Map<string, ClaudeTurnRecord>
  order: string[]
  lastModel: string
  result: ParsedSessionData
}

type CodexCacheEntry = {
  kind: 'codex'
  size: number
  mtimeMs: number
  byteOffset: number
  remainder: string
  lastModel: string
  lastTotalTokensSeen: number
  totalInput: number
  totalCacheRead: number
  totalCacheCreate: number
  totalOutput: number
  turns: CacheTurn[]
  result: ParsedSessionData
}

type PiCacheEntry = {
  kind: 'pi'
  size: number
  mtimeMs: number
  byteOffset: number
  remainder: string
  lastModel: string
  totalInput: number
  totalCacheRead: number
  totalCacheCreate: number
  totalOutput: number
  largeMissCount: number
  largeMissTokens: number
  turnCount: number
  turns: CacheTurn[]
  result: ParsedSessionData
}

type SimpleCacheEntry = {
  kind: 'opencode' | 'antigravity'
  stamp: string
  result: ParsedSessionData
}

type CacheEntry = ClaudeCacheEntry | CodexCacheEntry | PiCacheEntry | SimpleCacheEntry

const MAX_STORED_TURNS = 40
const CODEX_INITIAL_TAIL_BYTES = 4 * 1024 * 1024
const LARGE_MISS_TOKENS_THRESHOLD = 25_000
const LARGE_MISS_HIT_THRESHOLD = 20

const fileCache = new Map<string, CacheEntry>()

function readSlice(filePath: string, start: number, end: number): string {
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

function calcRate(cacheRead: number, totalInput: number): number | null {
  if (totalInput <= 0) return null
  return Math.max(0, Math.min(100, (cacheRead / totalInput) * 100))
}

function computeRollingRate(turns: CacheTurn[], count: number): number | null {
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

/* ============================ Claude Code ============================ */

function buildClaudeResult(entry: ClaudeCacheEntry): ParsedSessionData {
  let sumIn = 0
  let sumCC = 0
  let sumCR = 0
  let sumOut = 0
  let largeMissCount = 0
  let largeMissTokens = 0

  const allTurns: CacheTurn[] = []
  let idx = 0
  for (const id of entry.order) {
    const rec = entry.turnsById.get(id)
    if (!rec) continue
    idx += 1
    const totalInput = rec.input + rec.cacheCreate + rec.cacheRead
    const hitRate = calcRate(rec.cacheRead, totalInput)
    sumIn += rec.input
    sumCC += rec.cacheCreate
    sumCR += rec.cacheRead
    sumOut += rec.out

    if (
      rec.input >= LARGE_MISS_TOKENS_THRESHOLD &&
      (hitRate == null || hitRate < LARGE_MISS_HIT_THRESHOLD)
    ) {
      largeMissCount += 1
      largeMissTokens += rec.input
    }

    allTurns.push({
      index: idx,
      timestamp: rec.ts,
      model: rec.model,
      inputTokens: rec.input,
      cacheReadTokens: rec.cacheRead,
      cacheCreateTokens: rec.cacheCreate,
      totalInputTokens: totalInput,
      outputTokens: rec.out,
      hitRate
    })
  }

  const totalInputTokens = sumIn + sumCC + sumCR
  const recentTurns = allTurns.slice(-MAX_STORED_TURNS)
  const latest = allTurns.length ? allTurns[allTurns.length - 1] : null

  return {
    agent: 'claude',
    model: latest?.model || entry.lastModel || 'claude',
    updatedAt: latest?.timestamp || entry.mtimeMs,
    turnCount: allTurns.length,
    totalInputTokens,
    cacheReadTokens: sumCR,
    cacheCreateTokens: sumCC,
    uncachedInputTokens: sumIn,
    outputTokens: sumOut,
    sessionHitRate: calcRate(sumCR, totalInputTokens),
    recent5HitRate: computeRollingRate(allTurns, 5),
    latestHitRate: latest ? latest.hitRate : null,
    largeMissCount,
    largeMissTokens,
    cacheTelemetryAvailable: true,
    turns: recentTurns
  }
}

function ingestClaudeChunk(entry: ClaudeCacheEntry, chunk: string): void {
  const combined = entry.remainder + chunk
  const lines = combined.split('\n')
  entry.remainder = lines.pop() ?? ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || !line.includes('"usage"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'assistant') continue
    const msg = obj.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (!msg || !usage) continue

    const input = Math.max(0, Number(usage.input_tokens) || 0)
    const cacheCreate = Math.max(0, Number(usage.cache_creation_input_tokens) || 0)
    const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0)
    const out = Math.max(0, Number(usage.output_tokens) || 0)
    if (input + cacheCreate + cacheRead + out === 0) continue

    const id =
      (typeof msg.id === 'string' && msg.id) ||
      (typeof obj.uuid === 'string' && obj.uuid) ||
      `turn-${entry.order.length + 1}`
    const model = typeof msg.model === 'string' && msg.model ? msg.model : entry.lastModel
    if (model) entry.lastModel = model
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    const timestamp = Number.isFinite(ts) ? ts : null

    const prev = entry.turnsById.get(id)
    if (!prev) {
      entry.order.push(id)
      entry.turnsById.set(id, { id, ts: timestamp, model, input, cacheCreate, cacheRead, out })
    } else if (out >= prev.out || input + cacheRead >= prev.input + prev.cacheRead) {
      prev.ts = timestamp ?? prev.ts
      prev.model = model || prev.model
      prev.input = input
      prev.cacheCreate = cacheCreate
      prev.cacheRead = cacheRead
      prev.out = out
    }
  }
}

export function parseClaudeTranscript(filePath: string): ParsedSessionData | null {
  let st
  try {
    st = statSync(filePath)
  } catch {
    fileCache.delete(filePath)
    return null
  }

  const cached = fileCache.get(filePath)
  if (
    cached &&
    cached.kind === 'claude' &&
    cached.size === st.size &&
    cached.mtimeMs === st.mtimeMs
  ) {
    return cached.result
  }

  let entry: ClaudeCacheEntry
  if (cached && cached.kind === 'claude' && st.size >= cached.byteOffset) {
    entry = cached
  } else {
    entry = {
      kind: 'claude',
      size: 0,
      mtimeMs: 0,
      byteOffset: 0,
      remainder: '',
      turnsById: new Map(),
      order: [],
      lastModel: '',
      result: null as unknown as ParsedSessionData
    }
  }

  const CHUNK_SIZE = 2 * 1024 * 1024
  let pos = entry.byteOffset
  while (pos < st.size) {
    const next = Math.min(st.size, pos + CHUNK_SIZE)
    ingestClaudeChunk(entry, readSlice(filePath, pos, next))
    pos = next
  }

  if (entry.remainder.trim().startsWith('{') && entry.remainder.trim().endsWith('}')) {
    const trailing = entry.remainder
    entry.remainder = ''
    ingestClaudeChunk(entry, trailing + '\n')
  }

  entry.size = st.size
  entry.mtimeMs = st.mtimeMs
  entry.byteOffset = st.size
  entry.result = buildClaudeResult(entry)
  fileCache.set(filePath, entry)
  return entry.result
}

/* ============================ Codex CLI ============================ */

function buildCodexResult(entry: CodexCacheEntry): ParsedSessionData {
  const recentTurns = entry.turns.slice(-MAX_STORED_TURNS)
  const latest = entry.turns.length ? entry.turns[entry.turns.length - 1] : null
  const totalInput = entry.totalInput
  const cacheRead = Math.min(entry.totalCacheRead, totalInput)
  const cacheCreate = entry.totalCacheCreate
  const uncached = Math.max(0, totalInput - cacheRead - cacheCreate)

  let largeMissCount = 0
  let largeMissTokens = 0
  for (const t of recentTurns) {
    if (
      t.inputTokens >= LARGE_MISS_TOKENS_THRESHOLD &&
      (t.hitRate == null || t.hitRate < LARGE_MISS_HIT_THRESHOLD)
    ) {
      largeMissCount += 1
      largeMissTokens += t.inputTokens
    }
  }

  return {
    agent: 'codex',
    model: entry.lastModel || 'codex',
    updatedAt: latest?.timestamp || entry.mtimeMs,
    turnCount: entry.turns.length,
    totalInputTokens: totalInput,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    uncachedInputTokens: uncached,
    outputTokens: entry.totalOutput,
    sessionHitRate: calcRate(cacheRead, totalInput),
    recent5HitRate: computeRollingRate(recentTurns, 5),
    latestHitRate: latest ? latest.hitRate : null,
    largeMissCount,
    largeMissTokens,
    cacheTelemetryAvailable: true,
    turns: recentTurns
  }
}

function ingestCodexChunk(entry: CodexCacheEntry, chunk: string): void {
  const combined = entry.remainder + chunk
  const lines = combined.split('\n')
  entry.remainder = lines.pop() ?? ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (
      !line.includes('"token_count"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"session_meta"')
    ) {
      continue
    }
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = obj.payload as Record<string, unknown> | undefined
    if (!payload) continue

    if (
      (obj.type === 'turn_context' || obj.type === 'session_meta') &&
      typeof payload.model === 'string' &&
      payload.model
    ) {
      entry.lastModel = payload.model
      continue
    }

    if (obj.type !== 'event_msg' || payload.type !== 'token_count') continue
    const info = payload.info as Record<string, unknown> | undefined
    if (!info) continue

    const tot = info.total_token_usage as Record<string, unknown> | undefined
    const last = info.last_token_usage as Record<string, unknown> | undefined
    if (!tot || !last) continue

    const totalTok = Number(tot.total_tokens) || 0
    if (totalTok <= 0 || totalTok === entry.lastTotalTokensSeen) continue
    entry.lastTotalTokensSeen = totalTok

    entry.totalInput = Math.max(0, Number(tot.input_tokens) || 0)
    entry.totalCacheRead = Math.max(0, Number(tot.cached_input_tokens) || 0)
    entry.totalCacheCreate = Math.max(0, Number(tot.cache_write_input_tokens) || 0)
    entry.totalOutput = Math.max(0, Number(tot.output_tokens) || 0)

    const turnTotalIn = Math.max(0, Number(last.input_tokens) || 0)
    const turnCacheRead = Math.min(turnTotalIn, Math.max(0, Number(last.cached_input_tokens) || 0))
    const turnCacheCreate = Math.max(0, Number(last.cache_write_input_tokens) || 0)
    const turnUncached = Math.max(0, turnTotalIn - turnCacheRead - turnCacheCreate)
    const turnOut = Math.max(0, Number(last.output_tokens) || 0)
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN

    entry.turns.push({
      index: entry.turns.length + 1,
      timestamp: Number.isFinite(ts) ? ts : null,
      model: entry.lastModel || 'codex',
      inputTokens: turnUncached,
      cacheReadTokens: turnCacheRead,
      cacheCreateTokens: turnCacheCreate,
      totalInputTokens: turnTotalIn,
      outputTokens: turnOut,
      hitRate: calcRate(turnCacheRead, turnTotalIn)
    })

    if (entry.turns.length > MAX_STORED_TURNS * 3) {
      entry.turns = entry.turns.slice(-MAX_STORED_TURNS)
    }
  }
}

export function parseCodexTranscript(filePath: string): ParsedSessionData | null {
  let st
  try {
    st = statSync(filePath)
  } catch {
    fileCache.delete(filePath)
    return null
  }

  const cached = fileCache.get(filePath)
  if (
    cached &&
    cached.kind === 'codex' &&
    cached.size === st.size &&
    cached.mtimeMs === st.mtimeMs
  ) {
    return cached.result
  }

  let entry: CodexCacheEntry
  if (cached && cached.kind === 'codex' && st.size >= cached.byteOffset) {
    entry = cached
  } else {
    const startOffset =
      st.size > CODEX_INITIAL_TAIL_BYTES ? st.size - CODEX_INITIAL_TAIL_BYTES : 0
    entry = {
      kind: 'codex',
      size: 0,
      mtimeMs: 0,
      byteOffset: startOffset,
      remainder: '',
      lastModel: '',
      lastTotalTokensSeen: -1,
      totalInput: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalOutput: 0,
      turns: [],
      result: null as unknown as ParsedSessionData
    }
    if (startOffset > 0) {
      const head = readSlice(filePath, startOffset, Math.min(st.size, startOffset + 65536))
      const nl = head.indexOf('\n')
      if (nl >= 0) {
        entry.byteOffset = startOffset + Buffer.byteLength(head.slice(0, nl + 1), 'utf8')
      }
    }
  }

  const CHUNK_SIZE = 2 * 1024 * 1024
  let pos = entry.byteOffset
  while (pos < st.size) {
    const next = Math.min(st.size, pos + CHUNK_SIZE)
    ingestCodexChunk(entry, readSlice(filePath, pos, next))
    pos = next
  }

  if (entry.remainder.trim().startsWith('{') && entry.remainder.trim().endsWith('}')) {
    const trailing = entry.remainder
    entry.remainder = ''
    ingestCodexChunk(entry, trailing + '\n')
  }

  entry.size = st.size
  entry.mtimeMs = st.mtimeMs
  entry.byteOffset = st.size
  entry.result = buildCodexResult(entry)
  fileCache.set(filePath, entry)
  return entry.result
}

/* ============================ Pi Agent ============================ */

function buildPiResult(entry: PiCacheEntry): ParsedSessionData {
  const recentTurns = entry.turns.slice(-MAX_STORED_TURNS)
  const latest = entry.turns.length ? entry.turns[entry.turns.length - 1] : null
  const totalInput = entry.totalInput + entry.totalCacheRead + entry.totalCacheCreate

  return {
    agent: 'pi',
    model: latest?.model || entry.lastModel || 'pi',
    updatedAt: latest?.timestamp || entry.mtimeMs,
    turnCount: entry.turnCount,
    totalInputTokens: totalInput,
    cacheReadTokens: entry.totalCacheRead,
    cacheCreateTokens: entry.totalCacheCreate,
    uncachedInputTokens: entry.totalInput,
    outputTokens: entry.totalOutput,
    sessionHitRate: calcRate(entry.totalCacheRead, totalInput),
    recent5HitRate: computeRollingRate(recentTurns, 5),
    latestHitRate: latest ? latest.hitRate : null,
    largeMissCount: entry.largeMissCount,
    largeMissTokens: entry.largeMissTokens,
    cacheTelemetryAvailable: true,
    turns: recentTurns
  }
}

function ingestPiChunk(entry: PiCacheEntry, chunk: string): void {
  const combined = entry.remainder + chunk
  const lines = combined.split('\n')
  entry.remainder = lines.pop() ?? ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || !line.includes('"usage"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'message') continue
    const msg = obj.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'assistant' || !usage) continue

    const input = Math.max(0, Number(usage.input) || 0)
    const cacheRead = Math.max(0, Number(usage.cacheRead) || 0)
    const cacheCreate = Math.max(0, Number(usage.cacheWrite) || 0)
    const out = Math.max(0, Number(usage.output) || 0)
    const totalIn = input + cacheRead + cacheCreate
    if (totalIn + out === 0) continue

    const model = typeof msg.model === 'string' && msg.model ? msg.model : entry.lastModel
    if (model) entry.lastModel = model
    const rawTs = typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(String(obj.timestamp || ''))
    const timestamp = Number.isFinite(rawTs) ? rawTs : null

    entry.turnCount += 1
    entry.totalInput += input
    entry.totalCacheRead += cacheRead
    entry.totalCacheCreate += cacheCreate
    entry.totalOutput += out

    const hitRate = calcRate(cacheRead, totalIn)
    if (input >= LARGE_MISS_TOKENS_THRESHOLD && (hitRate == null || hitRate < LARGE_MISS_HIT_THRESHOLD)) {
      entry.largeMissCount += 1
      entry.largeMissTokens += input
    }

    entry.turns.push({
      index: entry.turnCount,
      timestamp,
      model: model || 'pi',
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
      totalInputTokens: totalIn,
      outputTokens: out,
      hitRate
    })

    if (entry.turns.length > MAX_STORED_TURNS * 3) {
      entry.turns = entry.turns.slice(-MAX_STORED_TURNS)
    }
  }
}

export function parsePiTranscript(filePath: string): ParsedSessionData | null {
  let st
  try {
    st = statSync(filePath)
  } catch {
    fileCache.delete(filePath)
    return null
  }

  const cached = fileCache.get(filePath)
  if (cached && cached.kind === 'pi' && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.result
  }

  let entry: PiCacheEntry
  if (cached && cached.kind === 'pi' && st.size >= cached.byteOffset) {
    entry = cached
  } else {
    entry = {
      kind: 'pi',
      size: 0,
      mtimeMs: 0,
      byteOffset: 0,
      remainder: '',
      lastModel: '',
      totalInput: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalOutput: 0,
      largeMissCount: 0,
      largeMissTokens: 0,
      turnCount: 0,
      turns: [],
      result: null as unknown as ParsedSessionData
    }
  }

  const CHUNK_SIZE = 2 * 1024 * 1024
  let pos = entry.byteOffset
  while (pos < st.size) {
    const next = Math.min(st.size, pos + CHUNK_SIZE)
    ingestPiChunk(entry, readSlice(filePath, pos, next))
    pos = next
  }

  if (entry.remainder.trim().startsWith('{') && entry.remainder.trim().endsWith('}')) {
    const trailing = entry.remainder
    entry.remainder = ''
    ingestPiChunk(entry, trailing + '\n')
  }

  entry.size = st.size
  entry.mtimeMs = st.mtimeMs
  entry.byteOffset = st.size
  entry.result = buildPiResult(entry)
  fileCache.set(filePath, entry)
  return entry.result
}

/* ============================ OpenCode (v1 & v2) ============================ */

function parseModelField(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'opencode'
  const text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      if (typeof obj.id === 'string' && obj.id) return obj.id
    } catch {
      // Fall through.
    }
  }
  return text
}

export type OpenCodeSessionSummary = {
  sessionId: string
  title: string
  directory: string
  updatedAt: number
  isV2: boolean
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function listOpenCodeSessions(
  dbPath: string,
  workspacePath: string | null,
  sessionIds: string[],
  limit = 4
): OpenCodeSessionSummary[] {
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync || !existsSync(dbPath)) return []

  const results: OpenCodeSessionSummary[] = []
  const seen = new Set<string>()
  const targetDir = workspacePath ? normalizeDir(workspacePath) : null

  let db: SqliteDb | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => String(r.name || ''))
    )

    const collectFrom = (table: string, isV2: boolean) => {
      if (!tables.has(table)) return
      // Specific requested session IDs first
      for (const sid of sessionIds) {
        if (!sid || seen.has(sid)) continue
        const row = db!
          .prepare(`SELECT id, title, directory, time_updated FROM ${table} WHERE id = ?`)
          .get(sid)
        if (row && typeof row.id === 'string') {
          seen.add(row.id)
          results.push({
            sessionId: row.id,
            title: typeof row.title === 'string' && row.title ? row.title : `OpenCode · ${row.id.slice(0, 8)}`,
            directory: typeof row.directory === 'string' ? row.directory : '',
            updatedAt: Number(row.time_updated) || 0,
            isV2
          })
        }
      }
      // Recent sessions matching focused workspace directory
      const recent = db!
        .prepare(
          `SELECT id, title, directory, time_updated FROM ${table} WHERE (COALESCE(tokens_input,0) + COALESCE(tokens_cache_read,0)) > 0 ORDER BY time_updated DESC LIMIT 30`
        )
        .all()
      for (const row of recent) {
        if (results.length >= limit + sessionIds.length) break
        const id = typeof row.id === 'string' ? row.id : ''
        if (!id || seen.has(id)) continue
        const dir = typeof row.directory === 'string' ? row.directory : ''
        if (targetDir && normalizeDir(dir) !== targetDir) continue
        seen.add(id)
        results.push({
          sessionId: id,
          title: typeof row.title === 'string' && row.title ? row.title : `OpenCode · ${id.slice(0, 8)}`,
          directory: dir,
          updatedAt: Number(row.time_updated) || 0,
          isV2
        })
      }
    }

    collectFrom('session_v2', true)
    collectFrom('session', false)
  } catch {
    return results
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore close errors.
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results.slice(0, Math.max(limit, sessionIds.length))
}

export function parseOpenCodeSession(
  dbPath: string,
  sessionId: string,
  isV2Hint?: boolean
): ParsedSessionData | null {
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync || !existsSync(dbPath)) return null

  let db: SqliteDb | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => String(r.name || ''))
    )

    let useV2 = Boolean(isV2Hint)
    let sessRow: Record<string, unknown> | undefined
    if (tables.has('session_v2') && (isV2Hint !== false)) {
      sessRow = db
        .prepare(
          'SELECT id, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated FROM session_v2 WHERE id = ?'
        )
        .get(sessionId)
      if (sessRow) useV2 = true
    }
    if (!sessRow && tables.has('session')) {
      sessRow = db
        .prepare(
          'SELECT id, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated FROM session WHERE id = ?'
        )
        .get(sessionId)
      if (sessRow) useV2 = false
    }
    if (!sessRow) return null

    const updatedAt = Number(sessRow.time_updated) || Date.now()
    const aggIn = Math.max(0, Number(sessRow.tokens_input) || 0)
    const aggCR = Math.max(0, Number(sessRow.tokens_cache_read) || 0)
    const aggCW = Math.max(0, Number(sessRow.tokens_cache_write) || 0)
    const aggOut = Math.max(0, Number(sessRow.tokens_output) || 0) + Math.max(0, Number(sessRow.tokens_reasoning) || 0)

    const cacheKey = `opencode:${sessionId}`
    const stamp = `${updatedAt}:${aggIn}:${aggCR}:${aggCW}:${aggOut}`
    const cached = fileCache.get(cacheKey)
    if (cached && cached.kind === 'opencode' && cached.stamp === stamp) {
      return cached.result
    }

    const msgTable = useV2 ? 'session_message' : 'message'
    const rows = tables.has(msgTable)
      ? useV2
        ? db
            .prepare(
              "SELECT time_created, data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq ASC"
            )
            .all(sessionId)
        : db
            .prepare('SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
            .all(sessionId)
      : []

    let sumIn = 0
    let sumCR = 0
    let sumCW = 0
    let sumOut = 0
    let largeMissCount = 0
    let largeMissTokens = 0
    let lastModel = parseModelField(sessRow.model)
    const allTurns: CacheTurn[] = []

    for (const r of rows) {
      if (typeof r.data !== 'string') continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(r.data) as Record<string, unknown>
      } catch {
        continue
      }
      if (!useV2 && obj.role !== 'assistant') continue
      const tok = obj.tokens as Record<string, unknown> | undefined
      if (!tok) continue

      const cacheObj = (tok.cache as Record<string, unknown> | undefined) || {}
      const input = Math.max(0, Number(tok.input) || 0)
      const cacheRead = Math.max(0, Number(cacheObj.read) || 0)
      const cacheCreate = Math.max(0, Number(cacheObj.write) || 0)
      const out = Math.max(0, Number(tok.output) || 0) + Math.max(0, Number(tok.reasoning) || 0)
      const totalIn = input + cacheRead + cacheCreate
      if (totalIn + out === 0) continue

      const modelObj = obj.model as Record<string, unknown> | undefined
      const model =
        (typeof modelObj?.id === 'string' && modelObj.id) ||
        (typeof obj.modelID === 'string' && obj.modelID) ||
        lastModel
      if (model) lastModel = model

      const timeObj = obj.time as Record<string, unknown> | undefined
      const ts = Number(timeObj?.completed || timeObj?.created || r.time_created)
      const timestamp = Number.isFinite(ts) && ts > 0 ? ts : null
      const hitRate = calcRate(cacheRead, totalIn)

      sumIn += input
      sumCR += cacheRead
      sumCW += cacheCreate
      sumOut += out

      if (input >= LARGE_MISS_TOKENS_THRESHOLD && (hitRate == null || hitRate < LARGE_MISS_HIT_THRESHOLD)) {
        largeMissCount += 1
        largeMissTokens += input
      }

      allTurns.push({
        index: allTurns.length + 1,
        timestamp,
        model: model || 'opencode',
        inputTokens: input,
        cacheReadTokens: cacheRead,
        cacheCreateTokens: cacheCreate,
        totalInputTokens: totalIn,
        outputTokens: out,
        hitRate
      })
    }

    // Prefer exact per-turn sum when available, otherwise fall back to session_v2 aggregate columns
    const finalIn = allTurns.length ? sumIn : aggIn
    const finalCR = allTurns.length ? sumCR : aggCR
    const finalCW = allTurns.length ? sumCW : aggCW
    const finalOut = allTurns.length ? sumOut : aggOut
    const totalInput = finalIn + finalCR + finalCW
    const recentTurns = allTurns.slice(-MAX_STORED_TURNS)
    const latest = allTurns.length ? allTurns[allTurns.length - 1] : null

    const result: ParsedSessionData = {
      agent: 'opencode',
      model: latest?.model || lastModel || 'opencode',
      title: typeof sessRow.title === 'string' && sessRow.title ? sessRow.title : undefined,
      updatedAt: latest?.timestamp || updatedAt,
      turnCount: allTurns.length || (totalInput > 0 ? 1 : 0),
      totalInputTokens: totalInput,
      cacheReadTokens: finalCR,
      cacheCreateTokens: finalCW,
      uncachedInputTokens: finalIn,
      outputTokens: finalOut,
      sessionHitRate: calcRate(finalCR, totalInput),
      recent5HitRate: computeRollingRate(recentTurns, 5),
      latestHitRate: latest ? latest.hitRate : calcRate(finalCR, totalInput),
      largeMissCount,
      largeMissTokens,
      cacheTelemetryAvailable: true,
      turns: recentTurns
    }

    fileCache.set(cacheKey, { kind: 'opencode', stamp, result })
    return result
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore close errors.
    }
  }
}

/* ============================ Antigravity (AGY) ============================ */

type ProtoField = {
  f: number
  w: 'v' | 'b'
  v?: number
  b?: Uint8Array
}

function decodeProtoFlat(buf: Uint8Array): ProtoField[] | null {
  let i = 0
  const out: ProtoField[] = []
  while (i < buf.length) {
    let key = 0n
    let shift = 0n
    while (i < buf.length) {
      const byte = buf[i++]
      key |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7n
      if (shift > 63n) return null
    }
    const fieldNum = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (wire === 0) {
      let val = 0n
      shift = 0n
      while (i < buf.length) {
        const byte = buf[i++]
        val |= BigInt(byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7n
        if (shift > 63n) return null
      }
      out.push({ f: fieldNum, w: 'v', v: Number(val) })
    } else if (wire === 2) {
      let len = 0n
      shift = 0n
      while (i < buf.length) {
        const byte = buf[i++]
        len |= BigInt(byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7n
        if (shift > 63n) return null
      }
      const n = Number(len)
      if (n < 0 || i + n > buf.length) return null
      out.push({ f: fieldNum, w: 'b', b: buf.subarray(i, i + n) })
      i += n
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null
      i += 8
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null
      i += 4
    } else {
      return null
    }
  }
  return out
}

export type AgySessionSummary = {
  sessionId: string
  title: string
  updatedAt: number
  dbPath: string
}

export function listAgySessions(
  agyBaseDir: string,
  workspacePath: string | null,
  sessionIds: string[],
  limit = 2
): AgySessionSummary[] {
  const DatabaseSync = getDatabaseSync()
  const convDir = `${agyBaseDir}/conversations`
  const sumDbPath = `${agyBaseDir}/conversation_summaries.db`
  if (!DatabaseSync || !existsSync(convDir)) return []

  const results: AgySessionSummary[] = []
  const seen = new Set<string>()
  const targetDir = workspacePath ? normalizeDir(workspacePath) : null

  const titleById = new Map<string, { title: string; updatedAt: number; workspaces: string[] }>()
  if (existsSync(sumDbPath)) {
    let sdb: SqliteDb | null = null
    try {
      sdb = new DatabaseSync(sumDbPath, { readOnly: true })
      const rows = sdb
        .prepare(
          'SELECT conversation_id, title, last_modified_time, workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 60'
        )
        .all()
      for (const r of rows) {
        const cid = typeof r.conversation_id === 'string' ? r.conversation_id : ''
        if (!cid) continue
        const ts = Date.parse(String(r.last_modified_time || ''))
        let uris: string[] = []
        if (typeof r.workspace_uris === 'string' && r.workspace_uris.startsWith('[')) {
          try {
            const parsed = JSON.parse(r.workspace_uris)
            if (Array.isArray(parsed)) {
              uris = parsed
                .filter((u): u is string => typeof u === 'string')
                .map((u) => normalizeDir(decodeURIComponent(u.replace(/^file:\/\/\/?/i, ''))))
            }
          } catch {
            // Ignore malformed URI JSON.
          }
        }
        titleById.set(cid, {
          title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : `AGY · ${cid.slice(0, 8)}`,
          updatedAt: Number.isFinite(ts) ? ts : 0,
          workspaces: uris
        })
      }
    } catch {
      // Summary DB optional.
    } finally {
      try {
        sdb?.close()
      } catch {
        // Ignore.
      }
    }
  }

  for (const sid of sessionIds) {
    if (!sid || seen.has(sid)) continue
    const dbPath = `${convDir}/${sid}.db`
    if (!existsSync(dbPath)) continue
    seen.add(sid)
    const meta = titleById.get(sid)
    let mtime = meta?.updatedAt || 0
    if (!mtime) {
      try {
        mtime = statSync(dbPath).mtimeMs
      } catch {
        mtime = Date.now()
      }
    }
    results.push({
      sessionId: sid,
      title: meta?.title || `AGY · ${sid.slice(0, 8)}`,
      updatedAt: mtime,
      dbPath
    })
  }

  for (const [cid, meta] of titleById.entries()) {
    if (results.length >= limit + sessionIds.length) break
    if (seen.has(cid)) continue
    if (targetDir && meta.workspaces.length > 0 && !meta.workspaces.includes(targetDir)) continue
    const dbPath = `${convDir}/${cid}.db`
    if (!existsSync(dbPath)) continue
    seen.add(cid)
    results.push({
      sessionId: cid,
      title: meta.title,
      updatedAt: meta.updatedAt,
      dbPath
    })
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results.slice(0, Math.max(limit, sessionIds.length))
}

export function parseAgyConversation(dbPath: string, fallbackTitle?: string): ParsedSessionData | null {
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync || !existsSync(dbPath)) return null

  let st
  try {
    st = statSync(dbPath)
  } catch {
    return null
  }

  const cacheKey = `agy:${dbPath}`
  const stamp = `${st.size}:${st.mtimeMs}`
  const cached = fileCache.get(cacheKey)
  if (cached && cached.kind === 'antigravity' && cached.stamp === stamp) {
    return cached.result
  }

  let db: SqliteDb | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all()
    if (!rows.length) return null

    let lastModel = 'Antigravity'
    let sumIn = 0
    let sumCR = 0
    let sumCW = 0
    let sumOut = 0
    let hasCacheTelemetry = false
    const turns: CacheTurn[] = []

    for (const r of rows) {
      const raw = r.data
      if (!(raw instanceof Uint8Array)) continue
      const top = decodeProtoFlat(raw)
      if (!top) continue
      // Skip errored attempts (top-level f5 is error string)
      if (top.some((x) => x.f === 5 && x.w === 'b' && x.b && x.b.length > 0)) continue

      const f1Bytes = top.find((x) => x.f === 1 && x.w === 'b')?.b
      if (!f1Bytes) continue
      const f1 = decodeProtoFlat(f1Bytes)
      if (!f1) continue

      const modelLabelBytes = f1.find((x) => x.f === 21 && x.w === 'b')?.b
      if (modelLabelBytes && modelLabelBytes.length > 0) {
        const label = Buffer.from(modelLabelBytes).toString('utf8').trim()
        if (label) lastModel = label
      }

      const f4Bytes = f1.find((x) => x.f === 4 && x.w === 'b')?.b
      const f4 = f4Bytes ? decodeProtoFlat(f4Bytes) : null
      const f9Bytes = f1.find((x) => x.f === 9 && x.w === 'b')?.b
      const f9 = f9Bytes ? decodeProtoFlat(f9Bytes) : null
      const f9_10Bytes = f9?.find((x) => x.f === 10 && x.w === 'b')?.b
      const f9_10 = f9_10Bytes ? decodeProtoFlat(f9_10Bytes) : null

      const ctxTokens = f9_10?.find((x) => x.f === 1 && x.w === 'v')?.v ?? 0
      const usageIn = f4?.find((x) => x.f === 2 && x.w === 'v')?.v ?? 0
      const usageOut =
        f4?.find((x) => x.f === 3 && x.w === 'v')?.v ??
        f4?.find((x) => x.f === 10 && x.w === 'v')?.v ??
        0
      // Future-proof: standard ModelUsage cache_read_tokens / cache_creation_tokens fields if populated
      const cacheRead =
        f4?.find((x) => x.f === 7 && x.w === 'v')?.v ??
        f4?.find((x) => x.f === 5 && x.w === 'v')?.v ??
        0
      const cacheCreate = f4?.find((x) => x.f === 8 && x.w === 'v')?.v ?? 0

      if (cacheRead > 0 || cacheCreate > 0) hasCacheTelemetry = true

      const totalIn = ctxTokens > 0 ? ctxTokens : usageIn
      if (totalIn <= 0 && usageOut <= 0) continue

      const uncached = Math.max(0, totalIn - cacheRead - cacheCreate)
      sumIn += uncached
      sumCR += cacheRead
      sumCW += cacheCreate
      sumOut += usageOut

      turns.push({
        index: turns.length + 1,
        timestamp: null,
        model: lastModel,
        inputTokens: uncached,
        cacheReadTokens: cacheRead,
        cacheCreateTokens: cacheCreate,
        totalInputTokens: totalIn,
        outputTokens: usageOut,
        hitRate: hasCacheTelemetry ? calcRate(cacheRead, totalIn) : null
      })
    }

    if (!turns.length) return null

    const totalInput = sumIn + sumCR + sumCW
    const recentTurns = turns.slice(-MAX_STORED_TURNS)
    const latest = turns[turns.length - 1]

    const result: ParsedSessionData = {
      agent: 'antigravity',
      model: lastModel,
      title: fallbackTitle,
      updatedAt: st.mtimeMs,
      turnCount: turns.length,
      totalInputTokens: totalInput,
      cacheReadTokens: sumCR,
      cacheCreateTokens: sumCW,
      uncachedInputTokens: sumIn,
      outputTokens: sumOut,
      sessionHitRate: hasCacheTelemetry ? calcRate(sumCR, totalInput) : null,
      recent5HitRate: hasCacheTelemetry ? computeRollingRate(recentTurns, 5) : null,
      latestHitRate: hasCacheTelemetry ? latest.hitRate : null,
      largeMissCount: 0,
      largeMissTokens: 0,
      cacheTelemetryAvailable: hasCacheTelemetry,
      telemetryNote: hasCacheTelemetry
        ? undefined
        : 'AGY 本地会话库（gen_metadata）暂未记录上游 cache_read 字段，当前展示轮次与上下文估算统计。',
      turns: recentTurns
    }

    fileCache.set(cacheKey, { kind: 'antigravity', stamp, result })
    return result
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore close errors.
    }
  }
}

export function clearParserCache(): void {
  fileCache.clear()
}

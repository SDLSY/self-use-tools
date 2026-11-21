import { existsSync } from 'node:fs'
import type { CacheTurn } from '../protocol'
import {
  LARGE_MISS_HIT_THRESHOLD,
  LARGE_MISS_TOKENS_THRESHOLD,
  MAX_STORED_TURNS,
  calcRate,
  computeRollingRate,
  getDatabaseSync,
  normalizeDir,
  registerParserCacheReset,
  type ParsedSessionData,
  type SqliteDb
} from './transcript-io'

export type OpenCodeSessionSummary = {
  sessionId: string
  title: string
  directory: string
  updatedAt: number
  isV2: boolean
}

const openCodeCache = new Map<string, { stamp: string; result: ParsedSessionData }>()
registerParserCacheReset(() => openCodeCache.clear())

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
      for (const sid of sessionIds) {
        if (!sid || seen.has(sid)) continue
        const row = db!
          .prepare(`SELECT id, title, directory, time_updated FROM ${table} WHERE id = ?`)
          .get(sid)
        if (row && typeof row.id === 'string') {
          seen.add(row.id)
          results.push({
            sessionId: row.id,
            title:
              typeof row.title === 'string' && row.title
                ? row.title
                : `OpenCode · ${row.id.slice(0, 8)}`,
            directory: typeof row.directory === 'string' ? row.directory : '',
            updatedAt: Number(row.time_updated) || 0,
            isV2
          })
        }
      }
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
          title:
            typeof row.title === 'string' && row.title ? row.title : `OpenCode · ${id.slice(0, 8)}`,
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
    if (tables.has('session_v2') && isV2Hint !== false) {
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
    const aggOut =
      Math.max(0, Number(sessRow.tokens_output) || 0) +
      Math.max(0, Number(sessRow.tokens_reasoning) || 0)

    const stamp = `${updatedAt}:${aggIn}:${aggCR}:${aggCW}:${aggOut}`
    const cached = openCodeCache.get(sessionId)
    if (cached && cached.stamp === stamp) {
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
            .prepare(
              'SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC'
            )
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
      const out =
        Math.max(0, Number(tok.output) || 0) + Math.max(0, Number(tok.reasoning) || 0)
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

      if (
        input >= LARGE_MISS_TOKENS_THRESHOLD &&
        (hitRate == null || hitRate < LARGE_MISS_HIT_THRESHOLD)
      ) {
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

    // Prefer exact per-turn sum when available, otherwise fall back to aggregate columns.
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

    openCodeCache.set(sessionId, { stamp, result })
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

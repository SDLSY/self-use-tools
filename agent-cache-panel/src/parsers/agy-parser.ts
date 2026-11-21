import { existsSync, statSync } from 'node:fs'
import type { CacheTurn } from '../protocol'
import {
  MAX_STORED_TURNS,
  calcRate,
  computeRollingRate,
  getDatabaseSync,
  normalizeDir,
  registerParserCacheReset,
  type ParsedSessionData,
  type SqliteDb
} from './transcript-io'

type ProtoField = {
  f: number
  w: 'v' | 'b'
  v?: number
  b?: Uint8Array
}

export type AgySessionSummary = {
  sessionId: string
  title: string
  updatedAt: number
  dbPath: string
}

const agyCache = new Map<string, { stamp: string; result: ParsedSessionData }>()
registerParserCacheReset(() => agyCache.clear())

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
          title:
            typeof r.title === 'string' && r.title.trim()
              ? r.title.trim()
              : `AGY · ${cid.slice(0, 8)}`,
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
    results.push({ sessionId: cid, title: meta.title, updatedAt: meta.updatedAt, dbPath })
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results.slice(0, Math.max(limit, sessionIds.length))
}

export function parseAgyConversation(
  dbPath: string,
  fallbackTitle?: string
): ParsedSessionData | null {
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync || !existsSync(dbPath)) return null

  let st
  try {
    st = statSync(dbPath)
  } catch {
    return null
  }

  const stamp = `${st.size}:${st.mtimeMs}`
  const cached = agyCache.get(dbPath)
  if (cached && cached.stamp === stamp) return cached.result

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
      if (top.some((x) => x.f === 5 && x.w === 'b' && x.b && x.b.length > 0)) continue

      const f1Bytes = top.find((x) => x.f === 1 && x.w === 'b')?.b
      const f1 = f1Bytes ? decodeProtoFlat(f1Bytes) : null
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

    agyCache.set(dbPath, { stamp, result })
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

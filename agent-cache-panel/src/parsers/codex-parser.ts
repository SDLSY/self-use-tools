import { statSync } from 'node:fs'
import type { CacheTurn } from '../protocol'
import {
  LARGE_MISS_HIT_THRESHOLD,
  LARGE_MISS_TOKENS_THRESHOLD,
  MAX_STORED_TURNS,
  calcRate,
  computeRollingRate,
  readSlice,
  registerParserCacheReset,
  type ParsedSessionData
} from './transcript-io'

const CODEX_INITIAL_TAIL_BYTES = 4 * 1024 * 1024

type CodexCacheEntry = {
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

const codexCache = new Map<string, CodexCacheEntry>()
registerParserCacheReset(() => codexCache.clear())

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
    codexCache.delete(filePath)
    return null
  }

  const cached = codexCache.get(filePath)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.result
  }

  let entry: CodexCacheEntry
  if (cached && st.size >= cached.byteOffset) {
    entry = cached
  } else {
    const startOffset =
      st.size > CODEX_INITIAL_TAIL_BYTES ? st.size - CODEX_INITIAL_TAIL_BYTES : 0
    entry = {
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
  codexCache.set(filePath, entry)
  return entry.result
}

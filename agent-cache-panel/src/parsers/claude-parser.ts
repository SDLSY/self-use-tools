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
  size: number
  mtimeMs: number
  byteOffset: number
  remainder: string
  turnsById: Map<string, ClaudeTurnRecord>
  order: string[]
  lastModel: string
  result: ParsedSessionData
}

const claudeCache = new Map<string, ClaudeCacheEntry>()
registerParserCacheReset(() => claudeCache.clear())

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
    claudeCache.delete(filePath)
    return null
  }

  const cached = claudeCache.get(filePath)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.result
  }

  let entry: ClaudeCacheEntry
  if (cached && st.size >= cached.byteOffset) {
    entry = cached
  } else {
    entry = {
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
  claudeCache.set(filePath, entry)
  return entry.result
}

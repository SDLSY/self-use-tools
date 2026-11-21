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

type PiCacheEntry = {
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

const piCache = new Map<string, PiCacheEntry>()
registerParserCacheReset(() => piCache.clear())

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
    const rawTs =
      typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(String(obj.timestamp || ''))
    const timestamp = Number.isFinite(rawTs) ? rawTs : null

    entry.turnCount += 1
    entry.totalInput += input
    entry.totalCacheRead += cacheRead
    entry.totalCacheCreate += cacheCreate
    entry.totalOutput += out

    const hitRate = calcRate(cacheRead, totalIn)
    if (
      input >= LARGE_MISS_TOKENS_THRESHOLD &&
      (hitRate == null || hitRate < LARGE_MISS_HIT_THRESHOLD)
    ) {
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
    piCache.delete(filePath)
    return null
  }

  const cached = piCache.get(filePath)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.result
  }

  let entry: PiCacheEntry
  if (cached && st.size >= cached.byteOffset) {
    entry = cached
  } else {
    entry = {
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
  piCache.set(filePath, entry)
  return entry.result
}

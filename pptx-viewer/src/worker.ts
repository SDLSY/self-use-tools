import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  ConvertUploadedRequest,
  GetSlideChunkRequest,
  GetSlideChunkResponse,
  PrepareRequest,
  PrepareResponse,
  UploadChunkRequest,
  UploadChunkResponse
} from './protocol'
import {
  CACHE_ROOT,
  UPLOAD_ROOT,
  discoverRenderTools,
  findMatchingPptxInDir,
  getCacheDir,
  listRenderedSlides,
  renderDeckToCache
} from './render-engine'

const uploadBuffers = new Map<string, { total: number; parts: (Buffer | null)[]; ext: string }>()

async function readDpiSetting(orca: OrcaWorkerApi): Promise<number> {
  try {
    const all = await orca.settings.get()
    const raw = Number(all?.renderDpi ?? 180)
    if (Number.isFinite(raw)) return Math.min(300, Math.max(96, Math.round(raw)))
  } catch {
    // ignore
  }
  return 180
}

export default function activate(orca: OrcaWorkerApi): void {
  mkdirSync(CACHE_ROOT, { recursive: true })
  mkdirSync(UPLOAD_ROOT, { recursive: true })

  orca.panels.handle('pptx.prepare', async (input: PrepareRequest): Promise<PrepareResponse> => {
    const dpi = await readDpiSetting(orca)
    const sha256 = String(input?.sha256 || '').toLowerCase()
    const byteLength = Number(input?.byteLength || 0)

    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      return { status: 'unavailable', reason: '无效的文件哈希' }
    }

    const tools = discoverRenderTools()
    if (!tools.soffice || !tools.pdftoppm) {
      return {
        status: 'unavailable',
        reason: '未检测到 LibreOffice 或 Poppler，已自动使用内置结构化预览。'
      }
    }

    const cacheDir = getCacheDir(sha256, dpi)
    const existing = listRenderedSlides(cacheDir)
    if (existing.length > 0) {
      return {
        status: 'ready',
        slideCount: existing.length,
        dpi,
        engine: 'libreoffice',
        cached: true,
        mimeType: existing[0].endsWith('.png') ? 'image/png' : 'image/jpeg'
      }
    }

    // Zero-copy workspace lookup avoids uploading multi-MB files over IPC.
    if (byteLength > 0 && orca.host.has('workspace.list')) {
      try {
        const res = await orca.host.call('workspace.list', { includeStatus: false })
        const seenRoots = new Set<string>()
        for (const ws of res.workspaces) {
          if (!ws.path || seenRoots.has(ws.path)) continue
          seenRoots.add(ws.path)
          const match = findMatchingPptxInDir(ws.path, byteLength, sha256, 4)
          if (match) {
            return await renderDeckToCache(match, sha256, dpi, (m) => orca.log(m))
          }
        }
      } catch (err) {
        orca.log(`workspace.list lookup skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { status: 'need-upload', dpi }
  })

  orca.panels.handle(
    'pptx.uploadChunk',
    async (input: UploadChunkRequest): Promise<UploadChunkResponse> => {
      const sha256 = String(input.sha256 || '').toLowerCase()
      const ext = input.fileType === 'ppt' ? '.ppt' : '.pptx'
      let entry = uploadBuffers.get(sha256)
      if (!entry || entry.total !== input.total) {
        entry = { total: input.total, parts: new Array(input.total).fill(null), ext }
        uploadBuffers.set(sha256, entry)
      }
      entry.parts[input.index] = Buffer.from(input.b64, 'base64')
      const received = entry.parts.filter((p) => p !== null).length
      return { received, complete: received === entry.total }
    }
  )

  orca.panels.handle(
    'pptx.convertUploaded',
    async (input: ConvertUploadedRequest): Promise<PrepareResponse> => {
      const sha256 = String(input.sha256 || '').toLowerCase()
      const dpi = await readDpiSetting(orca)
      const entry = uploadBuffers.get(sha256)
      if (!entry || entry.parts.some((p) => p === null)) {
        return { status: 'unavailable', reason: '分片数据不完整' }
      }
      const fullBuf = Buffer.concat(entry.parts as Buffer[])
      uploadBuffers.delete(sha256)

      const tmpFile = join(UPLOAD_ROOT, `${sha256}${entry.ext}`)
      writeFileSync(tmpFile, fullBuf)
      try {
        return await renderDeckToCache(tmpFile, sha256, dpi, (m) => orca.log(m))
      } finally {
        try {
          rmSync(tmpFile, { force: true })
        } catch {
          // ignore
        }
      }
    }
  )

  orca.panels.handle(
    'pptx.getSlideChunk',
    async (input: GetSlideChunkRequest): Promise<GetSlideChunkResponse> => {
      const cacheDir = getCacheDir(input.sha256, input.dpi)
      const slides = listRenderedSlides(cacheDir)
      const filePath = slides[input.slideIndex]
      if (!filePath || !existsSync(filePath)) {
        throw Object.assign(new Error(`Slide ${input.slideIndex} not found`), {
          code: 'invalid_params'
        })
      }
      const buf = readFileSync(filePath)
      const offset = Math.max(0, Number(input.offset) || 0)
      const chunkSize = Math.min(180 * 1024, Math.max(16 * 1024, Number(input.chunkSize) || 140 * 1024))
      const slice = buf.subarray(offset, offset + chunkSize)
      const nextOffset = offset + slice.length
      return {
        b64: slice.toString('base64'),
        totalBytes: buf.length,
        nextOffset,
        done: nextOffset >= buf.length,
        mimeType: filePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
      }
    }
  )

  orca.log('PPTX Viewer worker activated')
}

export function deactivate(): void {
  uploadBuffers.clear()
}

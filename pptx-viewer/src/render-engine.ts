import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { PrepareResponse } from './protocol'

export const CACHE_ROOT = join(tmpdir(), 'orca-pptx-viewer-cache')
export const UPLOAD_ROOT = join(CACHE_ROOT, '_uploads')
const LO_PROFILE_DIR = join(CACHE_ROOT, '_lo_profile')

let loQueue: Promise<unknown> = Promise.resolve()

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'worktrees',
  '.orca',
  'target'
])

export type RenderTools = {
  soffice: string | null
  pdftoppm: string | null
}

let cachedTools: RenderTools | null = null
const inFlightRenders = new Map<string, Promise<PrepareResponse>>()

function runExec(
  cmd: string,
  args: string[],
  timeoutMs = 90_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${basename(cmd)} failed: ${stderr || err.message}`))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

function findExecutableOnPath(names: string[]): string | null {
  const pathEnv = process.env.PATH || process.env.Path || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const dirs = pathEnv.split(sep).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  return null
}

function findWinGetPoppler(): string | null {
  if (process.platform !== 'win32') return null
  const pkgRoot = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(pkgRoot)) return null
  try {
    for (const entry of readdirSync(pkgRoot)) {
      if (!entry.toLowerCase().includes('poppler')) continue
      const base = join(pkgRoot, entry)
      for (const sub of readdirSync(base)) {
        const candidate = join(base, sub, 'Library', 'bin', 'pdftoppm.exe')
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {
    // ignore scan errors
  }
  return null
}

export function discoverRenderTools(): RenderTools {
  if (cachedTools) return cachedTools

  let soffice: string | null = findExecutableOnPath(
    process.platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice', 'libreoffice']
  )
  if (!soffice && process.platform === 'win32') {
    const winCandidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      'D:\\Program Files\\LibreOffice\\program\\soffice.exe'
    ]
    soffice = winCandidates.find((p) => existsSync(p)) ?? null
  } else if (!soffice && process.platform === 'darwin') {
    const macCandidate = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    if (existsSync(macCandidate)) soffice = macCandidate
  }

  let pdftoppm: string | null = findExecutableOnPath(
    process.platform === 'win32' ? ['pdftoppm.exe'] : ['pdftoppm']
  )
  if (!pdftoppm) {
    pdftoppm = findWinGetPoppler()
  }

  cachedTools = { soffice, pdftoppm }
  return cachedTools
}

export function getCacheDir(sha256: string, dpi: number): string {
  const safeHash = sha256.replace(/[^a-f0-9]/gi, '').slice(0, 64)
  return join(CACHE_ROOT, `${safeHash}_${dpi}`)
}

export function listRenderedSlides(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return []
  const files = readdirSync(cacheDir).filter((f) => /^slide-\d+\.(jpg|jpeg|png)$/i.test(f))
  files.sort((a, b) => {
    const na = parseInt(a.match(/\d+/)?.[0] ?? '0', 10)
    const nb = parseInt(b.match(/\d+/)?.[0] ?? '0', 10)
    return na - nb
  })
  return files.map((f) => join(cacheDir, f))
}

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

export function findMatchingPptxInDir(
  rootDir: string,
  targetSize: number,
  targetSha: string,
  maxDepth = 4
): string | null {
  if (!existsSync(rootDir)) return null
  const queue: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()!
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (current.depth < maxDepth && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
          queue.push({ dir: join(current.dir, ent.name), depth: current.depth + 1 })
        }
        continue
      }
      if (!ent.isFile()) continue
      const ext = extname(ent.name).toLowerCase()
      if (ext !== '.pptx' && ext !== '.ppt') continue
      const fullPath = join(current.dir, ent.name)
      try {
        const st = statSync(fullPath)
        if (st.size !== targetSize) continue
        if (sha256File(fullPath) === targetSha) {
          return fullPath
        }
      } catch {
        continue
      }
    }
  }
  return null
}

async function runSerializedSoffice(soffice: string, workDir: string, sourcePath: string): Promise<void> {
  // Reuse a dedicated persistent LibreOffice profile so first-run registry isn't rebuilt every time (~1.5s vs ~25s).
  const profileUri = 'file:///' + LO_PROFILE_DIR.replace(/\\/g, '/').replace(/^\/+/, '')
  const prev = loQueue
  let release!: () => void
  loQueue = new Promise<void>((r) => {
    release = r
  })
  await prev.catch(() => {})
  try {
    await runExec(
      soffice,
      [
        `-env:UserInstallation=${profileUri}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        sourcePath
      ],
      90_000
    )
  } finally {
    release()
  }
}

export async function renderDeckToCache(
  sourcePath: string,
  sha256: string,
  dpi: number,
  log: (m: string) => void
): Promise<PrepareResponse> {
  const tools = discoverRenderTools()
  if (!tools.soffice || !tools.pdftoppm) {
    const missing = [
      !tools.soffice ? 'LibreOffice (soffice)' : null,
      !tools.pdftoppm ? 'Poppler (pdftoppm)' : null
    ]
      .filter(Boolean)
      .join(' / ')
    return {
      status: 'unavailable',
      reason: `未检测到 ${missing}，已自动使用内置结构化渲染视图。`
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
      sourcePath,
      mimeType: existing[0].endsWith('.png') ? 'image/png' : 'image/jpeg'
    }
  }

  const lockKey = `${sha256}_${dpi}`
  const existingJob = inFlightRenders.get(lockKey)
  if (existingJob) return existingJob

  const job = (async (): Promise<PrepareResponse> => {
    const workDir = join(CACHE_ROOT, `_tmp_${sha256.slice(0, 12)}_${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    mkdirSync(LO_PROFILE_DIR, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    try {
      log(`Converting PPTX via LibreOffice: ${sourcePath}`)
      await runSerializedSoffice(tools.soffice!, workDir, sourcePath)

      const pdfFile = readdirSync(workDir).find((f) => f.toLowerCase().endsWith('.pdf'))
      if (!pdfFile) {
        throw new Error('LibreOffice did not produce a PDF file')
      }
      const pdfPath = join(workDir, pdfFile)
      const outPrefix = join(cacheDir, 'slide')

      log(`Rasterizing PDF pages at ${dpi} DPI via pdftoppm`)
      await runExec(
        tools.pdftoppm!,
        ['-jpeg', '-jpegopt', 'quality=92', '-r', String(dpi), pdfPath, outPrefix],
        90_000
      )

      const rendered = listRenderedSlides(cacheDir)
      if (rendered.length === 0) {
        throw new Error('pdftoppm produced zero slide images')
      }
      log(`Rendered ${rendered.length} slides for ${sha256.slice(0, 10)}`)
      return {
        status: 'ready',
        slideCount: rendered.length,
        dpi,
        engine: 'libreoffice',
        cached: false,
        sourcePath,
        mimeType: 'image/jpeg'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`Render error: ${msg}`)
      try {
        rmSync(cacheDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      return {
        status: 'unavailable',
        reason: `高清渲染失败（${msg}），已回退至内置结构视图。`
      }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      inFlightRenders.delete(lockKey)
    }
  })()

  inFlightRenders.set(lockKey, job)
  return job
}

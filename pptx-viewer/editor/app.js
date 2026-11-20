import { parsePptxBuffer } from './pptx-parse.js'

const state = {
  sha256: null,
  fileType: 'pptx',
  parsed: null,         // instant browser-parsed PPTX model
  hdSlideCount: 0,
  hdDpi: 180,
  hdUrls: new Map(),    // slideIndex -> objectURL
  hdBlobs: new Map(),   // slideIndex -> Blob (for Save As export)
  hdStatus: 'idle',     // 'idle' | 'loading' | 'ready' | 'unavailable'
  hdReason: '',
  viewMode: 'hd',       // 'hd' | 'structured'
  layoutMode: 'single', // 'single' | 'grid'
  current: 0,
  zoom: 'fit',          // 'fit' | number (e.g., 1.0, 1.25)
  showSidebar: true,
  showNotes: false,
  presenting: false,
  loadToken: 0
}

const el = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  stageWrap: document.getElementById('stageWrap'),
  gridView: document.getElementById('gridView'),
  notesDrawer: document.getElementById('notesDrawer'),
  notesTitle: document.getElementById('notesTitle'),
  notesBody: document.getElementById('notesBody'),
  engineBadge: document.getElementById('engineBadge'),
  aspectBadge: document.getElementById('aspectBadge'),
  pageCounter: document.getElementById('pageCounter'),
  zoomLabel: document.getElementById('zoomLabel'),
  btnSidebar: document.getElementById('btnSidebar'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),
  btnZoomOut: document.getElementById('btnZoomOut'),
  btnZoomFit: document.getElementById('btnZoomFit'),
  btnZoomIn: document.getElementById('btnZoomIn'),
  btnViewMode: document.getElementById('btnViewMode'),
  btnGrid: document.getElementById('btnGrid'),
  btnNotes: document.getElementById('btnNotes'),
  btnExport: document.getElementById('btnExport'),
  btnPresent: document.getElementById('btnPresent'),
  btnCopyText: document.getElementById('btnCopyText'),
  hudPrev: document.getElementById('hudPrev'),
  hudNext: document.getElementById('hudNext'),
  hudCounter: document.getElementById('hudCounter'),
  hudExit: document.getElementById('hudExit')
}

function getSlideCount() {
  return Math.max(state.hdSlideCount, state.parsed?.slideCount ?? 0)
}

function getAspectRatio() {
  return state.parsed?.aspectRatio || 16 / 9
}

function formatRatioLabel(ratio) {
  if (Math.abs(ratio - 16 / 9) < 0.04) return '16:9'
  if (Math.abs(ratio - 4 / 3) < 0.04) return '4:3'
  if (Math.abs(ratio - 16 / 10) < 0.04) return '16:10'
  return `${ratio.toFixed(2)}:1`
}

async function computeSha256Hex(arrayBuffer) {
  const hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer)
  const arr = new Uint8Array(hashBuf)
  let hex = ''
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0')
  }
  return hex
}

function bytesToBase64(uint8) {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < uint8.length; i += step) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + step))
  }
  return btoa(binary)
}

function base64ToUint8(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function clearHdCache() {
  for (const url of state.hdUrls.values()) URL.revokeObjectURL(url)
  state.hdUrls.clear()
  state.hdBlobs.clear()
  state.hdSlideCount = 0
}

/** Build a pure DOM rendering of a parsed PPTX slide (instant preview & selectable text view). */
function buildDomSlideNode(slide, widthPt, targetWidthPx) {
  const root = document.createElement('div')
  root.className = 'dom-slide'
  root.style.background = slide.background || '#ffffff'
  const scale = targetWidthPx / (widthPt || 960)

  for (const item of slide.elements) {
    if (item.kind === 'image') {
      const box = document.createElement('div')
      box.className = 'dom-el'
      box.style.left = `${item.x}%`
      box.style.top = `${item.y}%`
      box.style.width = `${item.w}%`
      box.style.height = `${item.h}%`
      const img = document.createElement('img')
      img.src = item.url
      img.alt = ''
      box.appendChild(img)
      root.appendChild(box)
    } else if (item.kind === 'shape') {
      const hasText = item.paragraphs?.some((p) => p.runs.length > 0)
      if (!item.fill && !hasText) continue
      const box = document.createElement('div')
      box.className = hasText ? 'dom-text-box' : 'dom-el'
      box.style.left = `${item.x}%`
      box.style.top = `${item.y}%`
      box.style.width = `${item.w}%`
      box.style.height = `${item.h}%`
      if (item.fill) box.style.background = item.fill

      if (hasText) {
        for (const p of item.paragraphs) {
          const pEl = document.createElement('div')
          pEl.style.textAlign = p.align
          for (const r of p.runs) {
            const span = document.createElement('span')
            span.textContent = r.text
            span.style.fontFamily = r.fontFamily
            span.style.fontSize = `${Math.max(4, r.fontSizePt * scale)}px`
            if (r.letterSpacingPt) {
              span.style.letterSpacing = `${r.letterSpacingPt * scale}px`
            }
            span.style.color = r.color
            if (r.bold) span.style.fontWeight = '700'
            if (r.italic) span.style.fontStyle = 'italic'
            pEl.appendChild(span)
          }
          box.appendChild(pEl)
        }
      }
      root.appendChild(box)
    }
  }
  return root
}

async function fetchHdSlide(sha256, dpi, slideIndex, token) {
  if (state.hdUrls.has(slideIndex)) return state.hdUrls.get(slideIndex)
  const parts = []
  let offset = 0
  let mimeType = 'image/jpeg'
  while (true) {
    if (token !== state.loadToken) return null
    const res = await window.orca.plugin.request(
      'pptx.getSlideChunk',
      { sha256, dpi, slideIndex, offset, chunkSize: 140 * 1024 },
      { timeoutMs: 30_000 }
    )
    parts.push(base64ToUint8(res.b64))
    mimeType = res.mimeType || mimeType
    if (res.done) break
    offset = res.nextOffset
  }
  if (token !== state.loadToken) return null
  const blob = new Blob(parts, { type: mimeType })
  const url = URL.createObjectURL(blob)
  state.hdBlobs.set(slideIndex, blob)
  state.hdUrls.set(slideIndex, url)
  return url
}

async function kickOffHdRender(arrayBuffer, sha256, fileType, token) {
  if (!window.orca?.plugin?.request) {
    state.hdStatus = 'unavailable'
    state.hdReason = '插件后台未启用，当前显示结构视图。'
    renderAll()
    return
  }

  state.hdStatus = 'loading'
  renderToolbar()

  try {
    let prep = await window.orca.plugin.request(
      'pptx.prepare',
      { sha256, byteLength: arrayBuffer.byteLength, fileType },
      { timeoutMs: 120_000 }
    )
    if (token !== state.loadToken) return

    if (prep.status === 'need-upload') {
      const bytes = new Uint8Array(arrayBuffer)
      const chunkBytes = 120 * 1024
      const total = Math.max(1, Math.ceil(bytes.length / chunkBytes))
      for (let i = 0; i < total; i++) {
        if (token !== state.loadToken) return
        const slice = bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes)
        await window.orca.plugin.request(
          'pptx.uploadChunk',
          { sha256, index: i, total, b64: bytesToBase64(slice), fileType },
          { timeoutMs: 30_000 }
        )
      }
      prep = await window.orca.plugin.request(
        'pptx.convertUploaded',
        { sha256, fileType },
        { timeoutMs: 120_000 }
      )
      if (token !== state.loadToken) return
    }

    if (prep.status !== 'ready') {
      state.hdStatus = 'unavailable'
      state.hdReason = prep.reason || '高清渲染不可用'
      state.viewMode = 'structured'
      renderAll()
      return
    }

    state.hdSlideCount = prep.slideCount
    state.hdDpi = prep.dpi
    state.hdStatus = 'ready'
    if (state.current >= prep.slideCount) state.current = 0

    // Prioritize current slide first for snappy feel!
    await fetchHdSlide(sha256, prep.dpi, state.current, token)
    if (token !== state.loadToken) return
    renderAll()

    // Fetch remaining slides sequentially in background
    for (let i = 0; i < prep.slideCount; i++) {
      if (token !== state.loadToken) return
      if (state.hdUrls.has(i)) continue
      await fetchHdSlide(sha256, prep.dpi, i, token)
      if (token !== state.loadToken) return
      renderSidebar()
      if (state.layoutMode === 'grid') renderGrid()
      if (i === state.current) renderStage()
    }
  } catch (err) {
    if (token !== state.loadToken) return
    state.hdStatus = 'unavailable'
    state.hdReason = err instanceof Error ? err.message : String(err)
    if (state.parsed) state.viewMode = 'structured'
    renderAll()
  }
}

async function loadDocument(doc) {
  const token = ++state.loadToken
  if (state.parsed) {
    state.parsed.dispose()
    state.parsed = null
  }
  clearHdCache()
  state.current = 0
  state.hdStatus = 'loading'
  state.hdReason = ''

  if (!doc || doc.content?.kind !== 'bytes') {
    el.stageWrap.innerHTML =
      '<div class="center-state"><div class="title">无法读取文件</div><div>未接收到二进制 PPTX 内容。</div></div>'
    return
  }

  const bytes = doc.content.bytes
  state.fileType = (doc.fileType || 'pptx').replace(/^\./, '').toLowerCase()
  const sha256 = await computeSha256Hex(bytes)
  if (token !== state.loadToken) return
  state.sha256 = sha256

  // 1. Instant pure-JS PPTX parse (for .pptx files)
  if (state.fileType === 'pptx') {
    try {
      state.parsed = await parsePptxBuffer(bytes)
    } catch {
      state.parsed = null
    }
  }
  if (token !== state.loadToken) return

  renderAll()

  // 2. High-DPI LibreOffice pixel-perfect render in background
  kickOffHdRender(bytes, sha256, state.fileType, token)
}

function renderToolbar() {
  const total = getSlideCount()
  el.pageCounter.innerHTML =
    total > 0 ? `<strong>${state.current + 1}</strong> / ${total}` : '—'
  el.hudCounter.textContent = total > 0 ? `${state.current + 1} / ${total}` : '—'

  el.aspectBadge.textContent = `${state.fileType.toUpperCase()} · ${formatRatioLabel(getAspectRatio())}`

  el.engineBadge.className = 'badge'
  if (state.hdStatus === 'ready') {
    el.engineBadge.classList.add('engine-hd')
    el.engineBadge.innerHTML = `<span class="dot"></span>HD ${state.hdDpi} DPI`
    el.engineBadge.title = '已启用 LibreOffice + Poppler 像素级高清渲染'
  } else if (state.hdStatus === 'loading') {
    el.engineBadge.classList.add('engine-loading')
    el.engineBadge.innerHTML = '<span class="dot"></span>高清渲染中…'
    el.engineBadge.title = '正在后台渲染高清幻灯片，当前已可先行浏览'
  } else {
    el.engineBadge.innerHTML = '<span class="dot"></span>结构视图'
    el.engineBadge.title = state.hdReason || '内置结构化渲染视图'
  }

  el.btnPrev.disabled = state.current <= 0
  el.btnNext.disabled = total === 0 || state.current >= total - 1
  el.btnSidebar.classList.toggle('active', state.showSidebar && state.layoutMode === 'single')
  el.btnGrid.classList.toggle('active', state.layoutMode === 'grid')
  el.btnNotes.classList.toggle('active', state.showNotes)

  const canSwitchMode = Boolean(state.parsed) && state.hdStatus === 'ready'
  el.btnViewMode.disabled = !canSwitchMode
  el.btnViewMode.textContent = state.viewMode === 'hd' ? '切换文字视图' : '切换高清视图'
  el.btnViewMode.classList.toggle('active', state.viewMode === 'structured')

  el.btnExport.disabled = !state.hdBlobs.has(state.current) || !window.orca?.files?.saveAs
  el.zoomLabel.textContent = state.zoom === 'fit' ? '适应' : `${Math.round(state.zoom * 100)}%`
}

function renderSidebar() {
  el.sidebar.classList.toggle('hidden', !state.showSidebar || state.layoutMode === 'grid')
  const total = getSlideCount()
  const ratio = getAspectRatio()
  el.sidebar.innerHTML = ''

  for (let i = 0; i < total; i++) {
    const item = document.createElement('div')
    item.className = `thumb-item${i === state.current ? ' active' : ''}`
    item.addEventListener('click', () => goToSlide(i))

    const num = document.createElement('div')
    num.className = 'thumb-num'
    num.textContent = String(i + 1)

    const frame = document.createElement('div')
    frame.className = 'thumb-frame'
    frame.style.aspectRatio = String(ratio)

    const hdUrl = state.hdUrls.get(i)
    if (hdUrl) {
      const img = document.createElement('img')
      img.src = hdUrl
      img.alt = `Slide ${i + 1}`
      frame.appendChild(img)
    } else if (state.parsed?.slides[i]) {
      frame.appendChild(buildDomSlideNode(state.parsed.slides[i], state.parsed.widthPt, 156))
    }

    item.append(num, frame)
    el.sidebar.appendChild(item)
  }

  const activeEl = el.sidebar.querySelector('.thumb-item.active')
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
}

function computeCanvasSize() {
  const ratio = getAspectRatio()
  const rect = el.stageWrap.getBoundingClientRect()
  const padX = state.presenting ? 32 : 72
  const padY = state.presenting ? 32 : 56
  const availW = Math.max(240, rect.width - padX)
  const availH = Math.max(180, rect.height - padY)

  let fitW = availW
  let fitH = fitW / ratio
  if (fitH > availH) {
    fitH = availH
    fitW = fitH * ratio
  }

  if (state.zoom === 'fit') {
    return { w: Math.round(fitW), h: Math.round(fitH) }
  }
  const baseW = 960
  const w = Math.round(baseW * state.zoom)
  return { w, h: Math.round(w / ratio) }
}

function renderStage() {
  const isGrid = state.layoutMode === 'grid'
  el.stageWrap.style.display = isGrid ? 'none' : 'flex'
  el.gridView.style.display = isGrid ? 'grid' : 'none'

  if (isGrid) {
    renderGrid()
    return
  }

  const total = getSlideCount()
  if (total === 0) {
    el.stageWrap.innerHTML =
      state.hdStatus === 'loading'
        ? '<div class="center-state"><div class="title">正在渲染幻灯片…</div><div>首次打开将由 LibreOffice 生成高清画面并缓存</div></div>'
        : `<div class="center-state"><div class="title">未能加载幻灯片</div><div>${state.hdReason || '该文件为空或格式暂不支持'}</div></div>`
    return
  }

  const { w, h } = computeCanvasSize()
  const canvas = document.createElement('div')
  canvas.className = 'slide-canvas'
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`

  const hdUrl = state.hdUrls.get(state.current)
  if (state.viewMode === 'hd' && hdUrl) {
    const img = document.createElement('img')
    img.className = 'hd-slide'
    img.src = hdUrl
    img.alt = `Slide ${state.current + 1}`
    canvas.appendChild(img)
  } else if (state.parsed?.slides[state.current]) {
    canvas.appendChild(
      buildDomSlideNode(state.parsed.slides[state.current], state.parsed.widthPt, w)
    )
  } else if (hdUrl) {
    const img = document.createElement('img')
    img.className = 'hd-slide'
    img.src = hdUrl
    canvas.appendChild(img)
  }

  el.stageWrap.innerHTML = ''
  el.stageWrap.appendChild(canvas)
}

function renderGrid() {
  const total = getSlideCount()
  const ratio = getAspectRatio()
  el.gridView.innerHTML = ''

  for (let i = 0; i < total; i++) {
    const card = document.createElement('div')
    card.className = `grid-card${i === state.current ? ' active' : ''}`
    card.addEventListener('click', () => {
      state.current = i
      state.layoutMode = 'single'
      renderAll()
    })

    const thumb = document.createElement('div')
    thumb.className = 'grid-thumb'
    thumb.style.aspectRatio = String(ratio)

    const hdUrl = state.hdUrls.get(i)
    if (hdUrl) {
      const img = document.createElement('img')
      img.src = hdUrl
      img.alt = `Slide ${i + 1}`
      thumb.appendChild(img)
    } else if (state.parsed?.slides[i]) {
      thumb.appendChild(buildDomSlideNode(state.parsed.slides[i], state.parsed.widthPt, 300))
    }

    const firstLine = (state.parsed?.slides[i]?.plainText || '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean)

    const meta = document.createElement('div')
    meta.className = 'grid-meta'
    const title = document.createElement('span')
    title.className = 'grid-title'
    title.textContent = firstLine || `第 ${i + 1} 页`
    const idx = document.createElement('span')
    idx.className = 'grid-idx'
    idx.textContent = `${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`

    meta.append(title, idx)
    card.append(thumb, meta)
    el.gridView.appendChild(card)
  }
}

function renderNotes() {
  el.notesDrawer.classList.toggle('hidden', !state.showNotes || state.presenting)
  if (!state.showNotes) return

  const slide = state.parsed?.slides[state.current]
  if (!slide) {
    el.notesTitle.textContent = `第 ${state.current + 1} 页 · 文本与备注`
    el.notesBody.textContent = '当前页暂无可提取的文本或演讲备注。'
    return
  }

  const sections = []
  if (slide.notes) sections.push(`【演讲者备注】\n${slide.notes}`)
  if (slide.plainText) sections.push(`【幻灯片正文】\n${slide.plainText}`)
  el.notesTitle.textContent = `第 ${state.current + 1} 页 · 演讲备注与提取文字`
  el.notesBody.textContent = sections.length > 0 ? sections.join('\n\n') : '（此页无文本内容）'
}

function renderAll() {
  el.app.classList.toggle('presenting', state.presenting)
  renderToolbar()
  renderSidebar()
  renderStage()
  renderNotes()
}

function goToSlide(idx) {
  const total = getSlideCount()
  if (total === 0) return
  const clamped = Math.max(0, Math.min(total - 1, idx))
  if (clamped === state.current && state.layoutMode === 'single') return
  state.current = clamped
  if (state.hdStatus === 'ready' && !state.hdUrls.has(clamped) && state.sha256) {
    fetchHdSlide(state.sha256, state.hdDpi, clamped, state.loadToken).then(() => renderAll())
  }
  renderAll()
}

function stepZoom(delta) {
  const steps = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
  const currentNum = state.zoom === 'fit' ? 1.0 : state.zoom
  let next = currentNum + delta * 0.25
  if (delta > 0) next = steps.find((s) => s > currentNum + 0.01) ?? steps[steps.length - 1]
  else next = [...steps].reverse().find((s) => s < currentNum - 0.01) ?? steps[0]
  state.zoom = next
  renderToolbar()
  renderStage()
}

async function exportCurrentSlide() {
  const blob = state.hdBlobs.get(state.current)
  if (!blob || !window.orca?.files?.saveAs) return
  const buf = await blob.arrayBuffer()
  const ext = blob.type === 'image/png' ? 'png' : 'jpg'
  await window.orca.files.saveAs({
    suggestedName: `slide-${String(state.current + 1).padStart(2, '0')}.${ext}`,
    mimeType: blob.type,
    data: buf
  })
}

function togglePresent(on) {
  state.presenting = typeof on === 'boolean' ? on : !state.presenting
  if (state.presenting) {
    state.layoutMode = 'single'
    state.zoom = 'fit'
    document.documentElement.requestFullscreen?.().catch(() => {})
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {})
  }
  renderAll()
}

// Event Wiring
el.btnSidebar.addEventListener('click', () => {
  state.showSidebar = !state.showSidebar
  renderAll()
})
el.btnPrev.addEventListener('click', () => goToSlide(state.current - 1))
el.btnNext.addEventListener('click', () => goToSlide(state.current + 1))
el.hudPrev.addEventListener('click', () => goToSlide(state.current - 1))
el.hudNext.addEventListener('click', () => goToSlide(state.current + 1))
el.hudExit.addEventListener('click', () => togglePresent(false))
el.btnZoomOut.addEventListener('click', () => stepZoom(-1))
el.btnZoomIn.addEventListener('click', () => stepZoom(1))
el.btnZoomFit.addEventListener('click', () => {
  state.zoom = 'fit'
  renderToolbar()
  renderStage()
})
el.btnViewMode.addEventListener('click', () => {
  state.viewMode = state.viewMode === 'hd' ? 'structured' : 'hd'
  renderToolbar()
  renderStage()
})
el.btnGrid.addEventListener('click', () => {
  state.layoutMode = state.layoutMode === 'grid' ? 'single' : 'grid'
  renderAll()
})
el.btnNotes.addEventListener('click', () => {
  state.showNotes = !state.showNotes
  renderToolbar()
  renderNotes()
  renderStage()
})
el.btnExport.addEventListener('click', exportCurrentSlide)
el.btnPresent.addEventListener('click', () => togglePresent(true))
el.btnCopyText.addEventListener('click', async () => {
  const txt = el.notesBody.textContent || ''
  if (!txt) return
  try {
    await navigator.clipboard.writeText(txt)
    const old = el.btnCopyText.textContent
    el.btnCopyText.textContent = '已复制'
    setTimeout(() => {
      el.btnCopyText.textContent = old
    }, 1200)
  } catch {
    // ignore
  }
})

// Keyboard Navigation
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      stepZoom(1)
    } else if (e.key === '-') {
      e.preventDefault()
      stepZoom(-1)
    } else if (e.key === '0') {
      e.preventDefault()
      state.zoom = 'fit'
      renderToolbar()
      renderStage()
    }
    return
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
    if (state.layoutMode === 'single') {
      e.preventDefault()
      goToSlide(state.current + 1)
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
    if (state.layoutMode === 'single') {
      e.preventDefault()
      goToSlide(state.current - 1)
    }
  } else if (e.key === 'Home') {
    e.preventDefault()
    goToSlide(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    goToSlide(getSlideCount() - 1)
  } else if (e.key === 'g' || e.key === 'G') {
    if (!state.presenting) {
      state.layoutMode = state.layoutMode === 'grid' ? 'single' : 'grid'
      renderAll()
    }
  } else if (e.key === 'n' || e.key === 'N') {
    if (!state.presenting) {
      state.showNotes = !state.showNotes
      renderAll()
    }
  } else if (e.key === 'f' || e.key === 'F') {
    togglePresent()
  } else if (e.key === 'Escape' && state.presenting) {
    togglePresent(false)
  }
})

// Ctrl+Wheel zoom on stage
el.stageWrap.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    stepZoom(e.deltaY < 0 ? 1 : -1)
  },
  { passive: false }
)

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.presenting) {
    state.presenting = false
    renderAll()
  }
})

// Responsive canvas sizing
const resizeObserver = new ResizeObserver(() => {
  if (state.layoutMode === 'single' && state.zoom === 'fit') renderStage()
})
resizeObserver.observe(el.stageWrap)

// Subscribe to Orca theme & document updates
window.orca.on('theme', () => {
  renderToolbar()
})

window.orca.document.onDidChange((doc) => {
  loadDocument(doc)
})

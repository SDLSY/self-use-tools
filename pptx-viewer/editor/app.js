import { parsePptxBuffer } from './pptx-parse.js'
import { clearHdCache, computeSha256Hex, fetchHdSlide, kickOffHdRender } from './hd-renderer.js'
import { getSlideCount } from './slide-dom-renderer.js'
import {
  renderGrid as renderGridView,
  renderNotes as renderNotesView,
  renderSidebar as renderSidebarView,
  renderStage as renderStageView,
  renderToolbar as renderToolbarView
} from './view-renderers.js'

const state = {
  sha256: null,
  fileType: 'pptx',
  parsed: null,
  hdSlideCount: 0,
  hdDpi: 180,
  hdUrls: new Map(),
  hdBlobs: new Map(),
  hdStatus: 'idle',
  hdReason: '',
  viewMode: 'hd',
  layoutMode: 'single',
  current: 0,
  zoom: 'fit',
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

function openSlideFromGrid(idx) {
  state.current = idx
  state.layoutMode = 'single'
  renderAll()
}

const renderToolbar = () => renderToolbarView(state, el)
const renderSidebar = () => renderSidebarView(state, el, goToSlide)
const renderGrid = () => renderGridView(state, el, openSlideFromGrid)
const renderStage = () => renderStageView(state, el, openSlideFromGrid)
const renderNotes = () => renderNotesView(state, el)

function renderAll() {
  el.app.classList.toggle('presenting', state.presenting)
  renderToolbar()
  renderSidebar()
  renderStage()
  renderNotes()
}

const renderCallbacks = { renderAll, renderToolbar, renderSidebar, renderGrid, renderStage }

async function loadDocument(doc) {
  const token = ++state.loadToken
  if (state.parsed) {
    state.parsed.dispose()
    state.parsed = null
  }
  clearHdCache(state)
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

  if (state.fileType === 'pptx') {
    try {
      state.parsed = await parsePptxBuffer(bytes)
    } catch {
      state.parsed = null
    }
  }
  if (token !== state.loadToken) return

  renderAll()
  kickOffHdRender(state, renderCallbacks, bytes, sha256, state.fileType, token)
}

function goToSlide(idx) {
  const total = getSlideCount(state)
  if (total === 0) return
  const clamped = Math.max(0, Math.min(total - 1, idx))
  if (clamped === state.current && state.layoutMode === 'single') return
  state.current = clamped
  if (state.hdStatus === 'ready' && !state.hdUrls.has(clamped) && state.sha256) {
    fetchHdSlide(state, state.sha256, state.hdDpi, clamped, state.loadToken).then(() => renderAll())
  }
  renderAll()
}

function stepZoom(delta) {
  const steps = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
  const currentNum = state.zoom === 'fit' ? 1.0 : state.zoom
  const next =
    delta > 0
      ? (steps.find((s) => s > currentNum + 0.01) ?? steps[steps.length - 1])
      : ([...steps].reverse().find((s) => s < currentNum - 0.01) ?? steps[0])
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
    goToSlide(getSlideCount(state) - 1)
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

const resizeObserver = new ResizeObserver(() => {
  if (state.layoutMode === 'single' && state.zoom === 'fit') renderStage()
})
resizeObserver.observe(el.stageWrap)

window.orca.on('theme', () => {
  renderToolbar()
})

window.orca.document.onDidChange((doc) => {
  loadDocument(doc)
})

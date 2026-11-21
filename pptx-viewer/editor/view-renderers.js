import {
  buildDomSlideNode,
  formatRatioLabel,
  getAspectRatio,
  getSlideCount
} from './slide-dom-renderer.js'

export function renderToolbar(state, el) {
  const total = getSlideCount(state)
  el.pageCounter.innerHTML =
    total > 0 ? `<strong>${state.current + 1}</strong> / ${total}` : '—'
  el.hudCounter.textContent = total > 0 ? `${state.current + 1} / ${total}` : '—'

  el.aspectBadge.textContent = `${state.fileType.toUpperCase()} · ${formatRatioLabel(getAspectRatio(state))}`

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

export function renderSidebar(state, el, onSelectSlide) {
  el.sidebar.classList.toggle('hidden', !state.showSidebar || state.layoutMode === 'grid')
  const total = getSlideCount(state)
  const ratio = getAspectRatio(state)
  el.sidebar.innerHTML = ''

  for (let i = 0; i < total; i++) {
    const item = document.createElement('div')
    item.className = `thumb-item${i === state.current ? ' active' : ''}`
    item.addEventListener('click', () => onSelectSlide(i))

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

function computeCanvasSize(state, el) {
  const ratio = getAspectRatio(state)
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

export function renderGrid(state, el, onOpenSlide) {
  const total = getSlideCount(state)
  const ratio = getAspectRatio(state)
  el.gridView.innerHTML = ''

  for (let i = 0; i < total; i++) {
    const card = document.createElement('div')
    card.className = `grid-card${i === state.current ? ' active' : ''}`
    card.addEventListener('click', () => onOpenSlide(i))

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

export function renderStage(state, el, onOpenGridSlide) {
  const isGrid = state.layoutMode === 'grid'
  el.stageWrap.style.display = isGrid ? 'none' : 'flex'
  el.gridView.style.display = isGrid ? 'grid' : 'none'

  if (isGrid) {
    renderGrid(state, el, onOpenGridSlide)
    return
  }

  const total = getSlideCount(state)
  if (total === 0) {
    el.stageWrap.innerHTML =
      state.hdStatus === 'loading'
        ? '<div class="center-state"><div class="title">正在渲染幻灯片…</div><div>首次打开将由 LibreOffice 生成高清画面并缓存</div></div>'
        : `<div class="center-state"><div class="title">未能加载幻灯片</div><div>${state.hdReason || '该文件为空或格式暂不支持'}</div></div>`
    return
  }

  const { w, h } = computeCanvasSize(state, el)
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

export function renderNotes(state, el) {
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

/** Pure DOM rendering of a parsed PPTX slide (instant preview & selectable text view). */

export function getSlideCount(state) {
  return Math.max(state.hdSlideCount, state.parsed?.slideCount ?? 0)
}

export function getAspectRatio(state) {
  return state.parsed?.aspectRatio || 16 / 9
}

export function formatRatioLabel(ratio) {
  if (Math.abs(ratio - 16 / 9) < 0.04) return '16:9'
  if (Math.abs(ratio - 4 / 3) < 0.04) return '4:3'
  if (Math.abs(ratio - 16 / 10) < 0.04) return '16:10'
  return `${ratio.toFixed(2)}:1`
}

export function buildDomSlideNode(slide, widthPt, targetWidthPx) {
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

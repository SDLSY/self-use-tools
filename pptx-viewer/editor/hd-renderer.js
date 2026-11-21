/** High-DPI LibreOffice IPC orchestration, chunk streaming, and ObjectURL cache. */

export async function computeSha256Hex(arrayBuffer) {
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

export function clearHdCache(state) {
  for (const url of state.hdUrls.values()) URL.revokeObjectURL(url)
  state.hdUrls.clear()
  state.hdBlobs.clear()
  state.hdSlideCount = 0
}

export async function fetchHdSlide(state, sha256, dpi, slideIndex, token) {
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

export async function kickOffHdRender(state, callbacks, arrayBuffer, sha256, fileType, token) {
  if (!window.orca?.plugin?.request) {
    state.hdStatus = 'unavailable'
    state.hdReason = '插件后台未启用，当前显示结构视图。'
    callbacks.renderAll()
    return
  }

  state.hdStatus = 'loading'
  callbacks.renderToolbar()

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
      callbacks.renderAll()
      return
    }

    state.hdSlideCount = prep.slideCount
    state.hdDpi = prep.dpi
    state.hdStatus = 'ready'
    if (state.current >= prep.slideCount) state.current = 0

    // Prioritize current slide first for snappy feel.
    await fetchHdSlide(state, sha256, prep.dpi, state.current, token)
    if (token !== state.loadToken) return
    callbacks.renderAll()

    for (let i = 0; i < prep.slideCount; i++) {
      if (token !== state.loadToken) return
      if (state.hdUrls.has(i)) continue
      await fetchHdSlide(state, sha256, prep.dpi, i, token)
      if (token !== state.loadToken) return
      callbacks.renderSidebar()
      if (state.layoutMode === 'grid') callbacks.renderGrid()
      if (i === state.current) callbacks.renderStage()
    }
  } catch (err) {
    if (token !== state.loadToken) return
    state.hdStatus = 'unavailable'
    state.hdReason = err instanceof Error ? err.message : String(err)
    if (state.parsed) state.viewMode = 'structured'
    callbacks.renderAll()
  }
}

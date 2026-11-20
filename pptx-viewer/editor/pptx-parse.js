/**
 * Zero-dependency browser PPTX (ZIP + DrawingML XML) parser.
 * Uses native DecompressionStream('deflate-raw') & DOMParser for instant (<50ms)
 * slide previews, selectable text, embedded images, and speaker notes.
 */

const textDecoder = new TextDecoder('utf-8')

function findEocdOffset(bytes) {
  const minOffset = Math.max(0, bytes.length - 65557)
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i
    }
  }
  return -1
}

async function inflateRaw(compressed) {
  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  writer.write(compressed)
  writer.close()
  const chunks = []
  const reader = ds.readable.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function readZipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  const view = new DataView(arrayBuffer)
  const eocd = findEocdOffset(bytes)
  if (eocd < 0) throw new Error('Not a valid ZIP/PPTX archive')

  const entryCount = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)

  const entries = new Map()
  let pos = cdOffset
  for (let i = 0; i < entryCount && pos + 46 <= bytes.length; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break
    const method = view.getUint16(pos + 10, true)
    const compSize = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localHeaderOffset = view.getUint32(pos + 42, true)

    const name = textDecoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    entries.set(name, { method, compSize, localHeaderOffset })
    pos += 46 + nameLen + extraLen + commentLen
  }

  async function getBytes(name) {
    const meta = entries.get(name)
    if (!meta) return null
    const lh = meta.localHeaderOffset
    if (view.getUint32(lh, true) !== 0x04034b50) return null
    const nameLen = view.getUint16(lh + 26, true)
    const extraLen = view.getUint16(lh + 28, true)
    const dataStart = lh + 30 + nameLen + extraLen
    const raw = bytes.subarray(dataStart, dataStart + meta.compSize)
    if (meta.method === 0) return raw.slice()
    if (meta.method === 8) return await inflateRaw(raw)
    return null
  }

  async function getText(name) {
    const data = await getBytes(name)
    return data ? textDecoder.decode(data) : null
  }

  return { entries, getBytes, getText }
}

function parseXml(xmlText) {
  if (!xmlText) return null
  return new DOMParser().parseFromString(xmlText, 'application/xml')
}

function resolveRelPath(baseFile, target) {
  if (!target) return ''
  if (target.startsWith('/')) return target.slice(1)
  const parts = baseFile.split('/')
  parts.pop()
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

function parseRels(xmlText, baseFile) {
  const map = new Map()
  const doc = parseXml(xmlText)
  if (!doc) return map
  const rels = doc.getElementsByTagName('Relationship')
  for (let i = 0; i < rels.length; i++) {
    const el = rels[i]
    const id = el.getAttribute('Id')
    const target = el.getAttribute('Target')
    const type = el.getAttribute('Type') || ''
    if (id && target) {
      map.set(id, { target: resolveRelPath(baseFile, target), type })
    }
  }
  return map
}

function getSolidFillHex(parentEl) {
  if (!parentEl) return null
  const solid = parentEl.getElementsByTagName('a:solidFill')[0]
  if (!solid) return null
  const srgb = solid.getElementsByTagName('a:srgbClr')[0]
  if (srgb) {
    const val = srgb.getAttribute('val')
    if (val && /^[0-9a-fA-F]{6}$/.test(val)) return `#${val}`
  }
  return null
}

function mimeFromPath(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

export async function parsePptxBuffer(arrayBuffer) {
  const zip = readZipEntries(arrayBuffer)
  const createdUrls = []

  const presXml = parseXml(await zip.getText('ppt/presentation.xml'))
  if (!presXml) throw new Error('Invalid PPTX: missing ppt/presentation.xml')

  let widthEmu = 12192000 // default 16:9 (13.333 in)
  let heightEmu = 6858000 // default 7.5 in
  const sldSz = presXml.getElementsByTagName('p:sldSz')[0]
  if (sldSz) {
    const cx = Number(sldSz.getAttribute('cx'))
    const cy = Number(sldSz.getAttribute('cy'))
    if (cx > 0 && cy > 0) {
      widthEmu = cx
      heightEmu = cy
    }
  }

  const presRels = parseRels(await zip.getText('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml')
  const sldIds = presXml.getElementsByTagName('p:sldId')
  const slidePaths = []
  for (let i = 0; i < sldIds.length; i++) {
    const rId =
      sldIds[i].getAttribute('r:id') ||
      sldIds[i].getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      )
    const rel = rId ? presRels.get(rId) : null
    if (rel?.target) slidePaths.push(rel.target)
  }

  const mediaUrlCache = new Map()
  async function getMediaUrl(mediaPath) {
    if (mediaUrlCache.has(mediaPath)) return mediaUrlCache.get(mediaPath)
    const bytes = await zip.getBytes(mediaPath)
    if (!bytes) return null
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeFromPath(mediaPath) }))
    createdUrls.push(url)
    mediaUrlCache.set(mediaPath, url)
    return url
  }

  const slides = []
  for (let idx = 0; idx < slidePaths.length; idx++) {
    const slidePath = slidePaths[idx]
    const slideXml = parseXml(await zip.getText(slidePath))
    if (!slideXml) continue

    const fileName = slidePath.split('/').pop()
    const relsPath = slidePath.replace(fileName, `_rels/${fileName}.rels`)
    const slideRels = parseRels(await zip.getText(relsPath), slidePath)

    // Background solid fill
    const bgEl = slideXml.getElementsByTagName('p:bg')[0]
    const background = getSolidFillHex(bgEl) || '#ffffff'

    const elements = []
    const textChunks = []
    const spTree = slideXml.getElementsByTagName('p:spTree')[0]

    if (spTree) {
      for (let c = 0; c < spTree.children.length; c++) {
        const node = spTree.children[c]
        const tag = node.tagName

        if (tag === 'p:pic') {
          const xfrm = node.getElementsByTagName('a:xfrm')[0]
          const off = xfrm?.getElementsByTagName('a:off')[0]
          const ext = xfrm?.getElementsByTagName('a:ext')[0]
          const blip = node.getElementsByTagName('a:blip')[0]
          const embedId =
            blip?.getAttribute('r:embed') ||
            blip?.getAttributeNS(
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
              'embed'
            )
          const rel = embedId ? slideRels.get(embedId) : null
          if (off && ext && rel?.target) {
            const url = await getMediaUrl(rel.target)
            if (url) {
              elements.push({
                kind: 'image',
                x: (Number(off.getAttribute('x') || 0) / widthEmu) * 100,
                y: (Number(off.getAttribute('y') || 0) / heightEmu) * 100,
                w: (Number(ext.getAttribute('cx') || 0) / widthEmu) * 100,
                h: (Number(ext.getAttribute('cy') || 0) / heightEmu) * 100,
                url
              })
            }
          }
        } else if (tag === 'p:sp') {
          const spPr = node.getElementsByTagName('p:spPr')[0]
          const xfrm = spPr?.getElementsByTagName('a:xfrm')[0]
          const off = xfrm?.getElementsByTagName('a:off')[0]
          const ext = xfrm?.getElementsByTagName('a:ext')[0]
          if (!off || !ext) continue

          // Direct solid fill on spPr (avoid grabbing text run fills)
          let fill = null
          if (spPr) {
            for (let k = 0; k < spPr.children.length; k++) {
              if (spPr.children[k].tagName === 'a:solidFill') {
                const srgb = spPr.children[k].getElementsByTagName('a:srgbClr')[0]
                if (srgb) fill = `#${srgb.getAttribute('val')}`
              }
            }
          }

          const paragraphs = []
          const txBody = node.getElementsByTagName('p:txBody')[0]
          if (txBody) {
            const pEls = txBody.getElementsByTagName('a:p')
            for (let pi = 0; pi < pEls.length; pi++) {
              const pEl = pEls[pi]
              const pPr = pEl.getElementsByTagName('a:pPr')[0]
              const algn = pPr?.getAttribute('algn') || 'l'
              const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left'
              const runs = []
              const rEls = pEl.getElementsByTagName('a:r')
              const lineTexts = []
              for (let ri = 0; ri < rEls.length; ri++) {
                const rEl = rEls[ri]
                const tEl = rEl.getElementsByTagName('a:t')[0]
                const text = tEl?.textContent ?? ''
                if (!text) continue
                lineTexts.push(text)
                const rPr = rEl.getElementsByTagName('a:rPr')[0]
                const szAttr = rPr?.getAttribute('sz')
                const fontSizePt = szAttr ? Number(szAttr) / 100 : 14
                const spcAttr = rPr?.getAttribute('spc')
                const letterSpacingPt = spcAttr ? Number(spcAttr) / 100 : 0
                const bold = rPr?.getAttribute('b') === '1'
                const italic = rPr?.getAttribute('i') === '1'
                const color = getSolidFillHex(rPr) || '#1d1b18'
                const latin = rPr?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface')
                const ea = rPr?.getElementsByTagName('a:ea')[0]?.getAttribute('typeface')
                const fontFamily = [latin, ea, 'Noto Sans SC', 'sans-serif']
                  .filter(Boolean)
                  .map((f) => (f.includes(' ') ? `"${f}"` : f))
                  .join(', ')
                runs.push({ text, fontSizePt, letterSpacingPt, bold, italic, color, fontFamily })
              }
              if (lineTexts.length > 0) textChunks.push(lineTexts.join(''))
              paragraphs.push({ align, runs })
            }
          }

          elements.push({
            kind: 'shape',
            x: (Number(off.getAttribute('x') || 0) / widthEmu) * 100,
            y: (Number(off.getAttribute('y') || 0) / heightEmu) * 100,
            w: (Number(ext.getAttribute('cx') || 0) / widthEmu) * 100,
            h: (Number(ext.getAttribute('cy') || 0) / heightEmu) * 100,
            fill,
            paragraphs
          })
        }
      }
    }

    // Speaker notes
    let notes = ''
    for (const rel of slideRels.values()) {
      if (rel.type.includes('notesSlide')) {
        const notesXml = parseXml(await zip.getText(rel.target))
        if (notesXml) {
          const ts = notesXml.getElementsByTagName('a:t')
          const parts = []
          for (let ti = 0; ti < ts.length; ti++) {
            const val = ts[ti].textContent?.trim()
            if (val && !/^\d+$/.test(val)) parts.push(val)
          }
          notes = parts.join('\n')
        }
      }
    }

    slides.push({
      index: idx,
      background,
      elements,
      plainText: textChunks.join('\n'),
      notes
    })
  }

  return {
    widthPt: widthEmu / 12700,
    heightPt: heightEmu / 12700,
    aspectRatio: widthEmu / heightEmu,
    slideCount: slides.length,
    slides,
    dispose() {
      for (const u of createdUrls) URL.revokeObjectURL(u)
    }
  }
}

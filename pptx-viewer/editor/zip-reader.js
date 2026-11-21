/** Zero-dependency browser ZIP reader backed by native DecompressionStream('deflate-raw'). */

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

export function readZipEntries(arrayBuffer) {
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

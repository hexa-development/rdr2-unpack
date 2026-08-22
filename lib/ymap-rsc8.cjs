const zlib = require('node:zlib')

const RSC8_MAGIC = 0x38435352
const CMAP_DATA_HASH = 0xd3593fa6
const CMAP_DATA_SIZE = 0x260
const ENTITY_SIZE = 0x90
const ENTITY_MODEL_HASH = 0x28
const ENTITY_POSITION = 0x40
const ENTITY_QUATERNION = 0x50
const ENTITY_SCALE_XY = 0x60
const ENTITY_SCALE_Z = 0x64
const CMAP_ENTITY_COUNT = 0x68
const MAX_ENTITY_COUNT = 100_000

function joaat(value) {
  let hash = 0
  for (const character of String(value).toLowerCase()) {
    hash = (hash + character.charCodeAt(0)) >>> 0
    hash = (hash + (hash << 10)) >>> 0
    hash ^= hash >>> 6
  }
  hash = (hash + (hash << 3)) >>> 0
  hash ^= hash >>> 11
  hash = (hash + (hash << 15)) >>> 0
  return hash >>> 0
}

function virtualOffset(pointer) {
  const low = Number(pointer & 0xffffffffn) >>> 0
  return (low & 0xf0000000) === 0x50000000 ? low & 0x0fffffff : -1
}

function findCMapData(system) {
  let result = null
  for (let offset = 0; offset + 16 <= system.length; offset += 4) {
    if (system.readUInt32LE(offset) !== CMAP_DATA_HASH) continue
    if (system.readUInt32LE(offset + 4) !== CMAP_DATA_SIZE) continue
    const rootOffset = virtualOffset(system.readBigUInt64LE(offset + 8))
    if (rootOffset < 0 || rootOffset + CMAP_DATA_SIZE > system.length) continue
    result = { descriptorOffset: offset, rootOffset }
  }
  if (!result) throw new Error('CMapData descriptor was not found in this RSC8 resource')
  return result
}

function finiteInRange(value, limit) {
  return Number.isFinite(value) && Math.abs(value) <= limit
}

function isEntityRecord(system, offset) {
  if (offset < 0 || offset + ENTITY_SIZE > system.length) return false
  const modelHash = system.readUInt32LE(offset + ENTITY_MODEL_HASH)
  if (!modelHash) return false

  const x = system.readFloatLE(offset + ENTITY_POSITION)
  const y = system.readFloatLE(offset + ENTITY_POSITION + 4)
  const z = system.readFloatLE(offset + ENTITY_POSITION + 8)
  if (!finiteInRange(x, 50_000) || !finiteInRange(y, 50_000) || !finiteInRange(z, 50_000)) return false

  const quaternion = [0, 4, 8, 12].map((delta) => system.readFloatLE(offset + ENTITY_QUATERNION + delta))
  if (!quaternion.every((value) => finiteInRange(value, 2))) return false
  const quaternionLength = quaternion.reduce((total, value) => total + value * value, 0)
  if (quaternionLength < 0.5 || quaternionLength > 1.5) return false

  const scaleXY = system.readFloatLE(offset + ENTITY_SCALE_XY)
  const scaleZ = system.readFloatLE(offset + ENTITY_SCALE_Z)
  return finiteInRange(scaleXY, 10_000) && finiteInRange(scaleZ, 10_000)
    && Math.abs(scaleXY) >= 0.0001 && Math.abs(scaleZ) >= 0.0001
}

function findEntityArray(system, entityCount) {
  if (!entityCount) return -1
  const requiredBytes = entityCount * ENTITY_SIZE
  for (let start = 0; start + requiredBytes <= system.length; start += 0x10) {
    if (!isEntityRecord(system, start)) continue
    let valid = true
    for (let index = 1; index < entityCount; index += 1) {
      if (!isEntityRecord(system, start + index * ENTITY_SIZE)) {
        valid = false
        break
      }
    }
    if (valid) return start
  }
  throw new Error(`Unable to locate ${entityCount} contiguous CEntityDef records`)
}

function quaternionToEulerDegrees(x, y, z, w) {
  const length = Math.hypot(x, y, z, w) || 1
  x /= length
  y /= length
  z /= length
  w /= length

  const test = 2 * (w * y - z * x)
  const rx = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const ry = Math.asin(Math.max(-1, Math.min(1, test)))
  const rz = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  const toDegrees = 180 / Math.PI
  return { x: rx * toDegrees, y: ry * toDegrees, z: rz * toDegrees }
}

function parseRsc8Ymap(input, resolveModelName = () => null) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (data.length < 17 || data.readUInt32LE(0) !== RSC8_MAGIC) {
    throw new Error('Not an RSC8 YMAP file')
  }
  const expectedSize = data.readUInt32LE(8)
  if (!expectedSize || expectedSize > 512 * 1024 * 1024) throw new Error('Invalid RSC8 system size')
  const payload = data.subarray(16)
  // ArchiveExplorer exposes RPF8 resources as an already decrypted and
  // decompressed stream, then restores the 16-byte RSC8 header. Keep support
  // for ordinary standalone deflate resources as well.
  const system = payload.length === expectedSize
    ? payload
    : zlib.inflateRawSync(payload, { maxOutputLength: expectedSize })
  if (system.length !== expectedSize) {
    throw new Error(`RSC8 size mismatch: expected ${expectedSize}, got ${system.length}`)
  }

  const { rootOffset } = findCMapData(system)
  const entityCount = system.readUInt16LE(rootOffset + CMAP_ENTITY_COUNT)
  if (entityCount > MAX_ENTITY_COUNT) throw new Error(`YMAP entity count ${entityCount} exceeds the safety limit`)
  const entityStart = findEntityArray(system, entityCount)
  const entities = []

  for (let index = 0; index < entityCount; index += 1) {
    const offset = entityStart + index * ENTITY_SIZE
    const modelHash = system.readUInt32LE(offset + ENTITY_MODEL_HASH)
    const resolvedName = resolveModelName(modelHash)
    const hashLabel = `0x${modelHash.toString(16).toUpperCase().padStart(8, '0')}`
    const qx = system.readFloatLE(offset + ENTITY_QUATERNION)
    const qy = system.readFloatLE(offset + ENTITY_QUATERNION + 4)
    const qz = system.readFloatLE(offset + ENTITY_QUATERNION + 8)
    const qw = system.readFloatLE(offset + ENTITY_QUATERNION + 12)
    const scaleXY = system.readFloatLE(offset + ENTITY_SCALE_XY)
    entities.push({
      name: resolvedName || hashLabel,
      model: resolvedName || hashLabel,
      modelHash,
      position: {
        x: system.readFloatLE(offset + ENTITY_POSITION),
        y: system.readFloatLE(offset + ENTITY_POSITION + 4),
        z: system.readFloatLE(offset + ENTITY_POSITION + 8),
      },
      rotation: quaternionToEulerDegrees(qx, qy, qz, qw),
      quaternion: { x: qx, y: qy, z: qz, w: qw },
      scale: { x: scaleXY, y: scaleXY, z: system.readFloatLE(offset + ENTITY_SCALE_Z) },
    })
  }

  return { version: data.readUInt32LE(4), systemSize: system.length, entityCount, entities }
}

function xmlAttribute(tag, name, fallback = 0) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  const value = match ? Number(match[1]) : fallback
  return Number.isFinite(value) ? value : fallback
}

function parseXmlYmap(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const xml = data.toString('utf8')
  if (!/<CMapData\b/i.test(xml)) throw new Error('Not a CMapData XML YMAP file')
  const entitiesBlock = xml.match(/<entities\b[^>]*>([\s\S]*?)<\/entities>/i)?.[1] || ''
  const entities = []
  for (const match of entitiesBlock.matchAll(/<Item\b[^>]*type\s*=\s*["']CEntityDef["'][^>]*>([\s\S]*?)<\/Item>/gi)) {
    const block = match[1]
    const model = block.match(/<archetypeName\b[^>]*>([^<]+)<\/archetypeName>/i)?.[1]?.trim()
    const positionTag = block.match(/<position\b[^>]*\/?\s*>/i)?.[0]
    const rotationTag = block.match(/<rotation\b[^>]*\/?\s*>/i)?.[0]
    const scaleXYTag = block.match(/<scaleXY\b[^>]*\/?\s*>/i)?.[0]
    const scaleZTag = block.match(/<scaleZ\b[^>]*\/?\s*>/i)?.[0]
    if (!model || !positionTag || !rotationTag) continue
    const qx = xmlAttribute(rotationTag, 'x')
    const qy = xmlAttribute(rotationTag, 'y')
    const qz = xmlAttribute(rotationTag, 'z')
    const qw = xmlAttribute(rotationTag, 'w', 1)
    const scaleXY = scaleXYTag ? xmlAttribute(scaleXYTag, 'value', 1) : 1
    const scaleZ = scaleZTag ? xmlAttribute(scaleZTag, 'value', 1) : 1
    entities.push({
      name: model,
      model,
      modelHash: joaat(model),
      position: {
        x: xmlAttribute(positionTag, 'x'),
        y: xmlAttribute(positionTag, 'y'),
        z: xmlAttribute(positionTag, 'z'),
      },
      rotation: quaternionToEulerDegrees(qx, qy, qz, qw),
      quaternion: { x: qx, y: qy, z: qz, w: qw },
      scale: { x: scaleXY, y: scaleXY, z: scaleZ },
    })
  }
  return { version: 'xml', systemSize: data.length, entityCount: entities.length, entities }
}

function parseYmap(input, resolveModelName = () => null) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (data.length >= 4 && data.readUInt32LE(0) === RSC8_MAGIC) return parseRsc8Ymap(data, resolveModelName)
  return parseXmlYmap(data)
}

module.exports = { joaat, parseRsc8Ymap, parseXmlYmap, parseYmap }

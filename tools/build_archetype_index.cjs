/**
 * Read every .ytyp in the game and index its archetype definitions.
 *
 *   node tools/build_archetype_index.cjs --game=<dir> --cache=<dir> [--jobs=8]
 *
 * A ymap places entities by archetype *hash*; the .ytyp files are what map
 * those hashes to assets. Without them, roughly half of a dense area's props
 * are unplaceable hex strings (val_01_: 232 of 315). This walks the world
 * index for ytyp entries, pulls them, and writes `world-index/archetypes.ndjson`
 * with one record per archetype.
 *
 * ## The record layout is measured, not guessed
 *
 * RSC8 ytyp resources carry a descriptor (structHash, byteSize, pointer). The
 * archetype array's struct hash is 0x82d6fc83 in every file checked (24/24 in
 * the Valentine metadata archive), record stride 0xA0. Within a record:
 *
 *   +0x10 f32 lodDist          +0x50 f32 bsRadius
 *   +0x20 f32×3 bbMin          +0x58 u32 name hash
 *   +0x30 f32×3 bbMax          +0x5c u32 textureDictionary hash
 *   +0x40 f32×3 bsCentre       +0x64 u32 drawableDictionary hash
 *                              +0x6c u32 assetType
 *                              +0x70 u32 assetName hash
 *
 * Validation on 2,869 real records: name == assetName in 2,869/2,869, and
 * 2,093 textureDictionary hashes resolve to .ytd names in the world index.
 * A blob is only accepted as an archetype array if every record passes the
 * name==assetName check, so a wrong stride or offset rejects the whole blob
 * instead of emitting garbage.
 *
 * The textureDictionary field also replaces extract_model's name-prefix guess
 * for which .ytd a model needs — the game says so explicitly.
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawn } = require('node:child_process')

const { parseArgs, resolveToolchain } = require('../lib/toolchain.cjs')

const options = parseArgs()
const { game: gameDir, cache: cacheRoot, helper } = resolveToolchain(options, ['game', 'helper'])
const jobs = Math.max(1, Math.min(16, Number(options.jobs) || 8))

const indexRoot = path.join(cacheRoot, 'world-index')
const workDir = path.join(cacheRoot, 'ondemand', '_ytyp')
const outPath = path.join(indexRoot, 'archetypes.ndjson')

for (const required of [gameDir, helper, indexRoot]) {
  if (!fs.existsSync(required)) throw new Error(`Missing required path: ${required}`)
}

const ARCHETYPE_ARRAY_HASH = 0x82d6fc83
const STRIDE = 0xa0

const progress = (stage, current, total, message) => {
  const percent = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0
  process.stdout.write(`FRONTIER_PROGRESS ${JSON.stringify({ stage, current, total, percent, message })}\n`)
}

// ------------------------------------------------------------------- index

const archives = JSON.parse(fs.readFileSync(path.join(indexRoot, 'archives.json'), 'utf8'))
const byId = new Map(archives.map((archive) => [archive.id, archive]))

/** archive id (or `top:<levels>`) → ytyp entries inside it. */
const groups = new Map()
for (const line of fs.readFileSync(path.join(indexRoot, 'entries.ndjson'), 'utf8').split(/\r?\n/)) {
  if (!line) continue
  let record
  try { record = JSON.parse(line) } catch { continue }
  if (record.e !== 'ytyp') continue
  const key = record.a !== undefined && byId.has(record.a) ? record.a : `top:${record.l}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(record)
}
const totalYtyps = [...groups.values()].reduce((total, list) => total + list.length, 0)
progress('scan', 0, groups.size, `${totalYtyps} ytyp files in ${groups.size} archives`)

// -------------------------------------------------------------- extraction

fs.mkdirSync(workDir, { recursive: true })

/**
 * Async with a hard timeout. The first (synchronous) version of this build
 * hung forever at archive 390/801: one ArchiveExplorer instance sat 15
 * minutes at 0.5 s CPU and zero I/O, and spawnSync had no way out. A stuck
 * helper is now killed and its archive counted as failed instead of taking
 * the whole build down with it. spawnSync also serialised the "parallel"
 * workers — every call blocked the event loop — so this is what actually
 * makes --jobs real.
 */
const HELPER_TIMEOUT_MS = 120_000
const runHelper = (env) => new Promise((resolve) => {
  const child = spawn(helper, [], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, HELPER_TIMEOUT_MS)
  child.once('error', () => { clearTimeout(timer); resolve(false) })
  child.once('close', (code) => { clearTimeout(timer); resolve(code === 0) })
})

function loadSystem(file) {
  const raw = fs.readFileSync(file)
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x38435352) return null
  const expected = raw.readUInt32LE(8)
  if (!expected || expected > 256 * 1024 * 1024) return null
  const payload = raw.subarray(16)
  try {
    return payload.length === expected ? payload : zlib.inflateRawSync(payload, { maxOutputLength: expected })
  } catch {
    return null
  }
}

const virtualOffset = (pointer) => {
  const low = Number(pointer & 0xffffffffn) >>> 0
  return (low & 0xf0000000) === 0x50000000 ? low & 0x0fffffff : -1
}

/** Parses one ytyp system segment into archetype records; [] when none. */
function parseArchetypes(system) {
  const out = []
  for (let offset = 0; offset + 16 <= system.length; offset += 4) {
    if (system.readUInt32LE(offset) !== ARCHETYPE_ARRAY_HASH) continue
    const size = system.readUInt32LE(offset + 4)
    if (!size || size % STRIDE !== 0) continue
    const pointer = virtualOffset(system.readBigUInt64LE(offset + 8))
    if (pointer < 0 || pointer + size > system.length) continue
    const count = size / STRIDE
    // Accept the blob only if every record passes the name==assetName check.
    let valid = count > 0
    for (let index = 0; index < count; index += 1) {
      const base = pointer + index * STRIDE
      const nameHash = system.readUInt32LE(base + 0x58)
      const assetHash = system.readUInt32LE(base + 0x70)
      if (!nameHash || (assetHash !== 0 && assetHash !== nameHash)) { valid = false; break }
    }
    if (!valid) continue
    for (let index = 0; index < count; index += 1) {
      const base = pointer + index * STRIDE
      out.push({
        h: system.readUInt32LE(base + 0x58) >>> 0,
        tx: system.readUInt32LE(base + 0x5c) >>> 0,
        dd: system.readUInt32LE(base + 0x64) >>> 0,
        at: system.readUInt32LE(base + 0x6c) >>> 0,
        ld: Math.round(system.readFloatLE(base + 0x10)),
        r: Math.round(system.readFloatLE(base + 0x50) * 100) / 100,
      })
    }
  }
  return out
}

async function main() {
  /** hash → record; first definition wins, matching how ymap resolution works. */
  const archetypes = new Map()
  let filesRead = 0
  let filesFailed = 0
  let done = 0
  const failedArchives = []
  const keys = [...groups.keys()]

  const worker = async () => {
    while (keys.length) {
      const key = keys.shift()
      const entries = groups.get(key)
      done += 1

      let container = null
      let cleanup = null
      if (typeof key === 'string') {
        container = path.join(gameDir, key.slice(4))
      } else {
        const archive = byId.get(key)
        const nested = path.join(workDir, `${archive.id}_${path.basename(archive.entry)}`)
        await runHelper({
          SWAGE_VERIFY_RPF: path.join(gameDir, archive.levels),
          SWAGE_EXTRACT_ENTRY: archive.entry,
          SWAGE_EXTRACT_OUT: nested,
        })
        if (!fs.existsSync(nested)) {
          filesFailed += entries.length
          failedArchives.push(archive.entry)
          continue
        }
        container = nested
        cleanup = nested
      }

      for (const entry of entries) {
        const target = path.join(workDir, `${done}_${path.basename(entry.p)}`)
        await runHelper({ SWAGE_VERIFY_RPF: container, SWAGE_EXTRACT_ENTRY: entry.p, SWAGE_EXTRACT_OUT: target })
        if (!fs.existsSync(target)) { filesFailed += 1; continue }
        const system = loadSystem(target)
        fs.rmSync(target, { force: true })
        if (!system) { filesFailed += 1; continue }
        filesRead += 1
        for (const record of parseArchetypes(system)) {
          if (!archetypes.has(record.h)) archetypes.set(record.h, record)
        }
      }
      if (cleanup) fs.rmSync(cleanup, { force: true })
      if (done % 10 === 0 || done === groups.size) {
        progress('parse', done, groups.size, `${archetypes.size.toLocaleString()} archetypes from ${filesRead} ytyps`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, groups.size) }, worker))

  const lines = []
  for (const record of archetypes.values()) lines.push(JSON.stringify(record))
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`)
  fs.rmSync(workDir, { recursive: true, force: true })

  process.stdout.write(`FRONTIER_ARCHETYPES ${JSON.stringify({
    path: outPath,
    archetypes: archetypes.size,
    ytypsRead: filesRead,
    ytypsFailed: filesFailed,
    bytes: fs.statSync(outPath).size,
  })}\n`)
}

void main()

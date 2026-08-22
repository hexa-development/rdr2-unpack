/**
 * Load one of the game's own map areas, with its real models.
 *
 *   node tools/extract_area.cjs --game=<dir> --cache=<dir> --ymap=val_01__strm_0
 *   node tools/extract_area.cjs ... --area=val_01_ [--models --jobs=4]
 *
 * The world view is collision geometry, which carries no textures — the visual
 * world lives in `.ydr` drawables placed by `.ymap` files. `--ymap` pulls one
 * ymap; `--area` pulls a whole package from `areas.json` (built by
 * build_area_index.cjs): every ymap that belongs to that place, so Valentine
 * arrives as all seven of its ymaps, not one.
 *
 * Placements are emitted first and models afterwards, so a caller can show the
 * area immediately and let it become textured as conversion progresses.
 *
 * Model conversion is a few seconds each, so a dense area is minutes of work —
 * done once, then served from `<cache>/ondemand/glb`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { parseYmap, joaat } = require('../lib/ymap-rsc8.cjs')
const { parseArgs, resolveToolchain } = require('../lib/toolchain.cjs')

const options = parseArgs()
const { game: gameDir, cache: cacheRoot, helper } = resolveToolchain(options, ['game', 'helper'])
const areaName = String(options.area || '').trim().toLowerCase()
const singleYmap = String(options.ymap || '').trim().toLowerCase()
const jobs = Math.max(1, Math.min(8, Number(options.jobs) || 4))

if (!areaName && !singleYmap) throw new Error('Pass --area=<package> or --ymap=<name>')

const indexRoot = path.join(cacheRoot, 'world-index')
const label = areaName || singleYmap
const workDir = path.join(cacheRoot, 'ondemand', '_area', label.replace(/[^a-z0-9_-]+/g, '_'))
const glbDir = path.join(cacheRoot, 'ondemand', 'glb')

for (const required of [indexRoot]) {
  if (!fs.existsSync(required)) throw new Error(`Missing required path: ${required}`)
}

const progress = (stage, current, total, message) => {
  const percent = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0
  process.stdout.write(`FRONTIER_PROGRESS ${JSON.stringify({ stage, current, total, percent, message })}\n`)
}

const fail = (error, code) => {
  process.stdout.write(`FRONTIER_AREA ${JSON.stringify({ error })}\n`)
  process.exit(code)
}

// -------------------------------------------------------------- which ymaps

/** The package record when loading an area; null in single-ymap mode. */
let area = null
let wantedYmaps
if (areaName) {
  const areasPath = path.join(indexRoot, 'areas.json')
  if (!fs.existsSync(areasPath)) fail('No areas.json — run build_area_index.cjs first', 2)
  const areaIndex = JSON.parse(fs.readFileSync(areasPath, 'utf8'))
  area = (areaIndex.areas || []).find((entry) => entry.name === areaName) || null
  if (!area) fail(`area "${areaName}" is not in the area index`, 2)
  if (!area.ymaps.length) fail(`area "${areaName}" has no ymaps to load`, 2)
  wantedYmaps = new Set(area.ymaps.map((name) => String(name).toLowerCase()))
} else {
  wantedYmaps = new Set([singleYmap])
}

// ------------------------------------------------------------------- index

const archives = JSON.parse(fs.readFileSync(path.join(indexRoot, 'archives.json'), 'utf8'))
const entriesRaw = fs.readFileSync(path.join(indexRoot, 'entries.ndjson'), 'utf8')

/** ymap name → index record. */
const ymapEntries = new Map()
/** drawable name → index record, for resolving which archive holds each model. */
const drawables = new Map()
for (const line of entriesRaw.split(/\r?\n/)) {
  if (!line) continue
  let record
  try { record = JSON.parse(line) } catch { continue }
  if (record.e === 'ydr') {
    const key = String(record.n).toLowerCase()
    if (!drawables.has(key)) drawables.set(key, record)
  } else if (record.e === 'ymap') {
    const key = String(record.n).toLowerCase()
    if (wantedYmaps.has(key) && !ymapEntries.has(key)) ymapEntries.set(key, record)
  }
}

const missing = [...wantedYmaps].filter((name) => !ymapEntries.has(name))
if (ymapEntries.size === 0) fail(`no ymap of "${label}" is in the world index`, 2)

// Model names resolve from hashes using the index itself, so placements that
// store only a hash still name a real drawable.
const byHash = new Map()
for (const [name] of drawables) byHash.set(joaat(name) >>> 0, name)

// -------------------------------------------------------------- extraction

fs.mkdirSync(workDir, { recursive: true })
fs.mkdirSync(glbDir, { recursive: true })

const runHelper = (env) => spawnSync(helper, [], {
  env: { ...process.env, ...env },
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
})

/**
 * Nested archives are extracted once and reused: an area's ymaps overwhelmingly
 * share one `*_metadata.rpf`, so per-ymap extraction would redo the same pull.
 */
const nestedCache = new Map()
function nestedArchivePath(archive) {
  if (nestedCache.has(archive.id)) return nestedCache.get(archive.id)
  const nested = path.join(workDir, `${archive.id}_${path.basename(archive.entry)}`)
  runHelper({
    SWAGE_VERIFY_RPF: path.join(gameDir, archive.levels),
    SWAGE_EXTRACT_ENTRY: archive.entry,
    SWAGE_EXTRACT_OUT: nested,
  })
  const result = fs.existsSync(nested) ? nested : null
  nestedCache.set(archive.id, result)
  return result
}

function extractYmap(name, entry) {
  const target = path.join(workDir, `${name}.ymap`)
  const archive = archives.find((candidate) => candidate.id === entry.a)
  if (archive) {
    const nested = nestedArchivePath(archive)
    if (!nested) return null
    runHelper({ SWAGE_VERIFY_RPF: nested, SWAGE_EXTRACT_ENTRY: entry.p, SWAGE_EXTRACT_OUT: target })
  } else {
    // Top-level entry: it lives directly in the levels archive.
    runHelper({
      SWAGE_VERIFY_RPF: path.join(gameDir, entry.l),
      SWAGE_EXTRACT_ENTRY: entry.p,
      SWAGE_EXTRACT_OUT: target,
    })
  }
  return fs.existsSync(target) ? target : null
}

const allEntities = []
const perYmap = []
const failures = missing.map((name) => ({ ymap: name, error: 'not in the world index' }))
let step = 0
for (const [name, entry] of ymapEntries) {
  step += 1
  progress('extract', step, ymapEntries.size, `Extracting ${name}.ymap`)
  const file = extractYmap(name, entry)
  if (!file) {
    failures.push({ ymap: name, error: `could not extract ${entry.p}` })
    continue
  }
  try {
    const parsed = parseYmap(fs.readFileSync(file), (hash) => byHash.get(hash >>> 0) || null)
    const entities = (parsed.entities || []).map((entity) => ({ ...entity, sourceYmap: name }))
    allEntities.push(...entities)
    perYmap.push({ ymap: name, entities: entities.length })
  } catch (error) {
    failures.push({ ymap: name, error: error.message })
  }
}

if (!allEntities.length && failures.length) fail(`could not read any ymap of "${label}": ${failures[0].error}`, 4)

const models = [...new Set(allEntities.map((entity) => String(entity.model).toLowerCase()))]
const known = models.filter((name) => drawables.has(name))
const unknown = models.filter((name) => !drawables.has(name))

/**
 * Classify what the unresolved hashes actually are, using the archetype index
 * (build_archetype_index.cjs). A hash with an archetype record naming a
 * drawable dictionary is a model inside a .ydd — real and locatable, just not
 * convertible until dictionary extraction exists. A hash with no record at all
 * is genuinely unknown.
 */
let unresolvedDetail = null
const archetypesPath = path.join(indexRoot, 'archetypes.ndjson')
if (unknown.length && fs.existsSync(archetypesPath)) {
  const wantedHashes = new Map()
  for (const value of unknown) {
    const hash = /^0x[0-9a-f]+$/i.test(value) ? parseInt(value, 16) >>> 0 : joaat(value) >>> 0
    wantedHashes.set(hash, value)
  }
  const records = new Map()
  for (const line of fs.readFileSync(archetypesPath, 'utf8').split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (wantedHashes.has(record.h >>> 0)) records.set(record.h >>> 0, record)
  }
  let inDictionary = 0
  let recordOnly = 0
  for (const hash of wantedHashes.keys()) {
    const record = records.get(hash)
    if (!record) continue
    if (record.dd) inDictionary += 1
    else recordOnly += 1
  }
  unresolvedDetail = {
    total: unknown.length,
    withArchetype: records.size,
    inDrawableDictionary: inDictionary,
    standalone: recordOnly,
    noArchetype: unknown.length - records.size,
  }
}

// Placements go out first so the caller can show the area immediately.
process.stdout.write(`FRONTIER_AREA ${JSON.stringify({
  area: areaName || null,
  ymaps: perYmap,
  failures,
  bounds: area?.bounds || null,
  center: area?.center || null,
  entityCount: allEntities.length,
  models: models.length,
  convertible: known.length,
  unresolved: unknown.length,
  unresolvedDetail,
  entities: allEntities,
})}\n`)

if (!options.models) {
  fs.rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}

// ------------------------------------------------------- model conversion

const extractor = path.join(__dirname, 'extract_model.cjs')
const pending = known.filter((name) => !fs.existsSync(path.join(glbDir, `${name}.glb`)))
let done = 0
let converted = 0
let failed = 0

const runExtractor = (model) => new Promise((resolve) => {
  const child = spawn(process.execPath, [
    extractor,
    `--game=${gameDir}`,
    `--cache=${cacheRoot}`,
    `--model=${model}`,
  ], { cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let buffer = ''
  let ok = false
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('FRONTIER_MODEL ')) continue
      try { ok = Boolean(JSON.parse(line.slice(15)).glb) } catch { /* ignore */ }
    }
  })
  child.once('error', () => resolve(false))
  child.once('close', () => resolve(ok))
})

async function pool(items, limit, task) {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await task(items[cursor++])
  }))
}

void (async () => {
  progress('convert', 0, pending.length, `Converting ${pending.length} models for ${label}`)
  await pool(pending, jobs, async (model) => {
    const ok = await runExtractor(model)
    done += 1
    if (ok) converted += 1
    else failed += 1
    if (done % 5 === 0 || done === pending.length) {
      progress('convert', done, pending.length, `${converted} converted · ${failed} unsupported`)
    }
  })
  fs.rmSync(workDir, { recursive: true, force: true })
  progress('complete', 1, 1, `${converted} models ready`)
  process.stdout.write(`FRONTIER_AREA_MODELS ${JSON.stringify({
    area: areaName || null,
    requested: pending.length,
    converted,
    failed,
    alreadyCached: known.length - pending.length,
    unresolved: unknown.length,
  })}\n`)
})()

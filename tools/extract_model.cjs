/**
 * Extract one model straight out of the game archives, on demand.
 *
 *   node tools/extract_model.cjs --game=<dir> --cache=<dir> --model=big_glue_tree_002
 *
 * This is what lets the editor drop the multi-gigabyte pre-built cache: instead
 * of converting the whole game up front, the world index says which archive
 * holds a model, and only that model is pulled and converted when something
 * actually needs it. The converted GLB is kept in `<cache>/ondemand/` so the
 * second request is a file read.
 *
 * Conversion cost is a few seconds per model (ArchiveExplorer → Cfx
 * formats:convert → ydr_to_glb), which is why the result is cached; it is far
 * too slow to redo per frame, but perfectly fine per newly used model.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { parseArgs, resolveToolchain } = require('../lib/toolchain.cjs')

const options = parseArgs()
const { game: gameDir, cache: cacheRoot, helper, cfx, python } =
  resolveToolchain(options, ['game', 'helper', 'cfx', 'python'])
const model = String(options.model || '').trim()

if (!model) throw new Error('Pass --model=<name>')

const indexRoot = path.join(cacheRoot, 'world-index')
const outRoot = path.join(cacheRoot, 'ondemand')
const glbDir = path.join(outRoot, 'glb')
const workDir = path.join(outRoot, '_work', model.toLowerCase().replace(/[^a-z0-9_-]+/g, '_'))

const emit = (payload) => process.stdout.write(`FRONTIER_MODEL ${JSON.stringify(payload)}\n`)

// Stage timings, so the first-request cost is attributed rather than guessed.
const timings = {}
let stageMark = Date.now()
const stage = (name) => {
  const now = Date.now()
  timings[name] = (timings[name] || 0) + (now - stageMark)
  stageMark = now
}

const existing = path.join(glbDir, `${model}.glb`)
if (fs.existsSync(existing) && !options.force) {
  emit({ model, glb: existing, cached: true })
  process.exit(0)
}

for (const required of [gameDir, helper, cfx, python, indexRoot]) {
  if (!fs.existsSync(required)) throw new Error(`Missing required path: ${required}`)
}

// ------------------------------------------------------------------ index

const archives = JSON.parse(fs.readFileSync(path.join(indexRoot, 'archives.json'), 'utf8'))
const wanted = model.toLowerCase()

const { joaat } = require('../lib/ymap-rsc8.cjs')

/**
 * The archetype index (build_archetype_index.cjs) names the exact texture
 * dictionary each model uses — the .ytyp says so. When present, that beats
 * any name-prefix guess over the sibling dictionaries.
 */
function archetypeTextureDictionary() {
  const archetypesPath = path.join(indexRoot, 'archetypes.ndjson')
  if (!fs.existsSync(archetypesPath)) return null
  const hash = joaat(wanted) >>> 0
  for (const line of fs.readFileSync(archetypesPath, 'utf8').split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.h === hash) return record.tx >>> 0 || null
  }
  return null
}

/** Streams the NDJSON index rather than parsing it whole. */
function findEntries() {
  const raw = fs.readFileSync(path.join(indexRoot, 'entries.ndjson'), 'utf8')
  const wantedTexHash = archetypeTextureDictionary()
  let drawable = null
  let archetypeYtd = null
  const siblings = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.e === 'ydr' && record.n.toLowerCase() === wanted) drawable = record
    else if (record.e === 'ytd' && wantedTexHash && !archetypeYtd
      && (joaat(String(record.n).toLowerCase()) >>> 0) === wantedTexHash) archetypeYtd = record
  }
  if (!drawable) return { drawable: null, siblings, archetypeYtd }
  // Texture dictionaries that belong to the same archive as the model.
  for (const line of raw.split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.a !== drawable.a || record.e !== 'ytd') continue
    siblings.push(record)
  }
  return { drawable, siblings, archetypeYtd }
}

const { drawable, siblings, archetypeYtd } = findEntries()
stage('index')
if (!drawable) {
  emit({ model, error: 'not found in the world index' })
  process.exit(2)
}
const archive = archives.find((entry) => entry.id === drawable.a)
if (!archive) {
  emit({ model, error: 'archive missing from the index' })
  process.exit(2)
}

// ------------------------------------------------------------- extraction

fs.mkdirSync(workDir, { recursive: true })
fs.mkdirSync(glbDir, { recursive: true })
const rsc7Dir = path.join(workDir, 'rsc7')
const texDir = path.join(workDir, 'tex')
fs.mkdirSync(rsc7Dir, { recursive: true })
fs.mkdirSync(texDir, { recursive: true })

const run = (file, args, cwd, env) => spawnSync(file, args, {
  cwd: cwd || workDir,
  env: { ...process.env, ...(env || {}) },
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
})

const levelsPath = path.join(gameDir, archive.levels)
const nestedPath = path.join(workDir, path.basename(archive.entry))
run(helper, [], workDir, {
  SWAGE_VERIFY_RPF: levelsPath,
  SWAGE_EXTRACT_ENTRY: archive.entry,
  SWAGE_EXTRACT_OUT: nestedPath,
})
stage('extractArchive')
if (!fs.existsSync(nestedPath)) {
  emit({ model, error: `could not extract ${archive.entry}` })
  process.exit(3)
}

const pull = (entryName, target) => {
  run(helper, [], workDir, {
    SWAGE_VERIFY_RPF: nestedPath,
    SWAGE_EXTRACT_ENTRY: entryName,
    SWAGE_EXTRACT_OUT: target,
  })
  return fs.existsSync(target)
}

const drawablePath = path.join(workDir, `${model}.ydr`)
if (!pull(drawable.p, drawablePath)) {
  emit({ model, error: `could not extract ${drawable.p}` })
  process.exit(3)
}

/**
 * Pick the texture dictionary this model needs, not every one in the archive.
 *
 * The authoritative answer is the archetype's textureDictionary field from the
 * .ytyp (build_archetype_index.cjs) — the game names the dictionary
 * explicitly, even when it lives in a different archive than the model. The
 * name heuristics below are the fallback for models with no archetype record:
 * measured on `big_glue_tree_002`, pulling all four sibling dictionaries was
 * 11.8 s of a 15.6 s request (76%), so only the likeliest one or two are taken.
 */
// A model's own dictionary (`<model>.ytd` / `<model>+hidr.ytd` — the game's
// naming convention, not a guess) resolves first, exactly like the game does.
const ownDictionary = siblings.filter((entry) => entry.n.toLowerCase().startsWith(wanted))
for (const entry of ownDictionary.slice(0, 2)) {
  pull(entry.p, path.join(rsc7Dir, `${entry.n}.wtd`))
}

// Then the archetype's dictionary supplements it. Measured on
// big_glue_tree_002: the archetype names the shared `big_01_` dictionary
// (wood), while the leaves live in the model's own dictionary — either alone
// is incomplete, together the resolution order matches the game.
let pulledArchetypeYtd = false
if (archetypeYtd && !ownDictionary.some((entry) => entry.n === archetypeYtd.n)) {
  const target = path.join(rsc7Dir, `${archetypeYtd.n}.wtd`)
  if (archetypeYtd.a === drawable.a) {
    pulledArchetypeYtd = pull(archetypeYtd.p, target)
  } else {
    // The dictionary lives in another archive; pull that archive once.
    const texArchive = archives.find((entry) => entry.id === archetypeYtd.a)
    if (texArchive) {
      const texNested = path.join(workDir, `tex_${path.basename(texArchive.entry)}`)
      run(helper, [], workDir, {
        SWAGE_VERIFY_RPF: path.join(gameDir, texArchive.levels),
        SWAGE_EXTRACT_ENTRY: texArchive.entry,
        SWAGE_EXTRACT_OUT: texNested,
      })
      if (fs.existsSync(texNested)) {
        run(helper, [], workDir, {
          SWAGE_VERIFY_RPF: texNested,
          SWAGE_EXTRACT_ENTRY: archetypeYtd.p,
          SWAGE_EXTRACT_OUT: target,
        })
        pulledArchetypeYtd = fs.existsSync(target)
        fs.rmSync(texNested, { force: true })
      }
    }
  }
}
if (!ownDictionary.length && !pulledArchetypeYtd) {
  // No own dictionary and no archetype record: one shared dictionary from the
  // model's archive is the last resort (shortest name over incidental
  // per-model dictionaries belonging to other models).
  const shared = siblings
    .filter((entry) => !entry.n.toLowerCase().startsWith(wanted))
    .sort((left, right) => left.n.length - right.n.length)
  for (const entry of shared.slice(0, 1)) {
    pull(entry.p, path.join(rsc7Dir, `${entry.n}.wtd`))
  }
}
stage('pullEntries')

// --------------------------------------------------------------- convert

const isEncrypted = (result) => `${result.stdout || ''}${result.stderr || ''}`.includes('encrypted files are not supported')
const clearEncryptionFlag = (file) => {
  const bytes = fs.readFileSync(file)
  if (bytes.length < 8 || (bytes[6] === 0x00 && bytes[7] === 0x01)) return false
  bytes[6] = 0x00
  bytes[7] = 0x01
  fs.writeFileSync(file, bytes)
  return true
}
const convert = (file) => {
  let result = run(cfx, ['formats:convert', path.basename(file), '--game', 'rdr3'], path.dirname(file))
  if (isEncrypted(result) && clearEncryptionFlag(file)) {
    result = run(cfx, ['formats:convert', path.basename(file), '--game', 'rdr3'], path.dirname(file))
  }
  return result
}

let textureCount = 0
for (const name of fs.readdirSync(rsc7Dir).filter((value) => value.toLowerCase().endsWith('.wtd'))) {
  convert(path.join(rsc7Dir, name))
}
if (fs.readdirSync(rsc7Dir).some((name) => name.toLowerCase().endsWith('.ytd'))) {
  const exported = run(python, [path.join(__dirname, 'ytd_to_png.py'), rsc7Dir, texDir])
  textureCount = Number(/textures=(\d+)/.exec(exported.stdout || '')?.[1] || 0)
}

stage('convertTextures')
const drawableResult = convert(drawablePath)
const converted = path.join(workDir, `${model}_nya.ydr`)
stage('convertDrawable')
if (!fs.existsSync(converted)) {
  // Report what the converter actually said — some drawables use shaders it
  // cannot handle, and a generic failure hides that.
  const reason = `${drawableResult.stdout || ''}${drawableResult.stderr || ''}`
    .trim().split('\n').filter(Boolean).pop() || 'unknown reason'
  emit({ model, error: `drawable conversion failed: ${reason}` })
  process.exit(4)
}

const args = [path.join(__dirname, 'build_ydr_folder.py'), workDir, glbDir]
if (textureCount > 0) args.push('--textures', texDir)
const built = run(python, args)
const glbPath = path.join(glbDir, `${model}.glb`)
if (built.status !== 0 || !fs.existsSync(glbPath)) {
  emit({ model, error: `GLB build failed: ${(built.stderr || '').trim().split('\n').pop() || 'unknown'}` })
  process.exit(5)
}

stage('buildGlb')
fs.rmSync(workDir, { recursive: true, force: true })
emit({
  model,
  glb: glbPath,
  cached: false,
  textures: textureCount,
  archive: archive.entry,
  bytes: fs.statSync(glbPath).size,
  timings,
})

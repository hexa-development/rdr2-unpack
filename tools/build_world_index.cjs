/**
 * Build the RDR2 world index — the model database the editor needs to reach
 * *any* asset in the game rather than a hand-picked subset (brief §14, §15).
 *
 *   node tools/build_world_index.cjs --game=<dir> --cache=<dir> --levels=1,2
 *   node tools/build_world_index.cjs --game=<dir> --cache=<dir> --all
 *   node tools/build_world_index.cjs ... --jobs=8 --force
 *
 * Every `levels_*.rpf` contains nested area archives; each of those holds the
 * `.ydr` models, `.ytd` texture dictionaries, `.ybn` collision and `.ymap`
 * placements for one area. This walks that tree once and records where every
 * entry lives, so a model can later be extracted on demand by name or by hash.
 *
 * Each archive costs two ArchiveExplorer invocations (extract + list), which is
 * almost entirely process startup and I/O wait — so the work is dispatched
 * across a pool of concurrent jobs rather than one at a time. Archive ids are
 * assigned before dispatch, so results may land in any order without affecting
 * the index.
 *
 *   incremental — a levels file whose size/mtime is unchanged is skipped
 *   resumable   — entries are appended as NDJSON, so stopping loses nothing
 *
 * Output (under `<cache>/world-index/`):
 *   entries.ndjson   one line per file: {n:name, e:ext, a:archiveId, p:path}
 *   archives.json    archiveId → {levels, entry}
 *   index.json       run manifest: which levels files are done, counts
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { parseArgs, resolveToolchain } = require('../lib/toolchain.cjs')

const options = parseArgs()
const { game: gameDir, cache: cacheRoot, helper } = resolveToolchain(options, ['game', 'helper'])
const outRoot = path.join(cacheRoot, 'world-index')
const workDir = path.join(outRoot, '_work')

/**
 * Two ArchiveExplorer spawns per archive, both dominated by process startup and
 * I/O wait rather than CPU — so oversubscribing cores pays. Measured on a
 * 12-core machine over levels_1 (341 archives): 1 job ≈ 1,228 s, 8 jobs 229 s,
 * 14 jobs 160 s. Past that the disk, not the CPU, is the limit.
 */
const jobs = Math.max(1, Math.min(16, Number(options.jobs) || os.cpus().length + 2))

fs.mkdirSync(workDir, { recursive: true })

/**
 * `--all` covers every archive, not just `levels_*`. The world's terrain and
 * placements live in the levels files, but the props those placements reference
 * are in `packs_*`, `hd_0` and friends — indexing only levels resolved area
 * ymaps to names that had no drawable anywhere in the index.
 */
const levelFiles = fs.readdirSync(gameDir)
  .filter((name) => name.toLowerCase().endsWith('.rpf'))
  .sort((left, right) => {
    // Levels first: they are the biggest win if a run is interrupted.
    const rank = (name) => (/^levels_\d+\.rpf$/i.test(name) ? 0 : 1)
    return rank(left) - rank(right) || left.localeCompare(right)
  })

const requested = options.all
  ? levelFiles
  : String(options.levels || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (/^\d+$/.test(value) ? `levels_${value}.rpf` : value))

if (!requested.length) throw new Error('Pass --levels=<n,n> or --all')
const targets = requested.filter((name) => levelFiles.includes(name))

const manifestPath = path.join(outRoot, 'index.json')
const archivesPath = path.join(outRoot, 'archives.json')
const entriesPath = path.join(outRoot, 'entries.ndjson')

const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { format: 'frontier-rdr2-world-index', version: 1, levels: {}, archiveCount: 0, entryCount: 0 }
const archives = fs.existsSync(archivesPath)
  ? JSON.parse(fs.readFileSync(archivesPath, 'utf8'))
  : []

const progress = (stage, current, total, message) => {
  const percent = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0
  process.stdout.write(`FRONTIER_PROGRESS ${JSON.stringify({ stage, current, total, percent, message })}\n`)
}
const warn = (payload) => process.stdout.write(`FRONTIER_WARN ${JSON.stringify(payload)}\n`)

/** ArchiveExplorer is driven entirely through environment variables. */
function runHelper(env) {
  return new Promise((resolve) => {
    const child = spawn(helper, [], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', () => resolve({ stdout, stderr }))
    child.once('close', () => resolve({ stdout, stderr }))
  })
}

/**
 * ArchiveExplorer logs its listing to **stderr**, and a plain verify does not
 * exit 0, so the listing is read from stderr and the exit code is ignored — an
 * empty listing is the real failure signal.
 */
async function listArchive(archivePath) {
  const { stdout, stderr } = await runHelper({ SWAGE_VERIFY_RPF: archivePath })
  const entries = []
  for (const line of `${stderr}\n${stdout}`.split(/\r?\n/)) {
    const match = /RPF8 file:\s*(.+?)\s*$/.exec(line)
    if (match) entries.push(match[1])
  }
  return entries.length ? entries : null
}

async function extractEntry(archivePath, entry, output) {
  await runHelper({
    SWAGE_VERIFY_RPF: archivePath,
    SWAGE_EXTRACT_ENTRY: entry,
    SWAGE_EXTRACT_OUT: output,
  })
  return fs.existsSync(output)
}

/** Runs `task` over `items` with at most `limit` in flight. */
async function pool(items, limit, task) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await task(items[index], index)
    }
  })
  await Promise.all(workers)
}

/**
 * Drops everything previously recorded for one levels file.
 *
 * `entries.ndjson` is append-only so a stopped run loses nothing, which means a
 * re-index has to remove the stale records first — otherwise re-running with
 * `--force` doubles the index instead of refreshing it.
 */
function purgeLevel(levelsName) {
  const staleIds = new Set(archives.filter((entry) => entry.levels === levelsName).map((entry) => entry.id))
  if (!staleIds.size && !fs.existsSync(entriesPath)) return

  if (fs.existsSync(entriesPath)) {
    const temporary = `${entriesPath}.tmp`
    const out = fs.openSync(temporary, 'w')
    try {
      const raw = fs.readFileSync(entriesPath, 'utf8')
      let kept = ''
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (record.l === levelsName) continue
        if (staleIds.has(record.a)) continue
        kept += `${line}\n`
        if (kept.length > 1_000_000) { fs.writeSync(out, kept); kept = '' }
      }
      if (kept) fs.writeSync(out, kept)
    } finally {
      fs.closeSync(out)
    }
    fs.rmSync(entriesPath, { force: true })
    fs.renameSync(`${entriesPath}.tmp`, entriesPath)
  }

  for (let index = archives.length - 1; index >= 0; index -= 1) {
    if (staleIds.has(archives[index].id)) archives.splice(index, 1)
  }
  // Counts are recomputed from what survived.
  manifest.entryCount = fs.existsSync(entriesPath)
    ? fs.readFileSync(entriesPath, 'utf8').split('\n').filter(Boolean).length
    : 0
}

/** Ids must stay stable for surviving archives, so never reuse array length. */
const nextArchiveId = () => archives.reduce((highest, entry) => Math.max(highest, entry.id), -1) + 1

/**
 * Records are buffered per levels file and appended once that file finishes.
 * Streaming them live would conflict with `purgeLevel`, which rewrites the same
 * file; a level now costs minutes rather than hours, so the unit of resume is
 * the levels file.
 */
let pending = []
const writeEntry = (record) => { pending.push(JSON.stringify(record)) }
const flushEntries = () => {
  if (!pending.length) return
  fs.appendFileSync(entriesPath, `${pending.join('\n')}\n`, 'utf8')
  pending = []
}

async function run() {
  const startedAt = Date.now()
  let indexedArchives = 0

  for (const levelsName of targets) {
    const levelsPath = path.join(gameDir, levelsName)
    const stat = fs.statSync(levelsPath)
    const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`
    if (!options.force && manifest.levels[levelsName]?.fingerprint === fingerprint) {
      progress('skip', 0, 1, `${levelsName} unchanged — skipping`)
      continue
    }

    const top = await listArchive(levelsPath)
    if (!top) {
      warn({ levels: levelsName, message: 'could not list archive' })
      continue
    }

    // Re-indexing replaces this levels file's records rather than adding to them.
    purgeLevel(levelsName)

    let levelEntries = 0
    // Non-archive entries at the top level are indexed directly.
    for (const entry of top) {
      if (entry.toLowerCase().endsWith('.rpf')) continue
      writeEntry({ n: path.basename(entry, path.extname(entry)), e: path.extname(entry).slice(1).toLowerCase(), a: -1, p: entry, l: levelsName })
      levelEntries += 1
    }

    // Ids are assigned up front so parallel results can land in any order.
    const baseId = nextArchiveId()
    const nested = top.filter((entry) => entry.toLowerCase().endsWith('.rpf'))
      .map((entry, offset) => ({ entry, id: baseId + offset }))
    for (const item of nested) {
      archives.push({ id: item.id, levels: levelsName, entry: item.entry, entryCount: 0 })
    }

    let done = 0
    await pool(nested, jobs, async (item, index) => {
      // Unique per task: archive basenames repeat across areas.
      const temporary = path.join(workDir, `${item.id}_${index}_${path.basename(item.entry)}`)
      try {
        if (!await extractEntry(levelsPath, item.entry, temporary)) {
          warn({ archive: item.entry, message: 'extract failed' })
          return
        }
        const entries = await listArchive(temporary)
        if (!entries) {
          warn({ archive: item.entry, message: 'list failed' })
          return
        }
        const record = archives.find((value) => value.id === item.id)
        if (record) record.entryCount = entries.length
        indexedArchives += 1
        for (const entry of entries) {
          const extension = path.extname(entry).slice(1).toLowerCase()
          if (!extension) continue
          writeEntry({ n: path.basename(entry, path.extname(entry)), e: extension, a: item.id, p: entry })
          levelEntries += 1
        }
      } finally {
        fs.rmSync(temporary, { force: true })
        done += 1
        if (done % 5 === 0 || done === nested.length) {
          progress('index', done, nested.length, `${levelsName} · ${done}/${nested.length} archives · ${jobs} jobs`)
        }
      }
    })

    flushEntries()
    manifest.levels[levelsName] = { fingerprint, archives: nested.length, indexedAt: new Date().toISOString() }
    fs.writeFileSync(archivesPath, JSON.stringify(archives), 'utf8')
    manifest.archiveCount = archives.length
    manifest.entryCount = (manifest.entryCount || 0) + levelEntries
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  }

  flushEntries()
  fs.rmSync(workDir, { recursive: true, force: true })

  const seconds = (Date.now() - startedAt) / 1000
  progress('complete', 1, 1, `Indexed ${indexedArchives} archives in ${seconds.toFixed(1)}s`)
  process.stdout.write(`FRONTIER_INDEX ${JSON.stringify({
    manifestPath,
    archiveCount: archives.length,
    entryCount: manifest.entryCount,
    seconds: Number(seconds.toFixed(1)),
    jobs,
  })}\n`)
}

void run()

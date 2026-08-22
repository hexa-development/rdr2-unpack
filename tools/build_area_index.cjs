/**
 * Group the world index into loadable area packages.
 *
 *   node tools/build_area_index.cjs --cache=<dir>
 *
 * The game already ships its world split into packages: every `.rpf` under
 * `levels/rdr3/area/<cellblock>/` is one place — `val_01_.rpf` is Valentine,
 * `big_01_.rpf` a homestead, `shack_b_a.rpf` a shack. This turns the flat world
 * index into that list, so the editor can offer "load this place" instead of
 * asking the user to know which ymap file they want.
 *
 * It reads the index only — no archive extraction — so it finishes in a second.
 *
 * ## Placements and models live in different archives
 *
 * Measured, not assumed: `levels/rdr3/area/jklm_07_10/val_01_.rpf` holds
 * Valentine's drawables, but every `val_01_*.ymap` — the placements — is in
 * `levels/rdr3/area/lod/jklm_7_10_area_lod_combine_metadata.rpf` (note the
 * unpadded block name). So a package is named by its model archive and its
 * ymaps are matched by name, longest prefix winning.
 *
 * ## Where a package is in the world
 *
 * The cell block in the path (`jklm_07_10`) names the terrain cells it covers:
 * rows `j`–`m`, columns `07`–`10`. Cell origins were derived from the 421 real
 * terrain cells in `world3d-manifest.json` and checked against every one of
 * them (416 exact, 5 within 3 m — collision meshes bleeding past a cell edge):
 *
 *   x = (col >= 90 ? col - 107 : col - 10) * 512
 *   y = 3584 - rowIndex(letter) * 512
 *
 * Rows run `f`…`y` then `a`…`d`; `e` is not used by any cell in the game.
 * Verified end to end on Valentine: `val_01_` sits in `jklm_07_10`, which the
 * formula places at x [-1536, 512] y [0, 2048], and the real placements in
 * `val_01__strm_2.ymap` are at x [-283, -159] y [586, 683].
 */

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const { parseArgs, resolveToolchain } = require('../lib/toolchain.cjs')

const options = parseArgs()
const { cache: cacheRoot } = resolveToolchain(options)
const indexRoot = path.join(cacheRoot, 'world-index')
const outPath = path.join(indexRoot, 'areas.json')

const CELL_SIZE = 512
const AREA_ARCHIVE = /^levels\/rdr3\/area\/([a-z]+_\d+_\d+)\/([^/]+)\.rpf$/i

/** Row letters run f…y then a…d; `e` is unused by any cell in the game. */
function rowIndex(letter) {
  const value = letter.charCodeAt(0) - 97
  if (value < 0 || value > 25 || value === 4) return null
  return value >= 5 ? value - 5 : value + 20
}

function cellOrigin(letter, column) {
  const row = rowIndex(letter)
  if (row === null) return null
  return { x: (column >= 90 ? column - 107 : column - 10) * CELL_SIZE, y: 3584 - row * CELL_SIZE }
}

/** `jklm_07_10` → the world box covering rows j–m, columns 07–10. */
function blockBounds(block) {
  const match = /^([a-z]+)_(\d+)_(\d+)$/.exec(block)
  if (!match) return null
  const first = Number(match[2])
  const last = Number(match[3])
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null

  const columns = []
  // Columns wrap through 9x for the western half of the map, so walk the run
  // rather than assuming last >= first.
  if (last >= first) {
    for (let column = first; column <= last; column += 1) columns.push(column)
  } else {
    for (let column = first; column <= 99; column += 1) columns.push(column)
    for (let column = 0; column <= last; column += 1) columns.push(column)
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const letter of match[1].split('')) {
    for (const column of columns) {
      const origin = cellOrigin(letter, column)
      if (!origin) continue
      minX = Math.min(minX, origin.x)
      minY = Math.min(minY, origin.y)
      maxX = Math.max(maxX, origin.x + CELL_SIZE)
      maxY = Math.max(maxY, origin.y + CELL_SIZE)
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

// ------------------------------------------------------------------- read

if (!fs.existsSync(indexRoot)) throw new Error(`No world index at ${indexRoot} — run build_world_index.cjs first`)

const archives = JSON.parse(fs.readFileSync(path.join(indexRoot, 'archives.json'), 'utf8'))

/** package name → record. One per `levels/rdr3/area/<block>/<name>.rpf`. */
const packages = new Map()
for (const archive of archives) {
  const entry = String(archive.entry || '').split('\\').join('/')
  const match = AREA_ARCHIVE.exec(entry)
  if (!match) continue
  const name = match[2].toLowerCase()
  if (packages.has(name)) continue
  packages.set(name, {
    name,
    block: match[1],
    archive: archive.id,
    levels: archive.levels,
    entry: archive.entry,
    bounds: blockBounds(match[1]),
    ymaps: [],
    drawables: 0,
    textures: 0,
  })
}

/** archive id → package, so drawable counts can be attributed while streaming. */
const byArchive = new Map([...packages.values()].map((entry) => [entry.archive, entry]))

// Longest name first: `val_01_` must win over any shorter package it starts with.
const names = [...packages.keys()].sort((left, right) => right.length - left.length)

const stream = readline.createInterface({ input: fs.createReadStream(path.join(indexRoot, 'entries.ndjson')) })
stream.on('line', (line) => {
  if (!line) return
  let record
  try { record = JSON.parse(line) } catch { return }

  if (record.e === 'ymap') {
    const ymap = String(record.n).toLowerCase()
    const owner = names.find((name) => ymap === name || ymap.startsWith(name))
    if (owner) packages.get(owner).ymaps.push(record.n)
    return
  }

  const target = byArchive.get(record.a)
  if (!target) return
  if (record.e === 'ydr') target.drawables += 1
  else if (record.e === 'ytd') target.textures += 1
})

stream.on('close', () => {
  const areas = [...packages.values()]
    .map((entry) => ({
      ...entry,
      ymaps: entry.ymaps.sort(),
      center: entry.bounds
        ? { x: (entry.bounds.minX + entry.bounds.maxX) / 2, y: (entry.bounds.minY + entry.bounds.maxY) / 2 }
        : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  const loadable = areas.filter((entry) => entry.ymaps.length > 0)
  const payload = {
    format: 'hexa-area-index',
    version: 1,
    cellSize: CELL_SIZE,
    areaCount: areas.length,
    loadableCount: loadable.length,
    locatedCount: areas.filter((entry) => entry.bounds).length,
    ymapCount: areas.reduce((total, entry) => total + entry.ymaps.length, 0),
    areas,
  }
  fs.writeFileSync(outPath, JSON.stringify(payload))
  process.stdout.write(`FRONTIER_AREA_INDEX ${JSON.stringify({
    path: outPath,
    areas: areas.length,
    loadable: loadable.length,
    located: payload.locatedCount,
    ymaps: payload.ymapCount,
    bytes: fs.statSync(outPath).size,
  })}\n`)
})

/**
 * Where the toolchain lives, and how a command finds it.
 *
 * RDR2 cannot be read the way CodeWalker reads GTA V. Its RPF8 table of
 * contents is encrypted (TFIT2/CBC, keyed by the archive's DecryptionTag — the
 * retail archives carry 0x22/0x18/0x97, i.e. not the unencrypted 0xFF), and the
 * keys live in an external `secrets.bin`, not in the game files. Shipping those
 * keys is off the table, so an archive reader has to already be on the machine.
 *
 * What *can* go away is manual configuration. Everything below is located
 * automatically; flags and environment variables only exist to override a bad
 * guess. Resolution order for every path is:
 *
 *   --flag  >  RDR2_* env  >  HEXA_* env (legacy)  >  config file  >  detection
 *
 * The config file is `rdr2-unpack.json` in the working directory, or
 * `~/.rdr2-unpack.json`, holding any of the same keys: game, cache, helper,
 * secrets, cfx, python.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** `--key=value` and bare `--flag` into a plain object. */
function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map((value) => {
    const index = value.indexOf('=')
    return index > 0
      ? [value.slice(0, index).replace(/^--/, ''), value.slice(index + 1)]
      : [value.replace(/^--/, ''), true]
  }))
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

let configCache = null
function config() {
  if (configCache) return configCache
  // The package root is checked too, because the tools are usually spawned by
  // another program with its own working directory.
  const candidates = [
    path.resolve('rdr2-unpack.json'),
    path.join(__dirname, '..', 'rdr2-unpack.json'),
    path.join(os.homedir(), '.rdr2-unpack.json'),
  ]
  for (const candidate of candidates) {
    try {
      configCache = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      configCache._file = candidate
      return configCache
    } catch { /* try the next candidate */ }
  }
  configCache = {}
  return configCache
}

/** A folder only counts as an installation if it has both the exe and level 0. */
function isGameFolder(folder) {
  return Boolean(folder)
    && fs.existsSync(path.join(folder, 'RDR2.exe'))
    && fs.existsSync(path.join(folder, 'levels_0.rpf'))
}

function registryGamePath() {
  if (process.platform !== 'win32') return null
  for (const value of ['InstallFolderEpic', 'InstallFolderSteam', 'InstallFolder']) {
    try {
      const stdout = execFileSync('reg.exe', [
        'query', 'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Red Dead Redemption 2', '/v', value,
      ], { windowsHide: true, timeout: 3000, encoding: 'utf8' })
      const found = stdout.match(new RegExp(`${value}\\s+REG_SZ\\s+(.+)$`, 'im'))?.[1]?.trim()
      if (isGameFolder(found)) return found
    } catch { /* try the next value */ }
  }
  return null
}

function detectGame() {
  const drives = ['C', 'D', 'E', 'F', 'G', 'H']
  const candidates = [
    registryGamePath(),
    'C:\\Program Files\\Rockstar Games\\Red Dead Redemption 2',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Red Dead Redemption 2',
    ...drives.map((drive) => `${drive}:\\SteamLibrary\\steamapps\\common\\Red Dead Redemption 2`),
    ...drives.map((drive) => `${drive}:\\Program Files\\Rockstar Games\\Red Dead Redemption 2`),
    ...drives.map((drive) => `${drive}:\\RedDeadRedemption2`),
  ]
  return candidates.find(isGameFolder) || null
}

function documentsDir() {
  return path.join(os.homedir(), 'Documents')
}

function detectArchiveExplorer() {
  return firstExisting([
    path.join(documentsDir(), 'ArchiveExplorer', 'ArchiveExplorer.exe'),
    path.join(os.homedir(), 'ArchiveExplorer', 'ArchiveExplorer.exe'),
    path.resolve('ArchiveExplorer.exe'),
  ])
}

function detectSecrets(helper) {
  return firstExisting([
    path.join(documentsDir(), 'ArchiveExplorer', 'secrets.bin'),
    helper ? path.join(path.dirname(helper), 'secrets.bin') : null,
    path.resolve('secrets.bin'),
  ])
}

function detectCfx() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return firstExisting([
    path.join(localAppData, 'FiveM', 'FiveM.app', 'FiveM.com'),
    path.join(localAppData, 'FiveM', 'FiveM.exe'),
    path.join(localAppData, 'RedM', 'RedM.app', 'RedM.com'),
  ])
}

function detectPython() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const versions = ['3.15', '3.14', '3.13']
  return firstExisting([
    ...versions.map((version) => path.join(localAppData, 'Python', `pythoncore-${version}-64`, 'python.exe')),
    ...versions.map((version) => path.join(localAppData, 'Programs', 'Python', `Python${version.replace('.', '')}`, 'python.exe')),
    process.platform === 'win32' ? null : '/usr/bin/python3',
  ])
}

/** The cache defaults to the root of the game's own drive — it is the biggest write. */
function defaultCacheRoot(game) {
  if (game) return path.join(path.parse(path.resolve(game)).root, 'RDR2-World-Cache')
  return path.join(documentsDir(), 'RDR2-World-Cache')
}

const DETECTORS = {
  game: detectGame,
  helper: detectArchiveExplorer,
  cfx: detectCfx,
  python: detectPython,
}

const ENV_KEYS = {
  game: ['RDR2_GAME_DIR', 'HEXA_GAME_DIR'],
  cache: ['RDR2_CACHE_DIR', 'HEXA_CACHE_DIR'],
  helper: ['RDR2_ARCHIVE_EXPLORER', 'HEXA_ARCHIVE_EXPLORER'],
  secrets: ['RDR2_SECRETS', 'HEXA_SECRETS'],
  cfx: ['RDR2_CFX', 'HEXA_CFX'],
  python: ['RDR2_PYTHON', 'HEXA_PYTHON'],
}

const LABELS = {
  game: 'RDR2 installation (--game)',
  cache: 'cache folder (--cache)',
  helper: 'ArchiveExplorer.exe (--helper)',
  secrets: 'secrets.bin (--secrets)',
  cfx: 'FiveM.com / RedM.com (--cfx)',
  python: 'python.exe (--python)',
}

function fromEnv(key) {
  for (const name of ENV_KEYS[key] || []) {
    if (process.env[name]) return process.env[name]
  }
  return null
}

/** One path, resolved through the whole chain. Null when nothing is found. */
function locate(key, options = {}) {
  const chosen = (typeof options[key] === 'string' && options[key])
    || fromEnv(key)
    || (typeof config()[key] === 'string' ? config()[key] : null)
    || (key === 'secrets' ? detectSecrets(locate('helper', options)) : null)
    || (DETECTORS[key] ? DETECTORS[key]() : null)
    || (key === 'cache' ? defaultCacheRoot(locate('game', options)) : null)
  return chosen ? path.resolve(chosen) : null
}

/**
 * Resolve everything a command needs, and fail naming what is missing rather
 * than with an ENOENT from a spawn three stages later.
 *
 * `cache` is never required — it is created on demand.
 */
function resolveToolchain(options = {}, required = []) {
  const resolved = {}
  for (const key of Object.keys(LABELS)) resolved[key] = locate(key, options)

  const missing = required.filter((key) => key !== 'cache' && (!resolved[key] || !fs.existsSync(resolved[key])))
  if (missing.length) {
    const lines = missing.map((key) => `  - ${LABELS[key]}${resolved[key] ? ` — not found at ${resolved[key]}` : ''}`)
    throw new Error([
      'Missing part of the toolchain:',
      ...lines,
      '',
      'Run `rdr2-unpack doctor` to see what was detected.',
    ].join('\n'))
  }
  return resolved
}

module.exports = {
  parseArgs,
  firstExisting,
  isGameFolder,
  locate,
  resolveToolchain,
  defaultCacheRoot,
  configFile: () => config()._file || null,
  LABELS,
  ENV_KEYS,
}

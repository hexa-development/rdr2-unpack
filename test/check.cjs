/**
 * What can be checked without a copy of the game: every CommonJS file parses,
 * the CLI prints its usage, and `doctor` runs to completion whatever it finds.
 *
 * A stray escape in a regex only used to surface when a five-minute extraction
 * died at the last stage, so parsing is checked on every commit instead.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const files = []
for (const dir of ['bin', 'lib', 'tools', 'test']) {
  const full = path.join(root, dir)
  if (!fs.existsSync(full)) continue
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith('.cjs')) files.push(path.join(full, name))
  }
}

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    process.stderr.write(`x ${path.relative(root, file)}\n${result.stderr}\n`)
  }
}
process.stdout.write(`syntax: ${files.length - failed}/${files.length} files ok\n`)

const cli = path.join(root, 'bin', 'rdr2-unpack.cjs')
const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' })
if (!help.stdout.includes('rdr2-unpack')) {
  failed += 1
  process.stderr.write('x help output missing\n')
} else {
  process.stdout.write('cli: help ok\n')
}

// doctor exits 1 when part of the toolchain is absent, which is a normal result
// on a machine without the game — only a crash is a failure here.
const doctor = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8' })
if (![0, 1].includes(doctor.status)) {
  failed += 1
  process.stderr.write(`x doctor exited ${doctor.status}\n${doctor.stderr}\n`)
} else {
  process.stdout.write(`cli: doctor ok (${doctor.status === 0 ? 'toolchain complete' : 'toolchain incomplete'})\n`)
}

/**
 * `joaat` is what turns an asset name into the hash a ymap actually stores, so
 * it is checked against an independent transcription of Jenkins one-at-a-time
 * rather than against a constant copied out of the implementation under test.
 */
const { joaat } = require('../lib/ymap-rsc8.cjs')
const reference = (value) => {
  let hash = 0
  for (const character of String(value).toLowerCase()) {
    hash = (hash + character.charCodeAt(0)) >>> 0
    hash = (hash + (hash << 10)) >>> 0
    hash ^= hash >>> 6
  }
  hash = (hash + (hash << 3)) >>> 0
  hash ^= hash >>> 11
  return (hash + (hash << 15)) >>> 0
}
const samples = ['prop_bench_01', 'val_01__strm_0', 'P_CRATE01X', '']
const wrong = samples.filter((name) => (joaat(name) >>> 0) !== reference(name))
if (wrong.length) {
  failed += 1
  process.stderr.write(`x joaat disagrees with the reference for: ${wrong.join(', ')}\n`)
} else {
  process.stdout.write(`joaat: ${samples.length}/${samples.length} names match the reference\n`)
}

process.exit(failed ? 1 : 0)

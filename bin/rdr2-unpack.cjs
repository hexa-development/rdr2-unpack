#!/usr/bin/env node
/**
 * One entry point for the whole pipeline.
 *
 *   rdr2-unpack doctor
 *   rdr2-unpack index --all
 *   rdr2-unpack areas
 *   rdr2-unpack archetypes
 *   rdr2-unpack model --model=big_glue_tree_002
 *   rdr2-unpack area --area=val_01_ --models
 *   rdr2-unpack textures <ytd-dir> <png-dir>
 *   rdr2-unpack glb <rsc7-ydr-dir> <glb-dir> [--textures=<png-dir>]
 *
 * Each subcommand is a thin forward to the script that does the work, so the
 * scripts stay runnable on their own (`node tools/extract_model.cjs ...`) and
 * this file adds nothing but a name and a usage message.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parseArgs, locate, resolveToolchain, configFile, LABELS } = require('../lib/toolchain.cjs')

const NODE_COMMANDS = {
  index: 'build_world_index.cjs',
  areas: 'build_area_index.cjs',
  archetypes: 'build_archetype_index.cjs',
  model: 'extract_model.cjs',
  area: 'extract_area.cjs',
}

const PYTHON_COMMANDS = {
  textures: 'ytd_to_png.py',
  glb: 'build_ydr_folder.py',
}

const USAGE = `rdr2-unpack — read a local Red Dead Redemption 2 install into open formats

  rdr2-unpack doctor                       show which parts of the toolchain were found
  rdr2-unpack index --all                  index every archive (run this first)
  rdr2-unpack areas                        group the index into named map areas
  rdr2-unpack archetypes                   read every .ytyp so ymap hashes resolve
  rdr2-unpack model --model=<name>         one model out of the game, as GLB
  rdr2-unpack area --area=<name> --models  a whole map area: placements + models
  rdr2-unpack textures <src> <out>         a folder of RSC7 .ytd to PNG
  rdr2-unpack glb <src> <out>              a folder of RSC7 .ydr to GLB

Paths are detected automatically. Override with --game= --cache= --helper=
--cfx= --python=, the matching RDR2_* environment variables, or rdr2-unpack.json.`

const [command, ...rest] = process.argv.slice(2)

if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`)
  process.exit(command ? 0 : 1)
}

if (command === 'doctor') {
  const options = parseArgs(rest)
  let ready = true
  process.stdout.write('rdr2-unpack doctor\n\n')
  for (const [key, label] of Object.entries(LABELS)) {
    const found = locate(key, options)
    // The cache is created on demand, so a missing folder there is not a fault.
    const ok = Boolean(found) && (key === 'cache' || fs.existsSync(found))
    if (!ok) ready = false
    process.stdout.write(`  ${ok ? 'ok  ' : 'MISS'}  ${label.padEnd(32)} ${found || '(not found)'}\n`)
  }
  const file = configFile()
  process.stdout.write(`\nconfig file: ${file || '(none)'}\n`)
  process.stdout.write(ready
    ? 'Toolchain is complete.\n'
    : 'Something is missing — see the README section "What you need on your machine".\n')
  process.exit(ready ? 0 : 1)
}

if (NODE_COMMANDS[command]) {
  const script = path.join(__dirname, '..', 'tools', NODE_COMMANDS[command])
  const result = spawnSync(process.execPath, [script, ...rest], { stdio: 'inherit', windowsHide: true })
  process.exit(result.status === null ? 1 : result.status)
}

if (PYTHON_COMMANDS[command]) {
  const positional = rest.filter((value) => !value.startsWith('--'))
  const flags = rest.filter((value) => value.startsWith('--'))
  if (positional.length < 2) {
    process.stderr.write(`${command} needs a source folder and an output folder\n`)
    process.exit(1)
  }
  const { python } = resolveToolchain(parseArgs(flags), ['python'])
  const script = path.join(__dirname, '..', 'tools', PYTHON_COMMANDS[command])
  const passthrough = flags.filter((value) => !/^--(python|game|cache|helper|cfx|secrets)=/.test(value))
  const result = spawnSync(python, [script, ...positional, ...passthrough], { stdio: 'inherit', windowsHide: true })
  process.exit(result.status === null ? 1 : result.status)
}

process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`)
process.exit(1)

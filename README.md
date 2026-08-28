<div align="center">

<a href="https://github.com/hexa-development">
  <img src="https://raw.githubusercontent.com/hexa-development/.github/main/assets/banner.png" alt="Hexa Development" width="880">
</a>

</div>

# rdr2-unpack

**[English](#english) · [ภาษาไทย](#thai)**

Read a local Red Dead Redemption 2 installation into open formats — a searchable
index of every asset in the game, GLB models, PNG textures, and parsed `.ymap`
placements.

อ่านไฟล์เกม Red Dead Redemption 2 ที่ติดตั้งอยู่ในเครื่องคุณเอง ให้ออกมาเป็นไฟล์เปิด —
ดัชนีของ asset ทุกชิ้นในเกม, โมเดลเป็น `.glb`, เท็กซ์เจอร์เป็น `.png`
และตำแหน่งวางของจาก `.ymap` เป็น JSON

> Windows · Node 18+ · Python 3.13+
> **No game data and no decryption keys are shipped with this tool.**

[![Hexa Development](https://img.shields.io/badge/Hexa-Development-B45309?style=for-the-badge)](https://github.com/hexa-development)
[![RDR2](https://img.shields.io/badge/Game-RDR2-8B0000?style=for-the-badge)](https://www.rockstargames.com/reddeadredemption2)
[![Node](https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.13%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-181717?style=for-the-badge)](LICENSE)

---

<a id="english"></a>

# English

This toolset was split out of Hexa Map Studio (a 3D map editor for RedM) so it
can be used on its own — no editor to open, and easy to plug into another
pipeline.

## What it does

| Command | Result |
| --- | --- |
| `rdr2-unpack doctor` | Report which parts of the toolchain were found, and where |
| `rdr2-unpack index --all` | Walk every `levels_*.rpf` and record which archive holds each asset |
| `rdr2-unpack areas` | Group the index into named places (`val_01_` = all seven of Valentine's ymaps) |
| `rdr2-unpack archetypes` | Read every `.ytyp` so ymap hashes resolve back to real asset names |
| `rdr2-unpack model --model=<name>` | Pull one model out of the game as a textured GLB |
| `rdr2-unpack area --area=<name> --models` | Pull a whole place: placements plus every model it uses |
| `rdr2-unpack textures <src> <out>` | A folder of RSC7 `.ytd` to PNG + manifest |
| `rdr2-unpack glb <src> <out>` | A folder of RSC7 `.ydr` to GLB |

Every script still runs on its own — `node tools/extract_model.cjs --model=...`
works exactly as before. `rdr2-unpack` is only a single entry point that calls
them.

## What you need on your machine

RDR2 encrypts its RPF8 table of contents (TFIT2/CBC) and the keys live in
`secrets.bin`, which is **not part of the game files** — unlike GTA V, which
CodeWalker reads directly. Those keys will never ship with this tool, so an
archive reader has to already be present on the machine.

| Required | Used for |
| --- | --- |
| An installed RDR2 | The source files (must contain `RDR2.exe` + `levels_0.rpf`) |
| `ArchiveExplorer.exe` | Reading RPF8 |
| `secrets.bin` | RPF8 decryption keys |
| FiveM / RedM (Cfx) | RSC8 → RSC7 via `formats:convert` |
| Node.js 18+ | Running the pipeline |
| Python 3.13+ | Mesh / texture conversion |

`rdr2-unpack doctor` locates all of it for you. You only set a path when the
guess is wrong.

## Install

```powershell
git clone https://github.com/QUITFIL3/rdr2-unpack.git
cd rdr2-unpack
python -m pip install -r requirements.txt
node bin/rdr2-unpack.cjs doctor
```

To call it as `rdr2-unpack` from anywhere:

```powershell
npm link          # in the folder you cloned into
rdr2-unpack doctor
```

Or use it as another project's dependency:

```powershell
npm install github:QUITFIL3/rdr2-unpack
```

### When doctor can't find something

Three ways to set a path, in priority order: **flag > environment variable >
config file**

```powershell
# 1. per command
rdr2-unpack index --all '--helper=F:\tools\ArchiveExplorer.exe'

# 2. environment variable
$env:RDR2_ARCHIVE_EXPLORER = 'F:\tools\ArchiveExplorer.exe'
```

3. A `rdr2-unpack.json` in the working directory, in the tool's own folder, or
   at `~/.rdr2-unpack.json`:

```json
{
  "game": "G:\\RedDeadRedemption2",
  "cache": "F:\\RDR2-World-Cache",
  "helper": "F:\\tools\\ArchiveExplorer\\ArchiveExplorer.exe",
  "secrets": "F:\\tools\\ArchiveExplorer\\secrets.bin",
  "cfx": "C:\\Users\\me\\AppData\\Local\\FiveM\\FiveM.app\\FiveM.com",
  "python": "C:\\Users\\me\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe"
}
```

Every variable name: `RDR2_GAME_DIR`, `RDR2_CACHE_DIR`,
`RDR2_ARCHIVE_EXPLORER`, `RDR2_SECRETS`, `RDR2_CFX`, `RDR2_PYTHON`
(the older `HEXA_*` names still work).

## Getting started

In this order — each step uses the one before it:

```powershell
# 1. index the whole game — once, and again only when the game updates
rdr2-unpack index --all

# 2. group it into places
rdr2-unpack areas

# 3. read archetypes from .ytyp (skip this and half of a town comes back as hashes)
rdr2-unpack archetypes

# 4. actually pull things out
rdr2-unpack model --model=big_glue_tree_002
rdr2-unpack area --area=val_01_ --models --jobs=4
```

Step 1 is the long one: two ArchiveExplorer spawns per archive, almost entirely
process startup and I/O wait rather than CPU — so raising `--jobs` pays.
Measured on a 12-core machine over `levels_1` (341 archives): 1 job ≈ 1,228 s,
8 jobs 229 s, 14 jobs 160 s. Past that the disk is the limit, not the CPU.

Step 1 is **incremental** (a levels file whose size and mtime are unchanged is
skipped) and **resumable** (entries are appended as NDJSON, so stopping loses
nothing).

## What you get out

```
<cache>/
  world-index/
    entries.ndjson      one line per file: {n:name, e:ext, a:archiveId, p:path}
    archives.json       archiveId → where that archive actually lives
    index.json          run manifest: which levels files are done, and counts
    areas.json          from `areas` — place → its ymaps and bounds
    archetypes.ndjson   from `archetypes` — one line per archetype
  ondemand/
    glb/<model>.glb     converted models (converted once, then just a file read)
```

A model takes a few seconds to convert (ArchiveExplorer → Cfx
`formats:convert` → GLB), which is why the result is always cached: far too slow
to repeat per use, perfectly fine once per model.

### Machine-readable output

Every command writes JSON lines to stdout behind a fixed prefix. (The
`FRONTIER_` prefix is the old name of the program this was split out of, and is
kept so existing callers keep working.)

| Prefix | Meaning |
| --- | --- |
| `FRONTIER_PROGRESS` | `{stage, current, total, percent, message}` |
| `FRONTIER_MODEL` | from `model` — `{model, glb, cached, textures, bytes, timings}` |
| `FRONTIER_AREA` | from `area` — every placement (emitted first, so a caller can draw immediately) |
| `FRONTIER_AREA_MODELS` | conversion summary for that place |

Reading it from the calling side looks like this:

```js
child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.startsWith('FRONTIER_MODEL ')) {
      const payload = JSON.parse(line.slice('FRONTIER_MODEL '.length))
      // payload.glb is the path to the converted file
    }
  }
})
```

## Use it as a library

The `.ymap` reader is plain JavaScript with no dependencies at all:

```js
const { parseYmap, joaat } = require('rdr2-unpack')

const map = parseYmap(fs.readFileSync('val_01__strm_0.ymap'))
// { version, systemSize, entityCount, entities }

for (const entity of map.entities) {
  // { name, model, modelHash, position:{x,y,z}, rotation:{x,y,z} in degrees,
  //   quaternion:{x,y,z,w}, scale:{x,y,z} }
  console.log(entity.model, entity.position, entity.rotation)
}

joaat('prop_bench_01')   // name → the hash a ymap actually stores
```

A ymap stores hashes, not names. If you already have a name table, pass it as
the second argument: `parseYmap(bytes, (hash) => namesByHash.get(hash))` —
anything that does not resolve becomes a hex label rather than being dropped.

`parseYmap` reads the real RSC8 layout with validation and **refuses to guess** —
if the structure does not match what was verified, it throws instead of
returning plausible nonsense. It takes both binary RSC8 and XML ymaps, deciding
from the magic number.

The path resolver is reusable too:

```js
const { resolveToolchain } = require('rdr2-unpack/toolchain')
const { game, cache, helper, cfx, python } = resolveToolchain({}, ['game', 'helper'])
```

## Troubleshooting

**`Couldn't load CoreRT.dll` while converting a model**
RedM or FiveM is running. The Cfx converter shares files with the running
client — close the game and run again.

**Half of a place comes back as hex numbers**
`rdr2-unpack archetypes` has not been run. A ymap places things by archetype
*hash*, and `.ytyp` files are what turn those hashes back into asset names.
Without them a dense place like `val_01_` leaves 232 of 315 entities unplaceable.

**`No world index at ...`**
Run `rdr2-unpack index --all` first. Every other command reads from that index.

**`Missing part of the toolchain`**
Run `rdr2-unpack doctor`. It names what is missing and shows where it looked.

## Scope

This is **the extractor only** — it reads the game into open formats. It does
not edit, and it does not pack anything back into the game. Terrain, heightmaps
and the 3D world cache live in Hexa Map Studio, which calls this tool.

Windows only, because ArchiveExplorer and the Cfx converter are Windows
binaries.

## Legal

This tool ships no game files, no decryption keys, and no third-party binaries.
It works against the game **you installed yourself**, and what comes out is from
your own machine — do not redistribute it. Details in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Red Dead Redemption 2 is the property of Rockstar Games and Take-Two
Interactive. This is a community tool with no affiliation to either company.

## License

MIT — see [LICENSE](LICENSE)

---

<a id="thai"></a>

# ภาษาไทย

เครื่องมือชุดนี้ถูกแยกออกมาจาก Hexa Map Studio (โปรแกรมแก้ไขแมพ RedM แบบ 3D)
เพื่อให้ใช้เดี่ยว ๆ ได้ ไม่ต้องเปิดโปรแกรม editor และเอาไปต่อกับ pipeline อื่นได้

## ทำอะไรได้บ้าง

| คำสั่ง | ผลลัพธ์ |
| --- | --- |
| `rdr2-unpack doctor` | บอกว่าเจอเครื่องมือครบไหม เจอที่ path ไหน |
| `rdr2-unpack index --all` | เดินอ่าน `levels_*.rpf` ทั้งเกม บันทึกว่า asset แต่ละชิ้นอยู่ archive ไหน |
| `rdr2-unpack areas` | จัดกลุ่มดัชนีเป็น "พื้นที่" (เช่น `val_01_` = Valentine ทั้งหมด 7 ymap) |
| `rdr2-unpack archetypes` | อ่าน `.ytyp` ทุกไฟล์ เพื่อแปลง hash ใน ymap กลับเป็นชื่อ asset จริง |
| `rdr2-unpack model --model=<ชื่อ>` | ดึงโมเดลเดียวออกจากเกม แปลงเป็น GLB พร้อมเท็กซ์เจอร์ |
| `rdr2-unpack area --area=<ชื่อ> --models` | ดึงทั้งพื้นที่: ตำแหน่งวางของ + โมเดลทุกตัวที่ใช้ |
| `rdr2-unpack textures <src> <out>` | โฟลเดอร์ `.ytd` (RSC7) → PNG + manifest |
| `rdr2-unpack glb <src> <out>` | โฟลเดอร์ `.ydr` (RSC7) → GLB |

ทุกสคริปต์ยังรันตรง ๆ ได้เหมือนเดิม เช่น `node tools/extract_model.cjs --model=...`
ตัว `rdr2-unpack` เป็นแค่ทางเข้าเดียวที่เรียกให้

## สิ่งที่ต้องมีในเครื่อง

RDR2 เข้ารหัส table of contents ของ RPF8 ไว้ (TFIT2/CBC) และคีย์อยู่ใน `secrets.bin`
ซึ่ง **ไม่ได้อยู่ในไฟล์เกม** — ต่างจาก GTA V ที่ CodeWalker อ่านได้ตรง ๆ
คีย์พวกนี้จะไม่ถูกแจกมากับเครื่องมือนี้ ดังนั้นในเครื่องต้องมีตัวอ่าน archive อยู่ก่อน

| ต้องมี | ใช้ทำอะไร |
| --- | --- |
| RDR2 ที่ติดตั้งแล้ว | ไฟล์เกมต้นทาง (ต้องมี `RDR2.exe` + `levels_0.rpf`) |
| `ArchiveExplorer.exe` | อ่าน RPF8 |
| `secrets.bin` | คีย์ถอดรหัส RPF8 |
| FiveM / RedM (Cfx) | แปลง RSC8 → RSC7 ผ่าน `formats:convert` |
| Node.js 18+ | รันตัว pipeline |
| Python 3.13+ | แปลง mesh / texture |

`rdr2-unpack doctor` จะไล่หาให้เองทั้งหมด ไม่ต้องตั้ง path เอง เว้นแต่มันเดาผิด

## ติดตั้ง

```powershell
git clone https://github.com/QUITFIL3/rdr2-unpack.git
cd rdr2-unpack
python -m pip install -r requirements.txt
node bin/rdr2-unpack.cjs doctor
```

ถ้าอยากเรียกสั้น ๆ ว่า `rdr2-unpack` จากที่ไหนก็ได้:

```powershell
npm link          # ในโฟลเดอร์ที่ clone มา
rdr2-unpack doctor
```

หรือใช้เป็น dependency ของโปรเจกต์อื่น:

```powershell
npm install github:QUITFIL3/rdr2-unpack
```

### ถ้า doctor หาไม่เจอ

ตั้งค่าได้ 3 ทาง เรียงตามลำดับความสำคัญ: **แฟล็ก > ตัวแปรสภาพแวดล้อม > ไฟล์ config**

```powershell
# 1. แฟล็กต่อคำสั่ง
rdr2-unpack index --all '--helper=F:\tools\ArchiveExplorer.exe'

# 2. ตัวแปรสภาพแวดล้อม
$env:RDR2_ARCHIVE_EXPLORER = 'F:\tools\ArchiveExplorer.exe'
```

3. ไฟล์ `rdr2-unpack.json` ในโฟลเดอร์ที่รัน / ในโฟลเดอร์ของเครื่องมือ / `~/.rdr2-unpack.json`:

```json
{
  "game": "G:\\RedDeadRedemption2",
  "cache": "F:\\RDR2-World-Cache",
  "helper": "F:\\tools\\ArchiveExplorer\\ArchiveExplorer.exe",
  "secrets": "F:\\tools\\ArchiveExplorer\\secrets.bin",
  "cfx": "C:\\Users\\me\\AppData\\Local\\FiveM\\FiveM.app\\FiveM.com",
  "python": "C:\\Users\\me\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe"
}
```

ชื่อตัวแปรสภาพแวดล้อมทั้งหมด: `RDR2_GAME_DIR`, `RDR2_CACHE_DIR`,
`RDR2_ARCHIVE_EXPLORER`, `RDR2_SECRETS`, `RDR2_CFX`, `RDR2_PYTHON`
(ชื่อเดิม `HEXA_*` ยังใช้ได้)

## เริ่มใช้งาน

ทำตามลำดับนี้ — แต่ละขั้นใช้ผลของขั้นก่อนหน้า

```powershell
# 1. ดัชนีทั้งเกม — ครั้งเดียว ทำใหม่เฉพาะตอนเกมอัปเดต
rdr2-unpack index --all

# 2. จัดกลุ่มเป็นพื้นที่
rdr2-unpack areas

# 3. อ่าน archetype จาก .ytyp (ถ้าข้ามขั้นนี้ ของในเมืองจะโผล่มาเป็น hash ครึ่งนึง)
rdr2-unpack archetypes

# 4. ดึงของออกมาใช้จริง
rdr2-unpack model --model=big_glue_tree_002
rdr2-unpack area --area=val_01_ --models --jobs=4
```

ขั้นที่ 1 คือขั้นที่นานที่สุด: มัน spawn ArchiveExplorer สองครั้งต่อ archive
งานเกือบทั้งหมดคือรอ process เริ่มและรอดิสก์ ไม่ใช่ CPU — เพราะงั้นเร่ง `--jobs` ได้คุ้ม
วัดบนเครื่อง 12 คอร์กับ `levels_1` (341 archive): 1 job ≈ 1,228 วินาที, 8 jobs 229 วินาที,
14 jobs 160 วินาที เกินจากนั้นดิสก์ตัน ไม่ใช่ CPU

ขั้นที่ 1 ทำงานแบบ **incremental** (ไฟล์ levels ที่ขนาด/เวลาไม่เปลี่ยนจะถูกข้าม)
และ **resumable** (เขียนเป็น NDJSON ต่อท้าย หยุดกลางคันแล้วรันใหม่ไม่เสียของ)

## ได้อะไรออกมาบ้าง

```
<cache>/
  world-index/
    entries.ndjson      หนึ่งบรรทัดต่อไฟล์: {n:ชื่อ, e:นามสกุล, a:archiveId, p:path}
    archives.json       archiveId → archive ที่อยู่จริง
    index.json          manifest ของรอบที่รัน: levels ไหนเสร็จแล้ว นับได้เท่าไร
    areas.json          ผลของ `areas` — พื้นที่ → รายการ ymap + ขอบเขต
    archetypes.ndjson   ผลของ `archetypes` — หนึ่งบรรทัดต่อ archetype
  ondemand/
    glb/<model>.glb     โมเดลที่แปลงแล้ว (แปลงครั้งเดียว ครั้งต่อไปคืออ่านไฟล์)
```

โมเดลหนึ่งตัวใช้เวลาแปลงไม่กี่วินาที (ArchiveExplorer → Cfx `formats:convert` → GLB)
ผลลัพธ์เลยถูก cache ไว้เสมอ — ช้าเกินกว่าจะทำซ้ำทุกครั้ง แต่พอดีสำหรับทำครั้งเดียวต่อโมเดล

### ผลลัพธ์แบบเครื่องอ่าน

ทุกคำสั่งพ่นบรรทัด JSON ที่ขึ้นต้นด้วยคำนำหน้าคงที่ ลง stdout
(คำนำหน้า `FRONTIER_` เป็นชื่อเดิมจากโปรแกรมที่แยกออกมา และคงไว้เพื่อไม่ให้ของที่ใช้อยู่พัง):

| คำนำหน้า | ความหมาย |
| --- | --- |
| `FRONTIER_PROGRESS` | `{stage, current, total, percent, message}` |
| `FRONTIER_MODEL` | ผลของ `model` — `{model, glb, cached, textures, bytes, timings}` |
| `FRONTIER_AREA` | ผลของ `area` — ตำแหน่งวางของทั้งหมด (ออกก่อน เพื่อให้แสดงผลได้ทันที) |
| `FRONTIER_AREA_MODELS` | สรุปการแปลงโมเดลของพื้นที่นั้น |

อ่านฝั่งผู้เรียกได้ประมาณนี้:

```js
child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.startsWith('FRONTIER_MODEL ')) {
      const payload = JSON.parse(line.slice('FRONTIER_MODEL '.length))
      // payload.glb คือ path ของไฟล์ที่แปลงเสร็จ
    }
  }
})
```

## ใช้เป็น library

ตัวอ่าน `.ymap` เป็น JavaScript ล้วน ไม่ต้องพึ่งอะไรเลย เรียกใช้ตรง ๆ ได้:

```js
const { parseYmap, joaat } = require('rdr2-unpack')

const map = parseYmap(fs.readFileSync('val_01__strm_0.ymap'))
// { version, systemSize, entityCount, entities }

for (const entity of map.entities) {
  // { name, model, modelHash, position:{x,y,z}, rotation:{x,y,z} องศา,
  //   quaternion:{x,y,z,w}, scale:{x,y,z} }
  console.log(entity.model, entity.position, entity.rotation)
}

joaat('prop_bench_01')   // ชื่อ → hash แบบเดียวกับที่ ymap เก็บ
```

ymap เก็บของด้วย hash ไม่ใช่ชื่อ ถ้ามีตารางชื่ออยู่แล้วส่งเข้าไปเป็นอาร์กิวเมนต์ที่สองได้
`parseYmap(bytes, (hash) => namesByHash.get(hash))` — ตัวที่แปลงไม่ได้จะกลายเป็น
ข้อความ hex แทน ไม่ถูกทิ้ง

`parseYmap` อ่าน layout ของ RSC8 จริงพร้อมตรวจความถูกต้อง และ**จะไม่เดา** —
ถ้าโครงสร้างไม่ตรงกับที่ตรวจสอบไว้ มันโยน error แทนที่จะคืนข้อมูลมั่ว ๆ ออกมา
รับทั้ง binary RSC8 และ XML ymap โดยดูจาก magic number ให้เอง

ตัวหา path ก็เอาไปใช้ต่อได้:

```js
const { resolveToolchain } = require('rdr2-unpack/toolchain')
const { game, cache, helper, cfx, python } = resolveToolchain({}, ['game', 'helper'])
```

## แก้ปัญหา

**`Couldn't load CoreRT.dll` ตอนแปลงโมเดล**
แปลว่า RedM หรือ FiveM เปิดค้างอยู่ — ตัวแปลงของ Cfx ใช้ไฟล์ร่วมกับ client
ที่กำลังรัน ปิดเกมแล้วรันใหม่

**ของในพื้นที่โผล่มาเป็นเลข hex ครึ่งหนึ่ง**
ยังไม่ได้รัน `rdr2-unpack archetypes` — ymap วางของด้วย *hash* ของ archetype
และ `.ytyp` คือสิ่งที่แปลง hash กลับเป็นชื่อ asset ถ้าไม่มี พื้นที่หนาแน่นอย่าง
`val_01_` จะเหลือของที่วางไม่ได้ 232 จาก 315 ชิ้น

**`No world index at ...`**
ต้องรัน `rdr2-unpack index --all` ก่อน ทุกคำสั่งที่เหลืออ่านจากดัชนีนี้

**`Missing part of the toolchain`**
รัน `rdr2-unpack doctor` มันจะบอกว่าตัวไหนหาย และหาที่ path ไหนไปแล้วบ้าง

## ขอบเขตของเครื่องมือนี้

ตัวนี้คือ**ตัวถอด**อย่างเดียว — อ่านออกมาเป็นไฟล์เปิด ไม่แก้ ไม่ pack กลับเข้าเกม
ส่วนที่เป็น terrain, heightmap และ world cache 3D อยู่ใน Hexa Map Studio
ซึ่งเรียกใช้ตัวนี้อีกที

รองรับ Windows เท่านั้น เพราะ ArchiveExplorer และ Cfx converter เป็น Windows binary

## ข้อกฎหมาย

เครื่องมือนี้ไม่ได้แจกไฟล์เกม ไม่ได้แจกคีย์ถอดรหัส และไม่ได้แนบ binary ของใครมาด้วย
มันทำงานกับเกมที่**คุณติดตั้งเอง** และไฟล์ที่ได้ออกมาก็เป็นของจากเครื่องคุณเอง —
ห้ามเอาไปแจกต่อ รายละเอียดอยู่ใน [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Red Dead Redemption 2 เป็นทรัพย์สินของ Rockstar Games และ Take-Two Interactive
โปรเจกต์นี้เป็นเครื่องมือของคอมมูนิตี้ ไม่ได้เกี่ยวข้องกับทั้งสองบริษัท

## License

MIT — ดู [LICENSE](LICENSE)

---

## Hexa Ecosystem

`rdr2-unpack` is a standalone tool maintained by [Hexa Development](https://github.com/hexa-development) alongside the Hexa RedM framework. It needs none of the resources below, and none of them need it — it is here because the same people build both.

| Project | Description |
| :--- | :--- |
| [`hexa_core`](https://github.com/hexa-development/hexa_core) | Core framework — players, jobs, items, economy, status, callbacks, permissions |
| [`hexa_inventory`](https://github.com/hexa-development/hexa_inventory) | Persistent grid inventory — stashes, shops, ground drops, secure trading |
| [`hexa_progbar`](https://github.com/hexa-development/hexa_progbar) | Screen-fixed progress bar — drop-in for `ox_lib` `progressBar` |
| [`hexa-bridge`](https://github.com/hexa-development/hexa-bridge) | Compatibility layer for supported RSG and VORP resources |
| [`hexa-docs`](https://github.com/hexa-development/hexa-docs) | Official documentation and API reference (VitePress) |
| **`rdr2-unpack`** | Read a local RDR2 install into open formats — GLB, PNG, `.ymap` JSON <br> *(this repository)* |
| [`txAdmin`](https://github.com/hexa-development/txAdmin) | One-click txAdmin recipe that deploys the whole Hexa stack |

Framework documentation: [hexa-development.github.io/hexa-docs](https://hexa-development.github.io/hexa-docs/) · [เอกสารภาษาไทย](https://hexa-development.github.io/hexa-docs/th/)

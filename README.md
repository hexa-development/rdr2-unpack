# rdr2-unpack

**อ่านไฟล์เกม Red Dead Redemption 2 ที่ติดตั้งอยู่ในเครื่องคุณเอง ให้ออกมาเป็นไฟล์เปิด** —
ดัชนีของ asset ทุกชิ้นในเกม, โมเดลเป็น `.glb`, เท็กซ์เจอร์เป็น `.png`
และตำแหน่งวางของจาก `.ymap` เป็น JSON

> **In English:** a command-line pipeline that turns a local Red Dead Redemption 2
> installation into open formats — a searchable index of every asset in the game,
> GLB models, PNG textures, and parsed `.ymap` placements. Windows, Node 18+,
> Python 3.13+. **No game data and no decryption keys are shipped with this tool.**

เครื่องมือชุดนี้ถูกแยกออกมาจาก [Hexa Map Studio](https://github.com/QUITFIL3/RedM-Map-Studio)
เพื่อให้ใช้เดี่ยว ๆ ได้ ไม่ต้องเปิดโปรแกรม editor และเอาไปต่อกับ pipeline อื่นได้

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

## ขอบเขตของเครื่องมือนี้

ตัวนี้คือ**ตัวถอด**อย่างเดียว — อ่านออกมาเป็นไฟล์เปิด ไม่แก้ ไม่ pack กลับเข้าเกม
ส่วนที่เป็น terrain, heightmap และ world cache 3D อยู่ใน
[Hexa Map Studio](https://github.com/QUITFIL3/RedM-Map-Studio) ซึ่งเรียกใช้ตัวนี้อีกที

รองรับ Windows เท่านั้น เพราะ ArchiveExplorer และ Cfx converter เป็น Windows binary

---

## ข้อกฎหมาย

เครื่องมือนี้ไม่ได้แจกไฟล์เกม ไม่ได้แจกคีย์ถอดรหัส และไม่ได้แนบ binary ของใครมาด้วย
มันทำงานกับเกมที่**คุณติดตั้งเอง** และไฟล์ที่ได้ออกมาก็เป็นของจากเครื่องคุณเอง —
ห้ามเอาไปแจกต่อ รายละเอียดอยู่ใน [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Red Dead Redemption 2 เป็นทรัพย์สินของ Rockstar Games และ Take-Two Interactive
โปรเจกต์นี้เป็นเครื่องมือของคอมมูนิตี้ ไม่ได้เกี่ยวข้องกับทั้งสองบริษัท

## License

MIT — ดู [LICENSE](LICENSE)

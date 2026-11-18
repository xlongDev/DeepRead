#!/usr/bin/env node
// Generates `原声配音演示.epub`: a minimal EPUB 3 with **media overlays** —
// the only fixture that exercises the kernel's MediaOverlay path (SMIL parse,
// audio scheduling, highlight + page follow). Two chapters, four `<par>`
// segments over generated sine-wave WAVs, `media:active-class` declared in the
// OPF so the reader can style the highlighted element.
//
// No dependencies: the ZIP is hand-written (store method, CRC32 table) and the
// WAVs are generated PCM. Run via `node scripts/make-mo-epub.mjs`.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/desktop/public/fixtures/原声配音演示.epub')

/* ---------- WAV:16bit 单股 PCM 正弦,四段不同音高 ---------- */

const RATE = 22_050
const SEGMENT_SECONDS = 1.2
const FREQS = [440, 554, 659, 880]

function wav(freq) {
  const samples = Math.floor(RATE * SEGMENT_SECONDS)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const t = i / RATE
    // 起止 30ms 淡入淡出,段间不咔哒。
    const envelope = Math.min(1, i / (RATE * 0.03), (samples - i) / (RATE * 0.03))
    const value = Math.sin(2 * Math.PI * freq * t) * 0.6 * envelope
    data.writeInt16LE(Math.round(value * 32_767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/* ---------- 文本资产 ---------- */

const SENTENCES = [
  '雪落在灯塔上,像一封很长的信。',
  '守灯人把火拨旺,海就有了方向。',
  '船在远处按了三声笛,雪没有回答。',
  '但灯一直亮着,直到天把海读成银色。',
]

const page = (title, ids) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>${title}</title></head>
<body>
${ids.map((id, i) => `  <p id="${id}">${SENTENCES[i % SENTENCES.length]}</p>`).join('\n')}
</body>
</html>
`

const smil = (pageHref, pars) => `<?xml version="1.0" encoding="utf-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0">
  <body>
${pars
  .map(
    ({ id, wav, begin, end }) => `    <par id="${id}">
      <text src="${pageHref}#${id}"/>
      <audio src="audio/${wav}" clipBegin="${begin}s" clipEnd="${end}s"/>
    </par>`,
  )
  .join('\n')}
  </body>
</smil>
`

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:deepread-mo-demo</dc:identifier>
    <dc:title>原声配音演示</dc:title>
    <dc:language>zh</dc:language>
    <dc:creator>DeepRead</dc:creator>
    <meta property="media:active-class">-epub-media-overlay-active</meta>
    <meta property="media:duration" refines="#sm1">0:04</meta>
    <meta property="media:duration" refines="#sm2">0:02</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml" media-overlay="sm1"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml" media-overlay="sm2"/>
    <item id="sm1" href="ch1.smil" media-type="application/smil+xml"/>
    <item id="sm2" href="ch2.smil" media-type="application/smil+xml"/>
${FREQS.map((_, i) => `    <item id="a${i + 1}" href="audio/a${i + 1}.wav" media-type="audio/wav"/>`).join('\n')}
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
`

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="ch1.xhtml">第一章 灯</a></li>
      <li><a href="ch2.xhtml">第二章 海</a></li>
    </ol>
  </nav>
</body>
</html>
`

const container = `<?xml version="1.0" encoding="utf-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

/* ---------- 最小 ZIP(store,不压缩;CRC32 手写) ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.write('PK\x03\x04', 0)
    local.writeUInt16LE(20, 4) // version
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.write('PK\x01\x02', 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.write('PK\x05\x06', 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

/* ---------- 组装 ---------- */

const ch1 = page('第一章 灯', ['p1', 'p2', 'p3', 'p4'])
const ch2 = page('第二章 海', ['p5', 'p6'])
const clockOf = (i) => ({
  begin: (i * SEGMENT_SECONDS).toFixed(1),
  end: ((i + 1) * SEGMENT_SECONDS).toFixed(1),
})
const smilPars = (count, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${offset + i + 1}`,
    wav: `a${(i % FREQS.length) + 1}.wav`,
    ...clockOf(i % FREQS.length),
  }))

const files = [
  { name: 'mimetype', data: Buffer.from('application/epub+zip') },
  { name: 'META-INF/container.xml', data: Buffer.from(container) },
  { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
  { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav) },
  { name: 'OEBPS/ch1.xhtml', data: Buffer.from(ch1) },
  { name: 'OEBPS/ch2.xhtml', data: Buffer.from(ch2) },
  { name: 'OEBPS/ch1.smil', data: Buffer.from(smil('ch1.xhtml', smilPars(4))) },
  { name: 'OEBPS/ch2.smil', data: Buffer.from(smil('ch2.xhtml', smilPars(2, 4))) },
  ...FREQS.map((freq, i) => ({ name: `OEBPS/audio/a${i + 1}.wav`, data: wav(freq) })),
]

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, zip(files))
console.log(`written ${OUT} (${files.length} entries)`)

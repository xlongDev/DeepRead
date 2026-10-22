#!/usr/bin/env node
// Generates `demo-image.pdf`: a one-page PDF with black text and an embedded
// RGB image (four color quadrants). Used for manual checks and browser E2E of
// PDF night mode — the quadrants make "kept images" pixel-exact to assert:
// red/green/blue/yellow must survive feColorMatrix recoloring untouched.
//
// No dependencies: the PDF is hand-written and the image is ASCIIHex-encoded
// so the fixture stays a text file. Run via scripts/make-fixtures.sh.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/desktop/public/fixtures/demo-image.pdf')

const W = 120
const H = 80
// Four quadrants: red, green, blue, yellow — each 60x40.
const QUADRANTS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
]
const hex = []
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const qx = x < W / 2 ? 0 : 1
    const qy = y < H / 2 ? 0 : 1
    const [r, g, b] = QUADRANTS[qy * 2 + qx]
    hex.push(((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1))
  }
}
const imageHex = hex.join('')

const objects = [
  // 1: catalog
  '<< /Type /Catalog /Pages 2 0 R >>',
  // 2: pages
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  // 3: page
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R
   /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> >>`,
  // 4: content stream — text plus the image at x 100..220, y 400..480
  `<< /Length ${'q 120 0 0 80 100 400 cm /Im0 Do Q\nBT /F1 28 Tf 72 700 Td (Hello, AI Reader.) Tj ET\nBT /F1 14 Tf 72 660 Td (A PDF fixture with an embedded image.) Tj ET'.length} >>
stream
q 120 0 0 80 100 400 cm /Im0 Do Q
BT /F1 28 Tf 72 700 Td (Hello, AI Reader.) Tj ET
BT /F1 14 Tf 72 660 Td (A PDF fixture with an embedded image.) Tj ET
endstream`,
  // 5: font
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  // 6: image XObject (hex-encoded RGB)
  `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H}
   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode
   /Length ${imageHex.length + 1} >>
stream
${imageHex}>
endstream`,
]

let pdf = '%PDF-1.4\n'
const offsets = []
for (let i = 0; i < objects.length; i++) {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
}
const xrefOffset = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, pdf)
console.log(`wrote ${OUT} (${pdf.length} bytes, image ${W}x${H})`)

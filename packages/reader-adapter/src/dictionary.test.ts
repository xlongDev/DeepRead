import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildIndex,
  decodeFields,
  dictionaryFileCandidates,
  inflateGzip,
  lookupWord,
} from './dictionary/stardict'

function makeIdx(entries: readonly { word: string; offset: number; size: number }[]): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  for (const entry of entries) {
    const wordBytes = new TextEncoder().encode(entry.word)
    const part = new Uint8Array(wordBytes.length + 9)
    part.set(wordBytes)
    new DataView(part.buffer).setUint32(wordBytes.length + 1, entry.offset)
    new DataView(part.buffer).setUint32(wordBytes.length + 5, entry.size)
    chunks.push(part)
    total += part.length
  }
  const out = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    out.set(chunk, position)
    position += chunk.length
  }
  return out
}

const sequence = 'm'
const dict = new TextEncoder().encode('a crisp red fruit苹果是一种水果banana split')
// offsets are byte-accurate: 17 (ascii) + 21 (3 bytes × 7 CJK chars)
const entries = makeIdx([
  { word: 'apple', offset: 0, size: 17 },
  { word: '苹果', offset: 17, size: 21 },
  { word: 'banana', offset: 38, size: 12 },
])

describe('buildIndex', () => {
  it('walks word\\0 + offset + size entries in file order', () => {
    const index = buildIndex(entries)
    expect(index.map((e) => e.word)).toEqual(['apple', '苹果', 'banana'])
    expect(index[0]).toMatchObject({ offset: 0, size: 17 })
  })
})

describe('lookupWord', () => {
  const index = buildIndex(entries)

  it('finds exact entries (utf8 words included)', () => {
    expect(lookupWord(index, dict, 'apple', sequence)[0]?.fields).toEqual([
      { type: 'text', content: 'a crisp red fruit' },
    ])
    expect(lookupWord(index, dict, '苹果', sequence)[0]?.fields).toEqual([
      { type: 'text', content: '苹果是一种水果' },
    ])
  })

  it('is ASCII-case-insensitive', () => {
    expect(lookupWord(index, dict, 'APPLE', sequence)).toHaveLength(1)
  })

  it('returns empty for misses', () => {
    expect(lookupWord(index, dict, 'zzz', sequence)).toEqual([])
  })

  it('binary search: shuffled 1000-entry index still finds all duplicate hits', () => {
    const words: string[] = []
    for (let i = 0; i < 1000; i++) words.push(`w${i}`)
    words.push('dup', 'DUP', 'dup')
    // 固定步长乱序(可复现),模拟不守规范排序的 .idx。
    const shuffled = words.map((_, i) => words[(i * 7 + 3) % words.length]!)
    const bigIndex = buildIndex(makeIdx(shuffled.map((word) => ({ word, offset: 0, size: 0 }))))
    const hits = lookupWord(bigIndex, new Uint8Array(0), 'dup', sequence)
    expect(hits).toHaveLength(3)
    expect(hits.map((hit) => hit.word.toLowerCase())).toEqual(['dup', 'dup', 'dup'])
    // 大索引上精确与大小写不敏感路径仍然正确。
    expect(lookupWord(bigIndex, new Uint8Array(0), 'w42', sequence)).toHaveLength(1)
    expect(lookupWord(bigIndex, new Uint8Array(0), 'W42', sequence)).toHaveLength(1)
    expect(lookupWord(bigIndex, new Uint8Array(0), 'nothing', sequence)).toEqual([])
  })
})

describe('decodeFields', () => {
  it('splits sized fields for multi-type sequences', () => {
    const head = new TextEncoder().encode('正文')
    const tail = new TextEncoder().encode('<i>x</i>')
    const raw = new Uint8Array(4 + head.length + tail.length)
    new DataView(raw.buffer).setUint32(0, head.length)
    raw.set(head, 4)
    raw.set(tail, 4 + head.length)
    expect(decodeFields(raw, 'mh')).toEqual([
      { type: 'text', content: '正文' },
      { type: 'html', content: '<i>x</i>' },
    ])
  })

  it('treats the whole payload as the last field', () => {
    const raw = new TextEncoder().encode('<b>bold</b>')
    expect(decodeFields(raw, 'h')).toEqual([{ type: 'html', content: '<b>bold</b>' }])
  })
})

describe('inflateGzip', () => {
  it('inflates gzip (.dict.dz) payloads', async () => {
    const compressed = gzipSync(new TextEncoder().encode('inflated content'))
    const inflated = await inflateGzip(compressed)
    expect(new TextDecoder().decode(inflated)).toBe('inflated content')
  })
})

describe('dictionaryFileCandidates', () => {
  it('lists sibling candidates in order', () => {
    const candidates = dictionaryFileCandidates('/dicts/oald.ifo')
    expect(candidates.idx[0]).toBe('/dicts/oald.idx')
    expect(candidates.dict[1]).toBe('/dicts/oald.dict.dz')
  })
})

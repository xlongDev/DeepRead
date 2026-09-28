import { describe, expect, it } from 'vitest'
import { coverPalette, formatBytes, formatStatDuration, shelfTitle } from './shelf-view'
import type { ShelfBook } from './shelf-view'

const book = (overrides: Partial<ShelfBook>): ShelfBook => ({
  hash: 'a'.repeat(64),
  fileName: '夜航书.epub',
  displayName: null,
  format: 'epub',
  path: '/books/夜航书.epub',
  size: 2391,
  addedAt: '2026-09-01T00:00:00Z',
  progress: null,
  tags: [],
  ...overrides,
})

describe('shelfTitle', () => {
  it('prefers the resolved metadata title', () => {
    expect(shelfTitle(book({ displayName: '夜航书' }))).toBe('夜航书')
  })

  it('falls back to a cleaned file name while the title is unresolved', () => {
    expect(shelfTitle(book({ fileName: '夜航书 (z-library.sk, 1lib.sk).epub' }))).toBe('夜航书')
  })
})

describe('coverPalette', () => {
  it('is stable per hash and always returns a pair', () => {
    const first = coverPalette('a'.repeat(64))
    expect(coverPalette('a'.repeat(64))).toEqual(first)
    expect(first).toHaveLength(2)
    expect(coverPalette('')).toHaveLength(2)
  })
})

describe('labels', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('formats durations compactly', () => {
    expect(formatStatDuration(30)).toBe('30 秒')
    expect(formatStatDuration(600)).toBe('10 分')
    expect(formatStatDuration(5400)).toBe('1.5 小时')
  })
})

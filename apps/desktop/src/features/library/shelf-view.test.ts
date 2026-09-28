import { describe, expect, it } from 'vitest'
import {
  coverPalette,
  formatBytes,
  formatStatDuration,
  isFavorite,
  MAX_TAGS,
  parseTagInput,
  shelfTitle,
  toggleFavoriteTag,
} from './shelf-view'
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

describe('标签输入解析', () => {
  it('splits on 中英文逗号、分号、斜杠、顿号与空白', () => {
    expect(parseTagInput('文学, 社科，科技; 非虚构/随笔、历史 传记')).toEqual([
      '文学',
      '社科',
      '科技',
      '非虚构',
      '随笔',
      '历史',
      '传记',
    ])
  })

  it('trims, drops empties and dedupes', () => {
    expect(parseTagInput('  文学 ,, 文学 , ,')).toEqual(['文学'])
    expect(parseTagInput('   ')).toEqual([])
  })

  it('上限与 Rust 侧 set_tags 一致:单标签 32 字、总量 20 个', () => {
    expect(parseTagInput('a'.repeat(33))).toEqual([])
    expect(parseTagInput('a'.repeat(32))).toHaveLength(1)
    const many = Array.from({ length: 25 }, (_, i) => `标签${i}`).join(',')
    expect(parseTagInput(many)).toHaveLength(MAX_TAGS)
  })
})

describe('收藏', () => {
  it('就是一个保留标签,不进不出都不新增字段', () => {
    expect(isFavorite(book({ tags: ['收藏'] }))).toBe(true)
    expect(isFavorite(book({ tags: [] }))).toBe(false)
    expect(toggleFavoriteTag([])).toEqual(['收藏'])
    expect(toggleFavoriteTag(['文学', '收藏'])).toEqual(['文学'])
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

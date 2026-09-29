import { describe, expect, it } from 'vitest'
import {
  coverPalette,
  formatBytes,
  formatStatDuration,
  isFavorite,
  MAX_TAGS,
  parseTagInput,
  shelfTitle,
  SORT_DEFAULT_DIR,
  sortBooks,
  toggleFavoriteTag,
} from './shelf-view'
import type { ShelfBook } from './shelf-view'

const book = (overrides: Partial<ShelfBook>): ShelfBook => ({
  hash: 'a'.repeat(64),
  fileName: '夜航书.epub',
  displayName: null,
  author: null,
  subtitle: null,
  publisher: null,
  language: null,
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

describe('sortBooks', () => {
  const shelf: readonly ShelfBook[] = [
    book({
      hash: 'a'.repeat(64),
      displayName: '乙书',
      size: 300,
      addedAt: '2026-09-02T00:00:00Z',
      progress: 0.5,
    }),
    book({
      hash: 'b'.repeat(64),
      displayName: '甲书',
      size: 100,
      addedAt: '2026-09-01T00:00:00Z',
      progress: null,
    }),
    book({
      hash: 'c'.repeat(64),
      displayName: '丙书',
      size: 200,
      addedAt: '2026-09-03T00:00:00Z',
      progress: 1,
    }),
  ]
  const titles = (list: readonly ShelfBook[]): readonly (string | undefined)[] =>
    list.map((item) => shelfTitle(item))

  it('按最近添加排序,两个方向互为反序', () => {
    expect(titles(sortBooks(shelf, 'added', 'desc'))).toEqual(['丙书', '乙书', '甲书'])
    expect(titles(sortBooks(shelf, 'added', 'asc'))).toEqual(['甲书', '乙书', '丙书'])
  })

  it('按书名用中文本地化比较(拼音,不是码位)', () => {
    expect(titles(sortBooks(shelf, 'title', 'asc'))).toEqual(['丙书', '甲书', '乙书'])
    expect(titles(sortBooks(shelf, 'title', 'desc'))).toEqual(['乙书', '甲书', '丙书'])
  })

  it('按大小排序', () => {
    expect(titles(sortBooks(shelf, 'size', 'desc'))).toEqual(['乙书', '丙书', '甲书'])
    expect(titles(sortBooks(shelf, 'size', 'asc'))).toEqual(['甲书', '丙书', '乙书'])
  })

  it('未开始读的书在两个方向下都沉底', () => {
    // 升序把「未开始」当成进度最小顶到最前,不是用户想看的。
    expect(titles(sortBooks(shelf, 'progress', 'asc'))).toEqual(['乙书', '丙书', '甲书'])
    expect(titles(sortBooks(shelf, 'progress', 'desc'))).toEqual(['丙书', '乙书', '甲书'])
  })

  it('返回新数组,不改动入参顺序', () => {
    const before = titles(shelf)
    expect(titles(sortBooks(shelf, 'size', 'asc'))).not.toEqual(before)
    expect(titles(shelf)).toEqual(before)
  })

  it('每个排序键都有自己的自然方向', () => {
    expect(SORT_DEFAULT_DIR).toEqual({
      added: 'desc',
      title: 'asc',
      size: 'desc',
      progress: 'desc',
    })
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

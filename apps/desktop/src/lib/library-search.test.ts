import { describe, expect, it } from 'vitest'
import type { LibraryBook } from '@deepread/shared'
import { matchesBookQuery } from './library-search'

const book: LibraryBook = {
  hash: 'a'.repeat(64),
  fileName: '化雪的季节 (z-library.sk).epub',
  displayName: '化雪的季节',
  author: '迟子建',
  subtitle: '北疆童年三部曲之一',
  publisher: null,
  language: 'zh',
  format: 'epub',
  path: '/tmp/a.epub',
  size: 1024,
  addedAt: '2026-10-13T00:00:00Z',
  progress: null,
  lastReadAt: null,
  finishedAt: null,
  tags: ['文学', '小说'],
}

describe('matchesBookQuery', () => {
  it('matches title, author, subtitle, file name and tags', () => {
    expect(matchesBookQuery(book, '化雪')).toBe(true)
    expect(matchesBookQuery(book, '迟子建')).toBe(true)
    expect(matchesBookQuery(book, '三部曲')).toBe(true)
    // 文件名也在搜索范围内:元数据没解析出来的书靠它才搜得到。
    expect(matchesBookQuery(book, 'z-library')).toBe(true)
    expect(matchesBookQuery(book, '小说')).toBe(true)
  })

  it('is case-insensitive for ASCII', () => {
    expect(matchesBookQuery(book, 'Z-LIBRARY')).toBe(true)
  })

  it('treats a blank query as "match everything"', () => {
    expect(matchesBookQuery(book, '   ')).toBe(true)
  })

  it('does not match unrelated words', () => {
    expect(matchesBookQuery(book, '夜航')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { pickContinueReading, type ShelfBook } from './shelf-view'

const book = (hash: string, lastReadAt: string | null): ShelfBook => ({
  hash,
  fileName: `${hash}.epub`,
  displayName: hash,
  author: null,
  subtitle: null,
  publisher: null,
  language: null,
  format: 'epub',
  path: `/books/${hash}.epub`,
  size: 10,
  addedAt: '2026-10-01T00:00:00Z',
  progress: 0.5,
  lastReadAt,
  finishedAt: null,
  tags: [],
})

describe('pickContinueReading(继续阅读)', () => {
  it('取最近一次保存进度的那本,与数组顺序无关', () => {
    const books = [book('a', '2026-10-01T00:00:00Z'), book('b', '2026-10-03T00:00:00Z')]
    expect(pickContinueReading(books)?.hash).toBe('b')
    expect(pickContinueReading([...books].reverse())?.hash).toBe('b')
  })

  it('没打开过的书(lastReadAt null)不参选', () => {
    expect(pickContinueReading([book('a', null)])).toBeNull()
    expect(pickContinueReading([book('a', null), book('b', '2026-10-02T00:00:00Z')])?.hash).toBe(
      'b',
    )
  })

  it('空书架返回 null', () => {
    expect(pickContinueReading([])).toBeNull()
  })
})

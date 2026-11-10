import { beforeEach, describe, expect, it } from 'vitest'
import { COMMAND, type LibraryBook, type ReaderStatePayload } from '@deepread/shared'
import { webHandlers } from './web-handlers'
import {
  deleteStoredState,
  listStoredBooks,
  purgeStoredBook,
  putStoredBook,
  putStoredState,
  type StoredBook,
} from './web-store'

/**
 * `library.list` 的派生列:进度与「上次在读」都必须从 states 现算。
 *
 * 漏掉 lastReadAt 的后果不是少一个字段,而是书架永远挑不出「继续阅读」那本
 * (pickContinueReading 以它为唯一依据),web 端读过的书退回来还是从头开始。
 */

const HASH = 'a'.repeat(64)

function book(hash: string): StoredBook {
  return {
    hash,
    fileName: '长日将尽.azw3',
    displayName: '长日将尽',
    author: '石黑一雄',
    subtitle: null,
    publisher: null,
    language: 'zh',
    format: 'azw3',
    // 浏览器里没有文件路径,形状仍与桌面端 LibraryBook 对齐。
    path: '',
    size: 1024,
    addedAt: '2026-11-01T00:00:00.000Z',
    lastReadAt: null,
    finishedAt: null,
    tags: [],
  }
}

function state(updatedAt: string): ReaderStatePayload {
  return {
    progress: { cfi: 'epubcfi(/6/8)', fraction: 0.31 },
    annotations: [],
    bookmarks: [],
    updatedAt,
  }
}

async function listBooks(): Promise<readonly LibraryBook[]> {
  const handler = webHandlers[COMMAND.libraryList]
  if (handler === undefined) throw new Error('library.list 没有 web 实现')
  return (await handler(undefined)).books
}

beforeEach(async () => {
  // 库连接是模块级缓存的(删库不会重建连接),清空用到的 store 即可。
  for (const row of await listStoredBooks()) await purgeStoredBook(row.hash)
  await deleteStoredState(HASH)
})

describe('library.list(web)', () => {
  it('进度与上次在读时刻都取自 states', async () => {
    await putStoredBook(book(HASH))
    await putStoredState(HASH, state('2026-11-10T04:00:00.000Z'))

    const [row] = await listBooks()
    expect(row?.progress).toBe(0.31)
    expect(row?.lastReadAt).toBe('2026-11-10T04:00:00.000Z')
  })

  it('从未打开过的书两项都是 null —— 不能被当成「读到 0%」', async () => {
    await putStoredBook(book(HASH))

    const [row] = await listBooks()
    expect(row?.progress).toBeNull()
    expect(row?.lastReadAt).toBeNull()
  })
})

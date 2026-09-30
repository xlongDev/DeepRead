import { beforeEach, describe, expect, it } from 'vitest'

import {
  exportSnapshot,
  importSnapshot,
  listStoredBooks,
  listStoredCards,
  listStoredStates,
  purgeStoredBook,
  putStoredBook,
  putStoredCards,
  putStoredState,
  type StoredBook,
} from './web-store'
import type { LearningCard } from '@deepread/shared'

/**
 * web 端的持久化。e2e(scripts/smoke-web.mjs)覆盖了"导入→刷新还在"这条主干,
 * 这里补它够不到的边界:孤儿数据、坏快照、跨 store 的连带删除。
 */

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

const STORES = ['books', 'files', 'covers', 'states', 'stats', 'cards', 'fonts'] as const

function book(hash: string, name = '示例书'): StoredBook {
  return {
    hash,
    fileName: `${name}.epub`,
    displayName: name,
    author: '某人',
    subtitle: null,
    publisher: null,
    language: 'zh',
    format: 'epub',
    // 浏览器里没有"文件路径",但形状要和桌面端的 LibraryBook 对齐 ——
    // 两边跑的是同一份上层代码。
    path: '',
    size: 1024,
    addedAt: '2026-09-30T00:00:00.000Z',
    tags: [],
  }
}

function card(id: string, bookHash: string): LearningCard {
  return {
    id,
    bookHash,
    front: '问',
    back: '答',
    source: 'highlight',
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: '2026-09-30T00:00:00.000Z',
    createdAt: '2026-09-30T00:00:00.000Z',
  }
}

/**
 * 库连接是模块级缓存的(`getDatabase` 记住第一次的 Promise),所以**不能**靠
 * `deleteDatabase` 隔离用例 —— 删掉之后缓存的连接还指着旧库。改成清空各个
 * store,效果一样但不动连接。
 */
beforeEach(async () => {
  // 先碰一下 web-store 的 API,让它按自己的版本号建库 —— 直接
  // `indexedDB.open('deepread-web')` 不带版本号不会触发 onupgradeneeded,
  // 拿到的会是个一个 store 都没有的空库。
  await listStoredBooks()

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('deepread-web')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await Promise.all(
    STORES.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(name, 'readwrite')
          transaction.objectStore(name).clear()
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
        }),
    ),
  )
  db.close()
})

describe('books', () => {
  it('写进去能读出来', async () => {
    await putStoredBook(book(HASH))
    const books = await listStoredBooks()
    expect(books).toHaveLength(1)
    expect(books[0]?.displayName).toBe('示例书')
  })

  it('同一个 hash 重复写是更新而不是新增', async () => {
    await putStoredBook(book(HASH, '旧名'))
    await putStoredBook(book(HASH, '新名'))
    const books = await listStoredBooks()
    expect(books).toHaveLength(1)
    expect(books[0]?.displayName).toBe('新名')
  })
})

describe('purgeStoredBook', () => {
  it('删书时把进度、卡片一起带走,不留孤儿', async () => {
    await putStoredBook(book(HASH))
    await putStoredBook(book(OTHER, '另一本'))
    await putStoredState(HASH, {
      progress: { cfi: 'epubcfi(/6/4)', fraction: 0.5 },
      annotations: [],
      bookmarks: [],
      updatedAt: '2026-09-30T00:00:00.000Z',
    })
    await putStoredCards([card('c1', HASH), card('c2', HASH), card('c3', OTHER)])

    await purgeStoredBook(HASH)

    expect(await listStoredBooks()).toHaveLength(1)
    expect((await listStoredStates()).filter((s) => s.hash === HASH)).toHaveLength(0)
    // 卡片是最容易漏的一处:Rust 那边靠 ON DELETE CASCADE,web 端得自己删。
    const remaining = await listStoredCards()
    expect(remaining.map((c) => c.id)).toEqual(['c3'])
  })

  it('只删指定那本,别的书不受影响', async () => {
    await putStoredBook(book(HASH))
    await putStoredBook(book(OTHER, '另一本'))
    await purgeStoredBook(HASH)
    expect((await listStoredBooks()).map((b) => b.hash)).toEqual([OTHER])
  })
})

describe('备份快照', () => {
  it('导出再导入,书架与卡片都回来了', async () => {
    await putStoredBook(book(HASH))
    await putStoredCards([card('c1', HASH)])

    const snapshot = await exportSnapshot()
    const parsed = JSON.parse(snapshot.text) as Record<string, unknown>
    expect(typeof parsed.checksum).toBe('string')

    // 清空后再导入 —— 否则"导入成功"可能只是"本来就在"。
    await purgeStoredBook(HASH)
    expect(await listStoredBooks()).toHaveLength(0)

    await importSnapshot(snapshot.text)
    expect(await listStoredBooks()).toHaveLength(1)
    expect(await listStoredCards()).toHaveLength(1)
  })

  it('校验和不匹配就拒绝,且一个字节都不写', async () => {
    await putStoredBook(book(HASH))
    const snapshot = await exportSnapshot()
    await purgeStoredBook(HASH)

    // 改掉 payload 里的书名,checksum 还是旧的 —— 必须被挡住。
    const tampered = snapshot.text.replace('示例书', '被篡改的书')
    expect(tampered).not.toBe(snapshot.text)

    await expect(importSnapshot(tampered)).rejects.toThrow()
    expect(await listStoredBooks()).toHaveLength(0)
  })

  it('不是 JSON 就拒绝', async () => {
    await expect(importSnapshot('这不是 json')).rejects.toThrow()
  })

  it('没有 checksum 字段的 JSON 也拒绝', async () => {
    await expect(importSnapshot('{"version":1,"books":[]}')).rejects.toThrow()
  })
})

/**
 * web 端的本地存储:IndexedDB。
 *
 * 桌面端把书、进度、批注全交给 Rust 侧的 SQLite;浏览器里既没有 SQLite,
 * 也没有「文件路径」这回事。这里用 IndexedDB 顶上,**数据形状与桌面端严格
 * 对齐** —— 这样上层(书架、阅读器、笔记页)一行都不用改,它们只是照旧调
 * `library.list` / `reader.state.get`。
 *
 * 关键一点是**书籍文件本身也要存进来**(Blob),不能只存元数据:否则刷新
 * 之后书架还在、点开却读不了,那比没有书架更糟。这个做法参考 readest
 * (它的 web 端用 `indexedDBFileSystem` 把整个文件系统映射进 IndexedDB)。
 *
 * 配额是这里唯一躲不掉的约束:浏览器给的是「最多」不是「保证」。写入失败
 * 一律转成 `StorageQuotaError`,由上层给用户一句人话,而不是静默丢掉一本书。
 */

import type { LibraryBook, ReaderStatePayload } from '@deepread/shared'

const DB_NAME = 'deepread-web'
const DB_VERSION = 1

const STORE_BOOKS = 'books'
const STORE_FILES = 'files'
const STORE_COVERS = 'covers'
const STORE_STATES = 'states'
const STORE_STATS = 'stats'

/** 存进 `books` 的行:就是 `LibraryBook`,只是 `progress` 不落库(它由 states join 出来)。 */
export type StoredBook = Omit<LibraryBook, 'progress'>

/** 存进 `files` 的行:书籍原始字节 + 原始文件名(重建 `LibraryBook.fileName` 用)。 */
export interface StoredFile {
  readonly hash: string
  readonly fileName: string
  readonly blob: Blob
}

/** 存进 `states` 的行:`ReaderStatePayload` + 它的归属 key。 */
export interface StoredState extends ReaderStatePayload {
  readonly hash: string
}

/** 存进 `stats` 的行:一本书在某一天的阅读秒数。key 是 `${day}|${hash}`。 */
export interface StoredStat {
  readonly key: string
  readonly day: string
  readonly hash: string
  readonly seconds: number
}

/**
 * 写入超出浏览器配额。上层据此提示「删几本或换桌面版」,而不是假装成功。
 */
export class StorageQuotaError extends Error {
  constructor(message = '浏览器存储空间不足') {
    super(message)
    this.name = 'StorageQuotaError'
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  // jsdom(测试环境)没有 IndexedDB。不先查的话 `indexedDB.open` 抛的是裸
  // ReferenceError,而且发生在 Promise executor 里 —— 排查时只会看到一个
  // 没有上下文的 rejection。显式拒绝,说明是环境缺能力而不是存储坏了。
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前环境没有 IndexedDB,web 存储不可用'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      // 每个 store 一个明确的主键:books/covers/states 以书的 hash 为键,
      // stats 以「天 + 书」为键(同一本书同一天只累加一行)。
      if (!database.objectStoreNames.contains(STORE_BOOKS)) {
        database.createObjectStore(STORE_BOOKS, { keyPath: 'hash' })
      }
      if (!database.objectStoreNames.contains(STORE_FILES)) {
        database.createObjectStore(STORE_FILES, { keyPath: 'hash' })
      }
      if (!database.objectStoreNames.contains(STORE_COVERS)) {
        database.createObjectStore(STORE_COVERS, { keyPath: 'hash' })
      }
      if (!database.objectStoreNames.contains(STORE_STATES)) {
        database.createObjectStore(STORE_STATES, { keyPath: 'hash' })
      }
      if (!database.objectStoreNames.contains(STORE_STATS)) {
        database.createObjectStore(STORE_STATS, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
    request.onblocked = () => reject(new Error('本地数据库被另一个标签页占用'))
  })
}

function getDatabase(): Promise<IDBDatabase> {
  dbPromise ??= openDatabase()
  return dbPromise
}

/** 配额相关的 DOMException 名字:不同引擎给的不一样,都要认。 */
function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

function toStorageError(error: unknown): Error {
  if (isQuotaError(error)) {
    return new StorageQuotaError()
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 一次读写事务。写操作在 `complete` 后才算数(配额报错也在这时才冒出来)。 */
function run<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (objectStore: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return getDatabase().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        let request: IDBRequest<T> | null = null
        let transaction: IDBTransaction
        try {
          transaction = db.transaction(store, mode)
          request = work(transaction.objectStore(store))
        } catch (error) {
          reject(toStorageError(error))
          return
        }
        let result: T | undefined
        if (request !== null) {
          request.onsuccess = () => {
            result = request.result
          }
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () => reject(toStorageError(transaction.error))
        transaction.onabort = () => reject(toStorageError(transaction.error))
      }),
  )
}

// ---------- books ----------

export async function listStoredBooks(): Promise<readonly StoredBook[]> {
  const rows = await run<StoredBook[]>(STORE_BOOKS, 'readonly', (store) => store.getAll())
  return rows ?? []
}

export async function putStoredBook(book: StoredBook): Promise<void> {
  await run(STORE_BOOKS, 'readwrite', (store) => store.put(book))
}

export async function deleteStoredBook(hash: string): Promise<void> {
  await run(STORE_BOOKS, 'readwrite', (store) => store.delete(hash))
}

// ---------- files(书籍原始字节) ----------

/**
 * 一次事务写入「字节 + 元数据」。
 *
 * 分开写会在配额不足时留下**不可见的孤儿字节**:元数据没写进去,书架上看不到
 * 这本书,但空间已经被占了,用户怎么删都删不掉。导入必须是一个原子动作。
 */
export async function importStoredBook(
  book: StoredBook,
  fileName: string,
  blob: Blob,
): Promise<void> {
  const db = await getDatabase()
  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = db.transaction([STORE_BOOKS, STORE_FILES], 'readwrite')
      transaction.objectStore(STORE_BOOKS).put(book)
      transaction.objectStore(STORE_FILES).put({ hash: book.hash, fileName, blob })
    } catch (error) {
      reject(toStorageError(error))
      return
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(toStorageError(transaction.error))
    transaction.onabort = () => reject(toStorageError(transaction.error))
  })
}

export async function putStoredFile(hash: string, fileName: string, blob: Blob): Promise<void> {
  const row: StoredFile = { hash, fileName, blob }
  await run(STORE_FILES, 'readwrite', (store) => store.put(row))
}

export async function getStoredFile(hash: string): Promise<StoredFile | undefined> {
  return run<StoredFile>(STORE_FILES, 'readonly', (store) => store.get(hash))
}

export async function deleteStoredFile(hash: string): Promise<void> {
  await run(STORE_FILES, 'readwrite', (store) => store.delete(hash))
}

// ---------- covers ----------

export async function putStoredCover(hash: string, blob: Blob): Promise<void> {
  await run(STORE_COVERS, 'readwrite', (store) => store.put({ hash, blob }))
}

export async function getStoredCover(hash: string): Promise<Blob | undefined> {
  const row = await run<{ hash: string; blob: Blob }>(STORE_COVERS, 'readonly', (store) =>
    store.get(hash),
  )
  return row?.blob
}

export async function deleteStoredCover(hash: string): Promise<void> {
  await run(STORE_COVERS, 'readwrite', (store) => store.delete(hash))
}

// ---------- states(进度 / 批注 / 书签) ----------

export async function getStoredState(hash: string): Promise<ReaderStatePayload | undefined> {
  const row = await run<StoredState>(STORE_STATES, 'readonly', (store) => store.get(hash))
  if (row === undefined) return undefined
  const { hash: _hash, ...payload } = row
  return payload
}

export async function putStoredState(hash: string, state: ReaderStatePayload): Promise<void> {
  const row: StoredState = { hash, ...state }
  await run(STORE_STATES, 'readwrite', (store) => store.put(row))
}

export async function listStoredStates(): Promise<readonly StoredState[]> {
  const rows = await run<StoredState[]>(STORE_STATES, 'readonly', (store) => store.getAll())
  return rows ?? []
}

export async function deleteStoredState(hash: string): Promise<void> {
  await run(STORE_STATES, 'readwrite', (store) => store.delete(hash))
}

// ---------- stats(按天 × 按书) ----------

export async function addStoredStat(day: string, hash: string, seconds: number): Promise<number> {
  const key = `${day}|${hash}`
  const existing = await run<StoredStat>(STORE_STATS, 'readonly', (store) => store.get(key))
  const total = (existing?.seconds ?? 0) + seconds
  const row: StoredStat = { key, day, hash, seconds: total }
  await run(STORE_STATS, 'readwrite', (store) => store.put(row))
  return total
}

export async function listStoredStats(): Promise<readonly StoredStat[]> {
  const rows = await run<StoredStat[]>(STORE_STATS, 'readonly', (store) => store.getAll())
  return rows ?? []
}

// ---------- 整本清空 ----------

/** 移除一本书留下的全部痕迹。删书时漏掉任何一处都会留下孤儿数据。 */
export async function purgeStoredBook(hash: string): Promise<void> {
  await Promise.all([
    deleteStoredBook(hash),
    deleteStoredFile(hash),
    deleteStoredCover(hash),
    deleteStoredState(hash),
  ])
}

// ---------- 持久化 ----------

/**
 * 申请「持久化」存储。不申请的话,磁盘紧张时浏览器可以**直接清掉**用户的书 ——
 * 那是这个功能最不能接受的一种失败。返回是否获批(不获批也能用,只是不保证)。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** 已用/可用配额,用于在设置里如实告诉用户还剩多少空间。 */
export async function readStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return null
  }
}

/**
 * 核心命令在 web 端的实现。
 *
 * `lib/ipc.ts` 在非 Tauri 环境下把 `invokeCommand` 分流到这里 —— 所以**所有
 * 调用点一行都不用改**:书架、阅读器、笔记页照旧调 `library.list` /
 * `reader.state.set`,只是落到 IndexedDB 而不是 Rust 的 SQLite。
 *
 * 这里只覆盖「完整读一本书」所需的那一组命令(书架、书籍文件、封面、进度、
 * 批注、阅读统计)。AI / TTS / 离线字典 / 卡片 / 自定义字体 / 云同步 / 密钥
 * 保管仍然只有桌面版 —— 未注册的命令会照旧抛「运行时不可用」,而不是假装能用。
 */

import {
  AppError,
  COMMAND,
  ErrorCodes,
  type BookReadingStat,
  type CommandMap,
  type CommandName,
  type LibraryBook,
  type NoteEntry,
  type ReaderStatePayload,
} from '@deepread/shared'
import {
  addStoredStat,
  deleteStoredBook,
  deleteStoredCover,
  deleteStoredFile,
  deleteStoredState,
  getStoredCover,
  getStoredState,
  listStoredBooks,
  listStoredStats,
  listStoredStates,
  putStoredBook,
  putStoredCover,
  putStoredState,
  type StoredBook,
} from './web-store'

/** 与 Rust 侧 `set_tags` / `note.update` 的上限保持一致,免得两端规则漂移。 */
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32
const MAX_NOTE_LENGTH = 4000
/** 排行榜是给人看的,不是全量导出(与 Rust 的 limit 20 对齐)。 */
const MAX_TOP_BOOKS = 20
/** notes.list 的整体上限,与 Rust 侧一致。 */
const MAX_NOTES = 2000

function notFound(what: string): AppError {
  // `systemValidation`:书 / 批注不存在,本质是调用方给了一个无效的 key。
  // (Rust 侧有 STORAGE_IO,但 TS 的 ErrorCodes 目录里还没有,不为这个新增码。)
  return new AppError(ErrorCodes.systemValidation, what, { retryable: false })
}

/** 与 Rust `set_tags` 同一套规范化:trim、丢空、去重、单标签与总量上限。 */
function normalizeTags(tags: readonly string[]): readonly string[] {
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH)
    if (tag === '' || result.includes(tag)) continue
    result.push(tag)
    if (result.length >= MAX_TAGS) break
  }
  return result
}

/** 进度是 states join 出来的,不落 books —— 两处存同一个事实迟早会不一致。 */
async function withProgress(book: StoredBook): Promise<LibraryBook> {
  const state = await getStoredState(book.hash)
  return { ...book, progress: state?.progress?.fraction ?? null }
}

async function listBooks(): Promise<readonly LibraryBook[]> {
  const [books, states] = await Promise.all([listStoredBooks(), listStoredStates()])
  const fractionByHash = new Map(
    states.map((state) => [state.hash, state.progress?.fraction ?? null]),
  )
  return books
    .map((book) => ({ ...book, progress: fractionByHash.get(book.hash) ?? null }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
}

/** 封面 Blob 的 object URL 缓存:每次 get 都新建会持续泄漏。 */
const coverUrls = new Map<string, string>()

async function coverUrl(hash: string): Promise<string | null> {
  const cached = coverUrls.get(hash)
  if (cached !== undefined) return cached
  const blob = await getStoredCover(hash)
  if (blob === undefined) return null
  const url = URL.createObjectURL(blob)
  coverUrls.set(hash, url)
  return url
}

/** base64 → Blob。封面要能喂给 <img>,所以得嗅出 MIME —— 空 type 的 Blob 不渲染。 */
function base64ToImageBlob(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: sniffImageType(bytes) })
}

function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  // RIFF....WEBP
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) return 'image/webp'
  return 'image/png'
}

function toNoteEntry(
  book: StoredBook,
  annotation: {
    readonly id: string
    readonly cfi: string
    readonly color: string
    readonly note?: string
    readonly excerpt?: string
    readonly updatedAt?: string
  },
): NoteEntry {
  return {
    id: annotation.id,
    bookHash: book.hash,
    displayName: book.displayName,
    fileName: book.fileName,
    cfi: annotation.cfi,
    color: annotation.color,
    note: annotation.note ?? null,
    excerpt: annotation.excerpt ?? null,
    updatedAt: annotation.updatedAt ?? null,
  }
}

/**
 * 注册在 web 端可用的命令。**没在这里的命令就是 web 端不支持的** ——
 * 调用方会收到「运行时不可用」,而不是一个看起来能点、点了没反应的功能。
 */
export const webHandlers: {
  [K in CommandName]?: (request: CommandMap[K]['request']) => Promise<CommandMap[K]['response']>
} = {
  [COMMAND.libraryList]: async () => ({ books: await listBooks() }),

  [COMMAND.libraryRemove]: async (request) => {
    const books = await listStoredBooks()
    if (!books.some((book) => book.hash === request.bookHash)) return { removed: false }
    // 书籍字节、封面、进度、批注一起清 —— 漏掉任何一处都会留下孤儿数据,
    // 而且同 hash 重导时会被旧数据污染。
    await Promise.all([
      deleteStoredBook(request.bookHash),
      deleteStoredFile(request.bookHash),
      deleteStoredCover(request.bookHash),
      deleteStoredState(request.bookHash),
    ])
    const stale = coverUrls.get(request.bookHash)
    if (stale !== undefined) {
      URL.revokeObjectURL(stale)
      coverUrls.delete(request.bookHash)
    }
    return { removed: true }
  },

  [COMMAND.libraryInfoSet]: async (request) => {
    const books = await listStoredBooks()
    const book = books.find((item) => item.hash === request.bookHash)
    if (book === undefined) throw notFound('这本书不在书架上')
    const next: StoredBook = {
      ...book,
      displayName: request.displayName,
      author: request.author,
      subtitle: request.subtitle,
      publisher: request.publisher,
      language: request.language,
    }
    await putStoredBook(next)
    return { book: await withProgress(next) }
  },

  [COMMAND.libraryTagSet]: async (request) => {
    const books = await listStoredBooks()
    const book = books.find((item) => item.hash === request.bookHash)
    if (book === undefined) throw notFound('这本书不在书架上')
    const next: StoredBook = { ...book, tags: normalizeTags(request.tags) }
    await putStoredBook(next)
    return { book: await withProgress(next) }
  },

  [COMMAND.libraryCoverGet]: async (request) => ({
    path: await coverUrl(request.bookHash),
  }),

  [COMMAND.libraryCoverPut]: async (request) => {
    await putStoredCover(request.bookHash, base64ToImageBlob(request.data))
    const stale = coverUrls.get(request.bookHash)
    if (stale !== undefined) {
      URL.revokeObjectURL(stale)
      coverUrls.delete(request.bookHash)
    }
    return { path: (await coverUrl(request.bookHash)) ?? '' }
  },

  [COMMAND.readerStateGet]: async (request) => ({
    state: (await getStoredState(request.bookHash)) ?? null,
  }),

  [COMMAND.readerStateSet]: async (request) => {
    await putStoredState(request.bookHash, request.state)
    return { savedAt: request.state.updatedAt }
  },

  [COMMAND.readerStatsAdd]: async (request) => ({
    daySeconds: await addStoredStat(request.day, request.bookHash, request.seconds),
  }),

  [COMMAND.readerStatsGet]: async () => {
    const rows = await listStoredStats()
    const byDay = new Map<string, number>()
    for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.seconds)
    const days = [...byDay]
      .map(([day, seconds]) => ({ day, seconds }))
      .sort((a, b) => b.day.localeCompare(a.day))
    return { days, totalSeconds: days.reduce((sum, item) => sum + item.seconds, 0) }
  },

  [COMMAND.readerStatsBooks]: async () => {
    const [rows, books] = await Promise.all([listStoredStats(), listStoredBooks()])
    const byHash = new Map<string, number>()
    for (const row of rows) byHash.set(row.hash, (byHash.get(row.hash) ?? 0) + row.seconds)
    const result: BookReadingStat[] = [...byHash]
      .map(([hash, seconds]) => {
        const book = books.find((item) => item.hash === hash)
        return {
          bookHash: hash,
          displayName: book?.displayName ?? null,
          fileName: book?.fileName ?? '',
          seconds,
        }
      })
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, MAX_TOP_BOOKS)
    return { books: result }
  },

  [COMMAND.readerNotesList]: async () => {
    const [states, books] = await Promise.all([listStoredStates(), listStoredBooks()])
    const bookByHash = new Map(books.map((book) => [book.hash, book]))
    const notes: NoteEntry[] = []
    for (const state of states) {
      const book = bookByHash.get(state.hash)
      if (book === undefined) continue
      for (const annotation of state.annotations) {
        if (annotation.deleted === true) continue
        notes.push(toNoteEntry(book, annotation))
      }
    }
    // 新→旧;没有时间戳的排在最后(与 Rust 侧同一条排序)。
    notes.sort((a, b) => {
      if (a.updatedAt === null && b.updatedAt === null) return 0
      if (a.updatedAt === null) return 1
      if (b.updatedAt === null) return -1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    return { notes: notes.slice(0, MAX_NOTES) }
  },

  [COMMAND.readerNoteUpdate]: async (request) => {
    const trimmed = request.note.trim()
    if (trimmed.length > MAX_NOTE_LENGTH) throw notFound('批注太长了')
    const [states, books] = await Promise.all([listStoredStates(), listStoredBooks()])
    for (const state of states) {
      const index = state.annotations.findIndex((item) => item.id === request.noteId)
      if (index === -1) continue
      const book = books.find((item) => item.hash === state.hash)
      if (book === undefined) throw notFound('这本书不在书架上')
      const updatedAt = new Date().toISOString()
      const current = state.annotations[index]!
      const annotations = [...state.annotations]
      annotations[index] = {
        ...current,
        note: trimmed === '' ? undefined : trimmed,
        updatedAt,
      }
      const payload: ReaderStatePayload = { ...state, annotations, updatedAt }
      await putStoredState(state.hash, payload)
      return { entry: toNoteEntry(book, annotations[index]!) }
    }
    throw notFound('这条批注不存在')
  },
}

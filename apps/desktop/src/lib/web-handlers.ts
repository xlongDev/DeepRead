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
  normalizeTags,
  type BookReadingStat,
  type CommandMap,
  type CommandName,
  type LearningCard,
  type LibraryBook,
  type NoteEntry,
  type ReaderStatePayload,
  type ReadingFont,
} from '@deepread/shared'
import { base64ToImageBlob } from './blob'
import {
  addStoredStat,
  deleteStoredBook,
  deleteStoredCard,
  deleteStoredCover,
  deleteStoredFile,
  deleteStoredFont,
  deleteStoredState,
  getStoredCover,
  getStoredState,
  listStoredBooks,
  listStoredCards,
  listStoredFonts,
  listStoredStats,
  listStoredStates,
  NEW_CARD_DEFAULTS,
  putStoredBook,
  putStoredCards,
  putStoredCover,
  putStoredState,
  type StoredBook,
  type StoredFont,
} from './web-store'

/** 与 Rust 侧 `note.update` 的上限保持一致,免得两端规则漂移。 */
const MAX_NOTE_LENGTH = 4000
/** 排行榜是给人看的,不是全量导出(与 Rust 的 limit 20 对齐)。 */
const MAX_TOP_BOOKS = 20
/** notes.list 的整体上限,与 Rust 侧一致。 */
const MAX_NOTES = 2000
/** cards.add 的单次上限,与 Rust `MAX_CARDS_PER_ADD` 一致。 */
const MAX_CARDS_PER_ADD = 200
/** 与 Rust `CARD_SOURCES` 一致。 */
const CARD_SOURCES: readonly string[] = ['highlight', 'quiz', 'mistake']

function notFound(what: string): AppError {
  // `systemValidation`:书 / 批注不存在,本质是调用方给了一个无效的 key ——
  // 就算目录里现在有 STORAGE_IO,这也仍然是校验错误,不是存储 IO。
  return new AppError(ErrorCodes.systemValidation, what, { retryable: false })
}

/** 进度是 states join 出来的,不落 books —— 两处存同一个事实迟早会不一致。 */
async function withProgress(book: StoredBook): Promise<LibraryBook> {
  const state = await getStoredState(book.hash)
  return { ...book, progress: state?.progress?.fraction ?? null }
}

async function listBooks(): Promise<LibraryBook[]> {
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

/**
 * 字体字节的 object URL 缓存。`fonts.list` 每次都新建的话,每刷一次书架/面板
 * 就漏一个,而且 @font-face 会反复重新解码同一个字体。
 */
const fontUrls = new Map<string, string>()

/** 存的是 Blob,`ReadingFont.path` 要的是能直接喂给 @font-face 的 URL。 */
function fontRowToReadingFont(font: StoredFont): ReadingFont {
  const cached = fontUrls.get(font.id)
  const url =
    cached ??
    (() => {
      const created = URL.createObjectURL(font.blob)
      fontUrls.set(font.id, created)
      return created
    })()
  return { id: font.id, name: font.name, fileName: font.fileName, path: url }
}

function toNoteEntry(
  book: StoredBook,
  annotation: {
    readonly id: string
    readonly cfi: string
    readonly color: string
    readonly note?: string | null
    readonly excerpt?: string | null
    readonly updatedAt?: string | null
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
    const next: StoredBook = { ...book, tags: [...normalizeTags(request.tags)] }
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

  // 与 Rust 侧 reader.state.getAll 同一契约:只含有状态的书占键。
  [COMMAND.readerStateGetAll]: async () => {
    const rows = await listStoredStates()
    const states: Record<string, ReaderStatePayload> = {}
    for (const row of rows) states[row.hash] = row
    return { states }
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

  // ---------- 阅读字体 ----------
  // `fonts.import` 不在这里:它的参数是文件路径,浏览器里没有路径 —— 那边走
  // file input 拿到 File 后直接写库(和导入书籍同一个道理)。

  [COMMAND.fontsList]: async () => (await listStoredFonts()).map(fontRowToReadingFont),

  [COMMAND.fontsRemove]: async (request) => {
    const fonts = await listStoredFonts()
    if (!fonts.some((font) => font.id === request.id)) return false
    await deleteStoredFont(request.id)
    const stale = fontUrls.get(request.id)
    if (stale !== undefined) {
      URL.revokeObjectURL(stale)
      fontUrls.delete(request.id)
    }
    return true
  },

  // ---------- 学习卡片 ----------
  // 调度算法在 `@deepread/shared/srs`,后端只是个存储 —— web 端同样只存行、
  // 按前端算好的字段落盘。默认值与 Rust 建表的 DEFAULT 一致(ease 2.5)。

  [COMMAND.cardsList]: async (request) => {
    const all = await listStoredCards()
    const rows =
      request.bookHash === undefined
        ? all
        : all.filter((card) => card.bookHash === request.bookHash)
    // 与 Rust 的 ORDER BY due_at 一致。
    return { cards: [...rows].sort((a, b) => a.dueAt.localeCompare(b.dueAt)) }
  },

  [COMMAND.cardsAdd]: async (request) => {
    if (request.cards.length > MAX_CARDS_PER_ADD) {
      throw new AppError(ErrorCodes.systemValidation, '一次添加的卡片过多', { retryable: false })
    }
    const existing = await listStoredCards()
    const known = new Set(existing.map((card) => card.id))
    const now = new Date().toISOString()
    const rows: LearningCard[] = []
    for (const card of request.cards) {
      // Rust 侧是 INSERT OR IGNORE:从同一批批注重生成卡片**不重置复习进度**。
      if (known.has(card.id)) continue
      if (!CARD_SOURCES.includes(card.source)) {
        throw new AppError(ErrorCodes.systemValidation, '未知的卡片来源', { retryable: false })
      }
      rows.push({
        id: card.id,
        bookHash: request.bookHash,
        front: card.front,
        back: card.back,
        source: card.source,
        ...(card.cfi === undefined ? {} : { cfi: card.cfi }),
        ...NEW_CARD_DEFAULTS,
        dueAt: card.dueAt,
        createdAt: now,
      })
      known.add(card.id)
    }
    await putStoredCards(rows)
    return { added: rows.length, savedAt: now }
  },

  [COMMAND.cardsRemove]: async (request) => {
    const existing = await listStoredCards()
    if (!existing.some((card) => card.id === request.id)) return { removed: false }
    await deleteStoredCard(request.id)
    return { removed: true }
  },

  [COMMAND.cardsReview]: async (request) => {
    const existing = await listStoredCards()
    const card = existing.find((item) => item.id === request.id)
    if (card === undefined) throw notFound('卡片不存在')
    await putStoredCards([
      {
        ...card,
        ease: request.ease,
        intervalDays: request.intervalDays,
        reps: request.reps,
        lapses: request.lapses,
        dueAt: request.dueAt,
      },
    ])
    return { dueAt: request.dueAt }
  },

  /**
   * 浏览器里没有 Tauri 的 app handle,但底部状态栏如实告诉用户「你现在跑在
   * 浏览器里」比抛一个「运行时不可用」有用得多。
   */
  [COMMAND.appInfo]: async () => ({
    appName: 'DeepRead',
    appVersion: 'web',
    os: 'browser',
    arch: 'web',
  }),

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

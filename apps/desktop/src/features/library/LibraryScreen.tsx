import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Plus, Sparkle, X } from '@phosphor-icons/react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  dailySeries,
  toAppError,
  type AppInfo,
  type BookReadingStat,
  type NoteEntry,
} from '@deepread/shared'
import { extractCover, extractMetadata } from '@deepread/reader-adapter'
import {
  ACCEPTED_EXTENSIONS,
  DIALOG_EXTENSIONS,
  classifyFile,
  browserBookUrl,
  convertFileSrc,
  forgetBrowserBook,
  openedBookFromLibrary,
  type OpenedBook,
} from '../../lib/book-import'
import { readCachedCover, writeCachedCover } from '../../lib/cover-store'
import { downloadText } from '../../lib/download'
import {
  exportSnapshot,
  importSnapshot,
  importStoredBook,
  readStorageEstimate,
  requestPersistentStorage,
  StorageQuotaError,
} from '../../lib/web-store'
import { loadBookStats, loadReadingStats, type ReadingStats } from '../../lib/reading-stats'
import { loadNotes } from '../../lib/notes'
import { notesToMarkdown, saveNoteMarkdown } from './notes-view'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { SyncDrawer } from './SyncDrawer'
import { BookInfoDialog, type BookInfoDraft } from './BookInfoDialog'
import { LibrarySidebar, SidebarToggleIcon } from './LibrarySidebar'
import { NotesView } from './NotesView'
import { ShelfView } from './ShelfView'
import { SlidingIndicator } from '../../components/SlidingIndicator'
import { StatsView } from './StatsView'
import {
  APP_THEMES,
  BULK_CONFIRM,
  FAVORITE_TAG,
  formatBytes,
  isFinished,
  isReading,
  matchesSmartFilter,
  PROBLEM_MESSAGE,
  shelfTitle,
  SMART_FILTERS,
  SORT_DEFAULT_DIR,
  sortBooks,
  sortDirFromStorage,
  sortFromStorage,
  toggleFavoriteTag,
  viewFromStorage,
  type AppTheme,
  type LibraryView,
  type ShelfBook,
  type SmartFilter,
  type SortDir,
  type SortKey,
  type ViewMode,
} from './shelf-view'
import { AiProviderForm, useAiProviders } from '../settings/AiProviderSettings'

// Module-level: survives LibraryScreen remounts (reader roundtrips) within
// the app run. Blob URLs are per-run by nature, so no cross-restart cache.
const coverCache = new Map<string, string>()
const coverAttempted = new Set<string>()
/** 元数据已处理过的书:格式不带元数据(txt/md/fb2/cbz)、或已经解析并回写完毕。 */
const metaAttempted = new Set<string>()
const META_FORMATS: readonly string[] = ['epub', 'mobi', 'azw3', 'pdf']

/** `confirmRemove` 与 `tagFilter` 的哨兵值在 shelf-view.ts 单点定义。 */

/**
 * 视图切换包一层 View Transition:旧态与新态自动交叉淡入(网格↔列表的整排
 * 重排、书架↔笔记的整页换装都吃这个)。不支持的引擎瞬间切换,功能不变。
 */
function withViewTransition(apply: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => void
  }
  if (doc.startViewTransition === undefined) {
    apply()
    return
  }
  doc.startViewTransition(() => {
    // 不 flushSync 的话,快照拍到的还是旧 DOM,过渡就是空转。
    flushSync(apply)
  })
}

/** 设置弹窗的三个分区。顺序即左右位置,切换动画的方向由它推出来。 */
const SETTINGS_TABS = ['appearance', 'ai', 'data'] as const
type SettingsTab = (typeof SETTINGS_TABS)[number]

interface LibraryScreenProps {
  readonly onOpenBook: (book: OpenedBook) => void
  readonly backend: AppInfo | null
}

export function LibraryScreen({ onOpenBook, backend }: LibraryScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  /** 浏览器端「从备份恢复」的文件选择器。用持久 input 而不是临时 create +
   * click():那样用户一取消,等待 change 的 Promise 就永远悬着。 */
  const restoreInputRef = useRef<HTMLInputElement>(null)
  /** `?demoShelf` 种下的示例书架;挡住 loadBooks,免得它被真实书架覆盖。 */
  const demoSeeded = useRef(false)
  const [books, setBooks] = useState<readonly ShelfBook[]>([])
  /**
   * 书架是否已从存储读完。web 端过去是「内存里就有,立即就绪」;现在字节和
   * 元数据都落在 IndexedDB,两个平台都要等一次异步读,骨架屏也因此统一了。
   */
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  // Dev-only demo shelf (?demoShelf) so the grid and real cover extraction are
  // verifiable in a browser without Tauri; production never sees it.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(window.location.search).has('demoShelf')) return
    if (isTauriRuntime()) return
    setLibraryLoaded(true)
    const demo: readonly ShelfBook[] = [
      {
        hash: 'demo1',
        fileName: '化雪的季节.txt',
        displayName: null,
        author: '迟子建',
        subtitle: null,
        publisher: null,
        language: null,
        format: 'txt',
        path: '/fixtures/化雪的季节.txt',
        size: 382,
        addedAt: '2026-09-13T03:00:00Z',
        progress: 0.42,
        tags: ['文学'],
      },
      {
        hash: 'demo2',
        fileName: '夜航书.epub',
        displayName: null,
        author: '圣埃克苏佩里',
        subtitle: null,
        publisher: null,
        language: null,
        format: 'epub',
        path: '/fixtures/夜航书.epub',
        size: 2391,
        addedAt: '2026-09-13T02:00:00Z',
        progress: 0.08,
        tags: [],
      },
      {
        hash: 'demo3',
        fileName: '山中手记.fb2',
        displayName: null,
        author: '汪曾祺',
        subtitle: null,
        publisher: null,
        language: null,
        format: 'fb2',
        path: '/fixtures/山中手记.fb2',
        size: 619,
        addedAt: '2026-09-12T10:00:00Z',
        progress: null,
        tags: [],
      },
      {
        hash: 'demo4',
        fileName: '阅读笔记.md',
        displayName: null,
        author: null,
        subtitle: null,
        publisher: null,
        language: null,
        format: 'md',
        path: '/fixtures/阅读笔记.md',
        size: 300,
        addedAt: '2026-09-12T09:00:00Z',
        progress: null,
        tags: [],
      },
      {
        hash: 'demo5',
        fileName: '图解大模型生成式AI原理与实战 (z-library.sk, 1lib.sk, z-lib.sk).pdf',
        displayName: '图解大模型生成式AI原理与实战',
        author: '李智勇',
        subtitle: null,
        publisher: null,
        language: null,
        format: 'pdf',
        path: '/fixtures/demo.pdf',
        size: 11_000_000,
        addedAt: '2026-09-11T08:00:00Z',
        progress: 0.77,
        tags: ['科技'],
      },
    ]
    // 示例书架是一次性的 dev 种子,不该被紧随其后的真实书架覆盖 —— 用一个
    // ref 挡住 loadBooks,而不是往 IndexedDB 里写脏数据。
    demoSeeded.current = true
    setBooks(demo)
    setLibraryLoaded(true)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- dev-only seed, mount only
  }, [])
  const [sort, setSort] = useState<SortKey>(sortFromStorage)
  const [sortDir, setSortDir] = useState<SortDir>(() => sortDirFromStorage(SORT_DEFAULT_DIR[sort]))
  /** 书架自己的呈现方式(网格/列表);侧栏目的地是下面那个 `view`。 */
  const [shelfMode, setShelfMode] = useState<ViewMode>(viewFromStorage)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance')
  /**
   * 切分区时的行进方向。往右切(外观→AI→备份)= 新的一页从右边进来,
   * 往左切则相反 —— 方向感来自 tab 在 SETTINGS_TABS 里的相对位置。
   */
  const [settingsDir, setSettingsDir] = useState<'forward' | 'back'>('forward')
  const [syncOpen, setSyncOpen] = useState(false)
  const [covers, setCovers] = useState<ReadonlyMap<string, string>>(new Map())
  const [appTheme, setAppTheme] = useState<AppTheme>(
    () => (localStorage.getItem('deepread.app-theme') as AppTheme | null) ?? 'pure-white',
  )
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  /** Hash waiting for the second click — removing a book drops its progress and annotations. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  /** 正在编辑书籍信息的那一本;null = 弹窗关闭。 */
  const [editBook, setEditBook] = useState<ShelfBook | null>(null)
  const [infoBusy, setInfoBusy] = useState(false)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** null = 全部标签。 */
  /** 侧栏筛选:点当前已选中的标签 = 取消筛选,所以这里存的是「当前选中项」。 */
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  /** 侧栏收起状态。收起后主区拿到全部宽度,切换按钮留在窗口条上,仍然点得到。 */
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('deepread.shelf.sidebar') !== 'hidden',
  )
  useEffect(() => {
    localStorage.setItem('deepread.shelf.sidebar', sidebarOpen ? 'shown' : 'hidden')
  }, [sidebarOpen])
  /** 侧栏「我的分组」;与标签筛选叠加生效。 */
  const [smartFilter, setSmartFilter] = useState<SmartFilter>('all')
  const [tagDraft, setTagDraft] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  /** 侧栏的三个目的地:书架 / 笔记 / 统计。统计不再是一个弹窗,而是一个页面。 */
  const [view, setView] = useState<LibraryView>('shelf')

  /**
   * 视图切换走 View Transition:旧态与新态自动交叉淡入,网格↔列表的整排
   * 重排也有了个过渡。不支持的引擎(旧 WKWebView)瞬间切换,功能不变。
   */
  const changeView = (next: LibraryView): void => {
    withViewTransition(() => setView(next))
  }

  /**
   * 切设置分区:先定方向,再换页。动画落在 `.settings-body` 上 ——
   * `key={settingsTab}` 让它随分区重建,动画因此每次都重播。
   */
  const changeSettingsTab = (next: SettingsTab): void => {
    if (next === settingsTab) return
    setSettingsDir(
      SETTINGS_TABS.indexOf(next) > SETTINGS_TABS.indexOf(settingsTab) ? 'forward' : 'back',
    )
    setSettingsTab(next)
  }

  const [stats, setStats] = useState<ReadingStats | null>(null)
  /** 每本书累计读了多少(排行榜)。 */
  const [topBooks, setTopBooks] = useState<readonly BookReadingStat[]>([])
  const [notes, setNotes] = useState<readonly NoteEntry[]>([])
  const [notesLoaded, setNotesLoaded] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [update, setUpdate] = useState<Update | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  useEffect(() => {
    document.documentElement.dataset['appTheme'] = appTheme
    localStorage.setItem('deepread.app-theme', appTheme)
  }, [appTheme])

  // 设置弹窗保持 Esc 关闭;统计已经是页面,不再需要「关掉」。
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  /**
   * 申请「持久化」存储。
   *
   * 不申请的话,磁盘紧张时浏览器**可以直接清掉**用户导入的书 —— 那是这个
   * 功能最不能接受的一种失败(用户以为书在这儿,回头全没了)。不获批也能正常
   * 用,只是没有「不被自动清理」的保证。
   */
  useEffect(() => {
    if (isTauriRuntime()) return
    void requestPersistentStorage()
  }, [])

  /** 浏览器存储用量;桌面端没有这个概念(书留在用户自己的磁盘上)。 */
  const [storageUsage, setStorageUsage] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    if (isTauriRuntime()) return
    void readStorageEstimate().then(setStorageUsage)
  }, [])

  /**
   * 读书架。**两个平台走的是同一条命令** —— 桌面端落到 Rust 的 SQLite,
   * 浏览器端在 `lib/ipc.ts` 被分流到 IndexedDB。调用方不需要知道自己在哪。
   */
  const loadBooks = useCallback(async (): Promise<void> => {
    if (demoSeeded.current) return
    try {
      const response = await invokeCommand('library.list', undefined)
      setBooks(response.books)
    } catch {
      // The library still works: importing will retry the list.
    } finally {
      setLibraryLoaded(true)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await loadBooks()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [loadBooks])

  // Real cover extraction per book (kernel covers for EPUB/MOBI, PDF.js page 1
  // for PDF), cached at module level so returning to the shelf never re-extracts.
  // No cancellation: a books refresh (e.g. progress hydration) cancels this
  // effect mid-flight, and dropping the in-flight cover would leave that book
  // coverless — the next run skips it via coverAttempted.
  useEffect(() => {
    if (!libraryLoaded) return
    // Sync already-cached covers immediately: remounts render without flicker.
    const cachedNow = new Map<string, string>()
    for (const book of books) {
      const cached = coverCache.get(book.hash)
      if (cached) cachedNow.set(book.hash, cached)
    }
    if (cachedNow.size > 0) setCovers((current) => new Map([...current, ...cachedNow]))

    void (async () => {
      for (const book of books) {
        if (book.format === 'unknown') continue
        // 浏览器模式从 IndexedDB 里的字节生成 object URL('' = 字节已不在库里)。
        const bookUrl = isTauriRuntime()
          ? convertFileSrc(book.path)
          : await browserBookUrl(book.hash)
        if (!isTauriRuntime() && bookUrl === '') continue

        // 元数据每本只解析一次,解析完就回写 —— 书架才不会永远顶着下载站的
        // 文件名与空作者。判据是「还有字段空着」而不是「标题为空」:用户手改过
        // 标题的书,作者/出版社同样该被补上。
        const needsMeta =
          book.displayName === null ||
          book.author === null ||
          book.publisher === null ||
          book.language === null
        if (needsMeta && !metaAttempted.has(book.hash)) {
          if (!META_FORMATS.includes(book.format)) {
            metaAttempted.add(book.hash)
          } else {
            metaAttempted.add(book.hash)
            const meta = await extractMetadata(
              bookUrl,
              book.format as Parameters<typeof extractMetadata>[1],
            )
            const patch = {
              // 只填它还空着的字段:用户手填过的值不该被书里的元数据盖掉。
              displayName: book.displayName ?? meta.title,
              author: book.author ?? meta.author,
              publisher: book.publisher ?? meta.publisher,
              language: book.language ?? meta.language,
            }
            if (
              patch.displayName === book.displayName &&
              patch.author === book.author &&
              patch.publisher === book.publisher &&
              patch.language === book.language
            ) {
              // 书里什么都没有:下次进书架再试一遍(可能是文件当时不可读)。
              metaAttempted.delete(book.hash)
            } else if (isTauriRuntime()) {
              try {
                const response = await invokeCommand('library.info.set', {
                  bookHash: book.hash,
                  subtitle: book.subtitle,
                  ...patch,
                })
                setBooks((current) =>
                  current.map((item) => (item.hash === book.hash ? response.book : item)),
                )
              } catch {
                metaAttempted.delete(book.hash)
              }
            } else {
              setBooks((current) =>
                current.map((item) => (item.hash === book.hash ? { ...item, ...patch } : item)),
              )
            }
          }
        }

        if (coverAttempted.has(book.hash)) continue
        if (coverCache.has(book.hash)) {
          setCovers((current) => new Map(current).set(book.hash, coverCache.get(book.hash)!))
          continue
        }
        coverAttempted.add(book.hash)
        // Already extracted in an earlier run? Then this is just a file read.
        const cached = await readCachedCover(book.hash).catch(() => null)
        const cover =
          cached ?? (await extractCover(bookUrl, book.format as Parameters<typeof extractCover>[1]))
        if (cover) {
          coverCache.set(book.hash, cover)
          setCovers((current) => new Map(current).set(book.hash, cover))
          if (cached === null) void writeCachedCover(book.hash, cover).catch(() => {})
        } else {
          // Null is also what a transient failure returns; un-mark so the next
          // shelf rebuild retries instead of caching the failure for the run.
          coverAttempted.delete(book.hash)
        }
      }
    })()
  }, [books, libraryLoaded])

  const importPaths = useCallback(async (paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      try {
        const response = await invokeCommand('library.import', { path })
        setBooks((current) => [
          response.book,
          ...current.filter((b) => b.hash !== response.book.hash),
        ])
        setProblem(null)
      } catch (error) {
        setProblem(toAppError(error).message ?? null)
      }
    }
  }, [])

  const importFromDialog = useCallback(async (): Promise<void> => {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [{ name: '电子书', extensions: DIALOG_EXTENSIONS }],
    })
    if (!picked) return
    const paths = Array.isArray(picked) ? picked : [picked]
    await importPaths(paths)
  }, [importPaths])

  // In Tauri the webview intercepts file drops anywhere and reports absolute
  // paths — the browser file input below keeps working for dev mode only.
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') setDragging(true)
        else if (payload.type === 'leave') setDragging(false)
        else if (payload.type === 'drop') {
          setDragging(false)
          void importPaths(payload.paths)
        }
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [importPaths])

  /**
   * 浏览器端的导入。
   *
   * **这是唯一不走 `invokeCommand` 的路径**,原因很实在:`library.import` 的
   * 参数是文件路径,而浏览器里根本没有路径 —— `File` 对象只在这次会话里活着。
   * 所以这里必须自己把字节写进 IndexedDB,否则刷新之后书架还在、点开却读不了。
   */
  const importFromBrowserFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    const { sha256Hex } = await import('../../lib/book-import')
    const imported: ShelfBook[] = []
    for (const file of files) {
      const classified = classifyFile(file)
      if ('kind' in classified) {
        setProblem(PROBLEM_MESSAGE[classified.kind])
        continue
      }
      setProblem(null)
      const hash = await sha256Hex(file)
      const book: ShelfBook = {
        hash,
        fileName: file.name,
        displayName: null,
        author: null,
        subtitle: null,
        publisher: null,
        language: null,
        format: classified.format,
        path: '',
        size: file.size,
        addedAt: new Date().toISOString(),
        progress: null,
        tags: [],
      }
      try {
        await importStoredBook(book, file.name, file)
      } catch (error) {
        // 配额不足时说清楚怎么办 —— 这是 web 端唯一会「存不下」的地方,
        // 静默跳过会让用户以为导入成功了。
        setProblem(
          error instanceof StorageQuotaError
            ? '浏览器存储空间不足,这本书没能导入。先删掉几本不再读的书,或者用桌面版。'
            : toAppError(error).message,
        )
        continue
      }
      imported.push(book)
    }
    if (imported.length > 0) {
      // 重导同一文件(同 hash)时替换而不是重复上榜。
      setBooks((current) => [
        ...imported,
        ...current.filter((book) => !imported.some((item) => item.hash === book.hash)),
      ])
    }
  }, [])

  /**
   * 忘掉与这本书有关的一切会话级缓存。
   *
   * 必须做:hash 是**文件内容的哈希** —— 同一个文件删掉再导入,hash 一模一样。
   * 不清的话 `coverAttempted` 会直接跳过封面解析,并把已经随删除一起消失的旧图
   * URL(asset 路径)当成缓存贴上去 → 空白封面;`metaAttempted` 同样会让元数据
   * 不再重新解析。
   */
  const forgetBook = useCallback((hash: string): void => {
    const stale = coverCache.get(hash)
    // blob: 是我们自己 create 的,得自己 revoke;asset 路径不能 revoke。
    if (stale?.startsWith('blob:')) URL.revokeObjectURL(stale)
    coverCache.delete(hash)
    coverAttempted.delete(hash)
    metaAttempted.delete(hash)
    // 浏览器端还有一份书籍字节的 object URL(同样是自己 create 的)。
    forgetBrowserBook(hash)
    setCovers((current) => {
      if (!current.has(hash)) return current
      const next = new Map(current)
      next.delete(hash)
      return next
    })
  }, [])

  const removeFromLibrary = useCallback(
    async (hash: string): Promise<void> => {
      forgetBook(hash)
      try {
        // 两个平台同一条命令:桌面端删 SQLite 行,浏览器端删 IndexedDB 里的
        // 字节 / 封面 / 进度 / 批注(见 web-handlers 的 library.remove)。
        await invokeCommand('library.remove', { bookHash: hash })
        setBooks((current) => current.filter((book) => book.hash !== hash))
      } catch (error) {
        setProblem(toAppError(error).message || null)
      }
    },
    [forgetBook],
  )

  /**
   * 备份。
   *
   * 桌面端:Rust 把 SQLite 拷一份到用户选的路径。
   * 浏览器端:把整个 IndexedDB(含书籍字节)序列化成 JSON 下载。**这条分支是
   * 必须的** —— 浏览器里的数据本来就可能被清掉,而 `save()`(Tauri 的保存对话
   * 框)在那边根本不存在,直接调会炸。
   */
  const runBackup = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      setBackupBusy(true)
      try {
        const { text, bytes, checksum } = await exportSnapshot()
        downloadText(
          `deepread-backup-${new Date().toISOString().slice(0, 10)}.json`,
          text,
          'application/json',
        )
        setBackupMsg(
          `已备份 ${formatBytes(bytes)} · 校验和 ${checksum.slice(0, 12)}…(校验和已写进备份文件)`,
        )
      } catch (backupError) {
        setBackupMsg(toAppError(backupError).message)
      } finally {
        setBackupBusy(false)
      }
      return
    }
    const path = await save({
      defaultPath: `deepread-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite 备份', extensions: ['db'] }],
    })
    if (!path) return
    setBackupBusy(true)
    try {
      const response = await invokeCommand('storage.backup', { path })
      setBackupMsg(
        `已备份 ${formatBytes(response.bytes)} · 校验和 ${response.checksum.slice(0, 12)}…`,
      )
    } catch (backupError) {
      setBackupMsg(toAppError(backupError).message)
    } finally {
      setBackupBusy(false)
    }
  }, [])

  const IGNORED_VERSION_KEY = 'deepread.update.ignored'

  const checkForUpdates = useCallback(async (): Promise<void> => {
    setUpdateBusy(true)
    setUpdateMsg(null)
    try {
      const ignored = localStorage.getItem(IGNORED_VERSION_KEY)
      const found = await check()
      if (found === null) {
        setUpdate(null)
        setUpdateMsg('当前已是最新版本。')
      } else if (found.version === ignored) {
        setUpdate(null)
        setUpdateMsg(`已忽略版本 ${ignored},同一版本不再提示。`)
      } else {
        setUpdate(found)
        setUpdateMsg(`发现新版本 ${found.version}。`)
      }
    } catch (checkError) {
      // Honest failure (spec §132): no update source configured or offline.
      setUpdateMsg(toAppError(checkError).message)
    } finally {
      setUpdateBusy(false)
    }
  }, [])

  const installUpdate = useCallback(async (): Promise<void> => {
    const found = update
    if (!found) return
    setUpdateBusy(true)
    setUpdateMsg('正在下载并安装,完成后将自动重启…')
    try {
      await found.downloadAndInstall()
      await relaunch()
    } catch (installError) {
      setUpdateMsg(toAppError(installError).message)
      setUpdateBusy(false)
    }
  }, [update])

  const ignoreUpdate = useCallback((): void => {
    if (update) localStorage.setItem(IGNORED_VERSION_KEY, update.version)
    setUpdate(null)
    setUpdateMsg(`已忽略版本 ${update?.version}。`)
  }, [update])

  /**
   * 恢复一份 web 端备份。
   *
   * 桌面端要旁路读一个 `.sha256` 文件;浏览器端没这回事 —— 校验和就写在备份
   * 文件里(`exportSnapshot` 放进去的),`importSnapshot` 会先对上再动库。
   */
  const restoreBackupFile = useCallback(async (file: File, reload: () => void): Promise<void> => {
    setBackupBusy(true)
    try {
      await importSnapshot(await file.text())
      setBackupMsg('恢复完成:书架、进度与批注已还原。')
      reload()
    } catch (restoreError) {
      setBackupMsg(toAppError(restoreError).message)
    } finally {
      setBackupBusy(false)
    }
  }, [])

  const runRestore = useCallback(async (reload: () => void): Promise<void> => {
    // 浏览器端没有 `open()` 对话框,走隐藏的 file input(见下方 .library-file-input)。
    if (!isTauriRuntime()) {
      restoreInputRef.current?.click()
      return
    }
    const backupPath = await open({
      multiple: false,
      directory: false,
      // .db 是本机 SQLite 快照,.json 是浏览器端导出的那份 —— 后者能被收下,
      // 于是"在浏览器里读的书"可以接着在桌面版读。
      filters: [{ name: '备份文件', extensions: ['db', 'json'] }],
    })
    if (!backupPath || typeof backupPath !== 'string') return
    // JSON 备份没有旁路的 .sha256 文件:它的校验和是内联在文件里的,而 Rust
    // 那边靠 serde 的严格解析兜底(见 import_json_snapshot 的说明)。
    const isBrowserBackup = backupPath.toLowerCase().endsWith('.json')
    let checksum = ''
    if (!isBrowserBackup) {
      const checksumPath = `${backupPath}.sha256`
      try {
        const response = await fetch(convertFileSrc(checksumPath))
        if (response.ok) checksum = (await response.text()).trim()
      } catch {
        // checksum file optional; Rust validates integrity regardless
      }
      if (!checksum) {
        setBackupMsg('未找到校验和文件(.sha256),无法确认备份完整性。')
        return
      }
    }
    setBackupBusy(true)
    try {
      await invokeCommand('storage.restore', { path: backupPath, checksum })
      setBackupMsg('恢复完成:书架、进度与批注已还原。')
      reload()
    } catch (restoreError) {
      setBackupMsg(toAppError(restoreError).message)
    } finally {
      setBackupBusy(false)
    }
  }, [])

  const triggerImport = useCallback((): void => {
    if (isTauriRuntime()) void importFromDialog()
    else inputRef.current?.click()
  }, [importFromDialog])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? books.filter(
          (book) =>
            book.fileName.toLowerCase().includes(q) || shelfTitle(book).toLowerCase().includes(q),
        )
      : books
    return sortBooks(base, sort, sortDir)
  }, [books, query, sort, sortDir])

  // Two-step: one stray click used to drop a book plus its progress forever.
  // 待确认状态留在外壳(它和整批移出共用同一个哨兵),ShelfView 只管渲染按钮。
  const handleRemoveClick = (hash: string): void => {
    if (confirmRemove === hash) {
      setConfirmRemove(null)
      void removeFromLibrary(hash)
    } else {
      setConfirmRemove(hash)
    }
  }

  /**
   * 卡片悬浮的「导出批注」:只导这一本。
   * 桌面端弹系统保存对话框(Rust 写盘),浏览器预览落成 .md 下载 ——
   * WebView 会拦截 `<a download>`,所以不能只靠 Blob。
   */
  const exportBookNotes = async (book: ShelfBook): Promise<void> => {
    const bookNotes = notes.filter((entry) => entry.bookHash === book.hash)
    try {
      await saveNoteMarkdown(
        shelfTitle(book),
        notesToMarkdown([{ bookHash: book.hash, title: shelfTitle(book), notes: bookNotes }]),
      )
    } catch (cause) {
      setProblem(toAppError(cause).message || '导出批注失败')
    }
  }

  /**
   * 笔记页改批注文字。原地替换、不重排 —— 列表按「新→旧」排,编辑过的条目
   * 严格说该浮到最上,但那样卡片会在用户眼皮底下跳走;下次进笔记页自然归位。
   */
  const saveNoteEdit = async (entry: NoteEntry, text: string): Promise<void> => {
    const normalize = (value: string): string | null => {
      const trimmed = value.trim()
      return trimmed === '' ? null : trimmed
    }
    if (!isTauriRuntime()) {
      const updated: NoteEntry = {
        ...entry,
        note: normalize(text),
        updatedAt: new Date().toISOString(),
      }
      setNotes((current) => current.map((item) => (item.id === entry.id ? updated : item)))
      return
    }
    try {
      const response = await invokeCommand('reader.note.update', {
        noteId: entry.id,
        note: text,
      })
      setNotes((current) => current.map((item) => (item.id === entry.id ? response.entry : item)))
    } catch (error) {
      setProblem(toAppError(error).message)
    }
  }

  // 统计页每次进入现取:数字必须是最新的,不值得缓存。
  useEffect(() => {
    if (view !== 'stats') return
    let cancelled = false
    void Promise.all([loadReadingStats(), loadBookStats()])
      .then(([loaded, perBook]) => {
        if (cancelled) return
        setStats(loaded)
        setTopBooks(perBook)
      })
      .catch(() => {
        if (cancelled) return
        setStats({ days: [], totalSeconds: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [view])

  // 挂载时也取一次批注:书架卡片的「导出批注」图标与侧栏的笔记计数都靠它,
  // 不能等到进笔记页才有数(笔记页进入时下面的 effect 会再刷新一遍)。
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void loadNotes()
      .then((loaded) => {
        if (cancelled) return
        setNotes(loaded)
        setNotesLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setNotesLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 笔记页每次进入现取:刚划完一条高亮就切过来也该看得见,不值得缓存。
  useEffect(() => {
    if (view !== 'notes') return
    let cancelled = false
    setNotesLoaded(false)
    setNotesError(null)
    void loadNotes()
      .then((loaded) => {
        if (cancelled) return
        setNotes(loaded)
        setNotesLoaded(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setNotesError(toAppError(error).message)
        setNotesLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [view])

  /** 已读完:与侧栏「我的分组」同一个判定,不另立标准。 */
  const finishedCount = books.filter(isFinished).length
  const statsSeries = dailySeries(stats?.days ?? [], 7)
  // 柱高按当日峰值归一;全零时给个地板值,免得除零。
  const statsPeak = Math.max(60, ...statsSeries.map((entry) => entry.seconds))

  const allTags = useMemo(
    () => [...new Set(books.flatMap((book) => book.tags))].sort((a, b) => a.localeCompare(b, 'zh')),
    [books],
  )
  /** 我的分组的计数:按进度与标签现算,不需要用户维护任何东西。 */
  const smartCounts = useMemo<Record<SmartFilter, number>>(() => {
    const counts: Record<SmartFilter, number> = { all: 0, reading: 0, favorite: 0, finished: 0 }
    for (const book of books) {
      for (const filter of SMART_FILTERS) {
        if (matchesSmartFilter(book, filter.id)) counts[filter.id] += 1
      }
    }
    return counts
  }, [books])
  /** 分组与标签可叠加:两个条件都满足才留下。 */
  const visible = useMemo(
    () =>
      filtered.filter(
        (book) =>
          matchesSmartFilter(book, smartFilter) &&
          (tagFilter === null || book.tags.includes(tagFilter)),
      ),
    [filtered, smartFilter, tagFilter],
  )
  /** 零结果时把「用户到底筛了什么」原话说回去,而不是只说没有。 */
  const emptyHint = useMemo(() => {
    if (query.trim() !== '') return query
    if (tagFilter !== null) return tagFilter
    return SMART_FILTERS.find((filter) => filter.id === smartFilter)?.label ?? ''
  }, [query, tagFilter, smartFilter])
  const selectedBooks = books.filter((book) => selected.has(book.hash))

  const toggleSelected = (hash: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
  }

  const exitSelection = (): void => {
    setSelecting(false)
    setSelected(new Set())
    setConfirmRemove(null)
  }

  /**
   * 点空白处退出批量管理。
   *
   * 监听挂在 document 上,而不是给 <main> 挂 onClick —— 那是非交互元素,既过不了
   * a11y 规则,也会把"点卡片切换选中"一起吃掉。卡片、工具条、批量条、弹窗、标签
   * 浮层都排除(标签浮层里的输入框/按钮必须留着焦点)。
   */
  useEffect(() => {
    if (!selecting) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const inside =
        '.book-card, .book-row, .shelf-bulk, .shelf-toolbar, .modal-panel, .bulk-tag-popover, .tag-popover'
      if (target.closest(inside) !== null) return
      exitSelection()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [selecting])

  /**
   * 书架偏好写 localStorage:这两个选择属于用户习惯,不该每次启动都重置。
   *
   * 网格↔列表**不走 View Transition**:VT 拍的是整棵 root 的静态快照,滑动指示条
   * 也被拍进去 —— 新旧快照各带一个指示条、交叉淡入时两个位置同时出现,就是
   * 用户看到的"多闪一下"。布局切换的过渡改由 CSS 入场动画承担(见 .book-card
   * 的 fade-up,ul 上的 `key={view}` 保证它每次都会重播)。
   */
  const changeShelfMode = (mode: ViewMode): void => {
    setShelfMode(mode)
    localStorage.setItem('deepread.shelf.view', mode)
  }

  const changeSort = (key: SortKey): void => {
    // 换排序键时方向回到该键的自然方向,否则会出现「按书名」却从 Z 开始。
    const nextDir = SORT_DEFAULT_DIR[key]
    setSort(key)
    setSortDir(nextDir)
    localStorage.setItem('deepread.shelf.sort', key)
    localStorage.setItem('deepread.shelf.sortDir', nextDir)
  }

  const changeSortDir = (dir: SortDir): void => {
    setSortDir(dir)
    localStorage.setItem('deepread.shelf.sortDir', dir)
  }

  const toggleSortDir = (): void => changeSortDir(sortDir === 'asc' ? 'desc' : 'asc')

  const toggleSelectAll = (): void => {
    setSelected(
      selected.size === visible.length ? new Set() : new Set(visible.map((book) => book.hash)),
    )
  }

  /** 标签是整组替换:两个平台都落库(桌面 SQLite / 浏览器 IndexedDB)。 */
  const saveTags = async (book: ShelfBook, tags: readonly string[]): Promise<ShelfBook> => {
    if (!isTauriRuntime()) return { ...book, tags: [...tags] }
    const response = await invokeCommand('library.tag.set', {
      bookHash: book.hash,
      tags: [...tags],
    })
    return response.book
  }

  /**
   * 把一个标签应用到所有选中的书(已有该标签的书跳过)。
   *
   * **先乐观落地再逐本落库**:连续点两个预设标签时,第二次点击必须看到第一
   * 次的结果 —— 否则后一次落库会拿着旧 tags 把前一次盖掉(测试里真实复现过)。
   * 落库失败就把那一本回滚,弹问题条。
   */
  const applyTagToSelection = async (tag: string): Promise<void> => {
    if (tag === '' || selectedBooks.length === 0) return
    const targets = selectedBooks
      .filter((book) => !book.tags.includes(tag))
      .map((book) => ({ ...book, tags: [...book.tags, tag] }))
    if (targets.length === 0) return
    setBooks((current) => current.map((book) => targets.find((t) => t.hash === book.hash) ?? book))
    setBulkBusy(true)
    try {
      for (const target of targets) {
        try {
          const saved = await saveTags(target, target.tags)
          setBooks((current) => current.map((book) => (book.hash === saved.hash ? saved : book)))
        } catch (error) {
          setProblem(toAppError(error).message)
          // 回滚这本的乐观更新,界面上不能留着一条没存进去的标签。
          setBooks((current) =>
            current.map((book) =>
              book.hash === target.hash
                ? { ...book, tags: target.tags.filter((item) => item !== tag) }
                : book,
            ),
          )
        }
      }
    } finally {
      setBulkBusy(false)
    }
  }

  const tagSelected = async (): Promise<void> => {
    const tag = tagDraft.trim()
    await applyTagToSelection(tag)
    setTagDraft('')
  }

  /**
   * 批量收藏。语义是「一起变」而不是「逐个翻转」:全部都收藏了 → 一起取消,
   * 否则一起加上。逐个翻转的话,混合选中状态下点一次会变得更乱。
   */
  const favoriteSelected = async (): Promise<void> => {
    if (selectedBooks.length === 0) return
    const drop = selectedBooks.every((book) => book.tags.includes(FAVORITE_TAG))
    setBulkBusy(true)
    try {
      const updated = new Map<string, ShelfBook>()
      for (const book of selectedBooks) {
        // 已经是我们想要的状态就别写库(少一次 IPC、少一次同步变更)。
        if (book.tags.includes(FAVORITE_TAG) === !drop) continue
        try {
          const saved = await saveTags(book, toggleFavoriteTag(book.tags))
          updated.set(saved.hash, saved)
        } catch (error) {
          setProblem(toAppError(error).message)
        }
      }
      if (updated.size > 0) {
        setBooks((current) => current.map((book) => updated.get(book.hash) ?? book))
      }
    } finally {
      setBulkBusy(false)
    }
  }

  const removeSelected = async (): Promise<void> => {
    if (confirmRemove !== BULK_CONFIRM) {
      setConfirmRemove(BULK_CONFIRM)
      return
    }
    setBulkBusy(true)
    try {
      for (const book of selectedBooks) await removeFromLibrary(book.hash)
      exitSelection()
    } finally {
      setBulkBusy(false)
    }
  }

  /** 收藏 = 一个标签。零协议改动,侧栏与工具栏的标签筛选自动带上它。 */
  const toggleFavorite = (book: ShelfBook): void => {
    void (async () => {
      try {
        const saved = await saveTags(book, toggleFavoriteTag(book.tags))
        setBooks((current) => current.map((item) => (item.hash === saved.hash ? saved : item)))
      } catch (error) {
        setProblem(toAppError(error).message)
      }
    })()
  }

  const openBookInfo = (book: ShelfBook): void => {
    setConfirmRemove(null)
    setInfoError(null)
    setEditBook(book)
  }

  /** 卡片上「打标签」浮层:点一下就落库,失败时把书架状态留原样。 */
  const setBookTags = async (book: ShelfBook, next: readonly string[]): Promise<void> => {
    try {
      const saved = await saveTags(book, next)
      setBooks((current) => current.map((item) => (item.hash === saved.hash ? saved : item)))
    } catch (error) {
      setProblem(toAppError(error).message)
    }
  }

  /**
   * 保存书籍信息:元数据走 `library.info.set`(一次提交整张表),标签走
   * `library.tag.set`。两条分开提交 —— 元数据失败不会连带把标签丢掉,
   * 弹窗留在原地让用户重试。
   */
  const saveBookInfo = async (draft: BookInfoDraft): Promise<void> => {
    const book = editBook
    if (book === null) return
    setInfoBusy(true)
    setInfoError(null)
    try {
      let saved = book
      const next = {
        displayName: draft.title.trim(),
        author: draft.author.trim(),
        subtitle: draft.subtitle.trim(),
        publisher: draft.publisher.trim(),
        language: draft.language.trim(),
      }
      const changed =
        (next.displayName !== '' && next.displayName !== shelfTitle(book)) ||
        next.author !== (book.author ?? '') ||
        next.subtitle !== (book.subtitle ?? '') ||
        next.publisher !== (book.publisher ?? '') ||
        next.language !== (book.language ?? '')
      if (changed) {
        // 空白统一送 null:Rust 那边也把空串存成 NULL,界面上"没填"只有一种表示。
        const payload = {
          bookHash: book.hash,
          displayName: next.displayName === '' ? null : next.displayName,
          author: next.author === '' ? null : next.author,
          subtitle: next.subtitle === '' ? null : next.subtitle,
          publisher: next.publisher === '' ? null : next.publisher,
          language: next.language === '' ? null : next.language,
        }
        if (isTauriRuntime()) {
          const response = await invokeCommand('library.info.set', payload)
          saved = response.book
        } else {
          saved = { ...saved, ...payload, displayName: payload.displayName ?? saved.displayName }
        }
      }
      if (draft.tags.join('\u0000') !== book.tags.join('\u0000')) {
        saved = await saveTags(saved, draft.tags)
      }
      setBooks((current) => current.map((item) => (item.hash === saved.hash ? saved : item)))
      setEditBook(null)
    } catch (error) {
      setInfoError(toAppError(error).message)
    } finally {
      setInfoBusy(false)
    }
  }

  const totalBytes = books.reduce((sum, book) => sum + book.size, 0)
  // 「在读」与侧栏分组同一个定义:翻开过但没读完;读完的归「已读完」。
  const reading = books.filter(isReading).length

  /**
   * 打开书架上的书。桌面端走 asset 协议直接读原文件;浏览器端先从 IndexedDB
   * 取出字节、生成 object URL —— 那边没有路径可读,这是唯一的路。
   */
  const openBook = (book: ShelfBook): void => {
    void (async () => {
      const url = isTauriRuntime() ? undefined : await browserBookUrl(book.hash)
      onOpenBook(openedBookFromLibrary(book, url))
    })()
  }

  /**
   * 从笔记页打开一本书:带 CFI 就落到那条批注,不带就回上次读到的位置。
   * 书可能已经被移出书架(批注随之删除,但这一屏还是旧的),所以要如实说
   * 清楚,而不是打开一本不存在的书。
   */
  const openShelfBook = (bookHash: string, cfi?: string): void => {
    const book = books.find((item) => item.hash === bookHash)
    if (book === undefined) {
      setProblem('这本书已经不在书架里了,这条笔记暂时打不开。')
      return
    }
    setProblem(null)
    void (async () => {
      const url = isTauriRuntime() ? undefined : await browserBookUrl(book.hash)
      onOpenBook(openedBookFromLibrary(book, url, cfi))
    })()
  }

  const {
    providers: aiProviders,
    loaded: aiLoaded,
    activeId: aiActiveId,
    configForm: aiConfigForm,
    setConfigForm: setAiConfigForm,
    saveProvider: saveAiProvider,
    removeProvider: removeAiProvider,
    error: aiProviderError,
  } = useAiProviders()

  return (
    <div
      className={`library${dragging ? ' is-dragging' : ''}${sidebarOpen ? '' : ' is-sidebar-hidden'}${isTauriRuntime() ? '' : ' is-web'}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void importFromBrowserFiles(Array.from(event.dataTransfer.files))
      }}
    >
      {/* 没有系统标题栏:这一条盖住窗口顶部,是唯一的拖拽把手 —— 侧栏收起时它还在。 */}
      <div className="window-drag" data-tauri-drag-region />

      {/* 开关钉在交通灯右侧(Codex 式),桌面专用;web 端没有交通灯,
          开关住进品牌行右侧(LibrarySidebar),收起后这里浮一个在左上角。 */}
      {(isTauriRuntime() || !sidebarOpen) && (
        <button
          type="button"
          className={`sidebar-toggle${isTauriRuntime() ? '' : ' is-web-float'}`}
          onClick={() => setSidebarOpen((isOpen) => !isOpen)}
          aria-label={sidebarOpen ? '隐藏侧边栏' : '显示侧边栏'}
          aria-expanded={sidebarOpen}
          title={sidebarOpen ? '隐藏侧边栏' : '显示侧边栏'}
        >
          <SidebarToggleIcon expanded={sidebarOpen} />
        </button>
      )}

      <LibrarySidebar
        view={view}
        onView={changeView}
        shelfCount={books.length}
        notesCount={notesLoaded ? notes.length : null}
        smartFilter={smartFilter}
        onSmartFilter={setSmartFilter}
        smartCounts={smartCounts}
        tags={allTags}
        activeTag={tagFilter}
        onTag={(tag) => setTagFilter(tag)}
        onOpenSync={() => setSyncOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleSidebar={() => setSidebarOpen((isOpen) => !isOpen)}
        sidebarOpen={sidebarOpen}
      />

      <main className="library-main">
        {view === 'shelf' && (
          <>
            {/* 两个平台都要等一次异步读(桌面是 SQLite、浏览器是 IndexedDB),
                所以骨架屏不再只给桌面端。 */}
            {!libraryLoaded ? (
              <div className="shelf-skeleton" aria-label="书架加载中">
                {Array.from({ length: 6 }, (_, i) => (
                  <div
                    key={i}
                    className="shelf-skeleton-card"
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                ))}
              </div>
            ) : (
              libraryLoaded &&
              books.length === 0 && (
                <>
                  {/*
                   * 空书架也保留顶部栏 —— 页面骨架不该因为"没有书"就消失,
                   * 那正是整页读起来像临时占位的原因。
                   *
                   * 但只留「标题 + 导入」:搜索、视图切换、排序、批量管理在没有
                   * 书的时侯都没有操作对象,摆一排点不动的控件比没有更糟。
                   */}
                  <div className="shelf-toolbar is-empty">
                    <h1 className="shelf-title">
                      书架 <span className="shelf-count">0</span>
                    </h1>
                    <button
                      type="button"
                      className="shelf-import"
                      onClick={triggerImport}
                      aria-label="导入书籍"
                    >
                      <Plus size={15} weight="bold" aria-hidden />
                      导入
                    </button>
                  </div>

                  <section className="library-empty" aria-labelledby="library-empty-title">
                    {/*
                     * 空书架的视觉:一排高低厚薄不齐的空书位 + 一块书架板。
                     * 刻意不用"巨大的虚线框"—— 那是上传区的语言,读起来像临时
                     * 占位页;这里的隐喻是"书架在等书",和主区其余部分的语汇一致。
                     */}
                    <div className="empty-shelf" aria-hidden>
                      <div className="empty-shelf-row">
                        <span className="empty-shelf-slot" />
                        <span className="empty-shelf-slot" />
                        <span className="empty-shelf-slot" />
                        <span className="empty-shelf-slot" />
                        <span className="empty-shelf-slot" />
                      </div>
                      <span className="empty-shelf-board" />
                    </div>

                    <h2 className="library-empty-title" id="library-empty-title">
                      还没有书
                    </h2>
                    <p className="library-empty-lead">
                      {isTauriRuntime()
                        ? '把书拖进窗口,或者从磁盘里挑一本开始。'
                        : '从磁盘里挑一本开始读。'}
                    </p>

                    <p className="library-empty-formats">
                      EPUB · MOBI · AZW3 · FB2 · CBZ · PDF · TXT · Markdown
                    </p>
                    {!isTauriRuntime() && (
                      <p className="library-empty-note">
                        书与阅读进度都保存在这台设备的浏览器里,下次打开还在。清除浏览器数据会一并清除。
                      </p>
                    )}
                  </section>
                </>
              )
            )}

            {libraryLoaded && books.length > 0 && (
              <ShelfView
                books={visible}
                total={books.length}
                covers={covers}
                query={query}
                onQuery={setQuery}
                view={shelfMode}
                onView={changeShelfMode}
                sort={sort}
                onSort={changeSort}
                sortDir={sortDir}
                onToggleSortDir={toggleSortDir}
                tags={allTags}
                selecting={selecting}
                selected={selected}
                onToggleSelecting={() => (selecting ? exitSelection() : setSelecting(true))}
                onToggleSelected={toggleSelected}
                onOpenBook={openBook}
                onToggleFavorite={toggleFavorite}
                onEditInfo={openBookInfo}
                onSetTags={(book, next) => void setBookTags(book, next)}
                onFavoriteSelected={() => void favoriteSelected()}
                onImport={triggerImport}
                confirmRemove={confirmRemove}
                onRemoveClick={handleRemoveClick}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onTagSelected={() => void tagSelected()}
                onTagPreset={(tag) => void applyTagToSelection(tag)}
                onExportNotes={exportBookNotes}
                onSelectAll={toggleSelectAll}
                onRemoveSelected={() => void removeSelected()}
                bulkBusy={bulkBusy}
                emptyHint={emptyHint}
              />
            )}
          </>
        )}

        {view === 'notes' && (
          <NotesView
            notes={notes}
            loading={!notesLoaded}
            error={notesError}
            onOpenNote={(entry) => openShelfBook(entry.bookHash, entry.cfi)}
            onOpenBook={(bookHash) => openShelfBook(bookHash)}
            onEditNote={(entry, note) => void saveNoteEdit(entry, note)}
          />
        )}

        {view === 'stats' && (
          <StatsView
            stats={stats}
            series={statsSeries}
            peak={statsPeak}
            finishedCount={finishedCount}
            topBooks={topBooks}
            onOpenBook={(bookHash) => openShelfBook(bookHash)}
          />
        )}

        {problem !== null && (
          <p className="library-error" role="alert">
            {problem}
          </p>
        )}
      </main>

      <footer className="library-footer">
        {books.length > 0 && (
          <span>
            {books.length} 本{reading > 0 ? ` · 在读 ${reading}` : ''} · 共{' '}
            {formatBytes(totalBytes)}
            {' · '}
          </span>
        )}
        {backend !== null ? (
          <span>
            {backend.appName} {backend.appVersion} · {backend.os}/{backend.arch}
          </span>
        ) : (
          <span>本地模式</span>
        )}
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card">松开导入到书架</div>
        </div>
      )}

      {syncOpen && (
        <SyncDrawer onRestored={() => void loadBooks()} onClose={() => setSyncOpen(false)} />
      )}

      {editBook !== null && (
        <BookInfoDialog
          book={editBook}
          busy={infoBusy}
          error={infoError}
          onSave={(draft) => void saveBookInfo(draft)}
          onClose={() => setEditBook(null)}
        />
      )}

      {settingsOpen && (
        <div className="modal-overlay">
          {/* 遮罩本身不可点:关闭走这个铺满背景的按钮(键盘可达),面板在上层。 */}
          <button
            type="button"
            className="modal-dismiss"
            aria-label="关闭设置"
            onClick={() => setSettingsOpen(false)}
          />
          <dialog className="modal-panel" open aria-label="设置">
            <header className="modal-head">
              <strong className="modal-title">设置</strong>
              <button
                type="button"
                className="chrome-button"
                onClick={() => setSettingsOpen(false)}
                title="关闭"
              >
                <X size={14} weight="regular" aria-hidden />
              </button>
            </header>
            <SlidingIndicator
              activeKey={settingsTab}
              className="settings-tabs"
              role="tablist"
              ariaLabel="设置分区"
              activeSelector="button.is-active"
            >
              <button
                type="button"
                className={settingsTab === 'appearance' ? 'is-active' : ''}
                onClick={() => changeSettingsTab('appearance')}
                role="tab"
                aria-selected={settingsTab === 'appearance'}
              >
                外观
              </button>
              <button
                type="button"
                className={settingsTab === 'ai' ? 'is-active' : ''}
                onClick={() => changeSettingsTab('ai')}
                role="tab"
                aria-selected={settingsTab === 'ai'}
              >
                <Sparkle size={13} weight="fill" aria-hidden /> AI 服务
              </button>
              <button
                type="button"
                className={settingsTab === 'data' ? 'is-active' : ''}
                onClick={() => changeSettingsTab('data')}
                role="tab"
                aria-selected={settingsTab === 'data'}
              >
                备份与更新
              </button>
            </SlidingIndicator>

            {/* 分区内容。`key` 让它在换页时重建,滑入动画才会重播;方向跟着
                tab 的相对位置走(往右切 = 从右边进来)。 */}
            <div key={settingsTab} className="settings-body" data-dir={settingsDir}>
              {settingsTab === 'appearance' && (
                <>
                  <section className="modal-section">
                    <p className="modal-section-label">界面主题</p>
                    <div className="theme-grid">
                      {APP_THEMES.map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          className={`theme-swatch${appTheme === theme.id ? ' is-active' : ''}`}
                          onClick={() => setAppTheme(theme.id)}
                          aria-pressed={appTheme === theme.id}
                        >
                          <span
                            className="theme-swatch-color"
                            style={{ background: theme.swatch, color: theme.ink }}
                          >
                            <span
                              className="theme-swatch-line"
                              style={{ background: theme.ink, opacity: 0.85 }}
                            />
                            <span
                              className="theme-swatch-line"
                              style={{ background: theme.ink, opacity: 0.55 }}
                            />
                            <span
                              className="theme-swatch-line"
                              style={{ background: theme.ink, opacity: 0.35 }}
                            />
                            <span
                              className="theme-swatch-dot"
                              style={{ background: theme.accent }}
                            />
                          </span>
                          {theme.label}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="modal-section">
                    <p className="modal-section-label">书架偏好(自动保存)</p>
                    <p className="ai-privacy">
                      排序与视图选择自动记忆;阅读排版(字号、行距、翻页方式)在阅读器内的 Aa
                      面板设置。
                    </p>
                  </section>
                </>
              )}

              {settingsTab === 'ai' && (
                <section className="modal-section">
                  <p className="modal-section-label">AI 服务(OpenAI 兼容)</p>
                  {/*
                   * 浏览器端不给表单。填了也存不下 —— 密钥在那边没有安全的地方
                   * 放(IndexedDB 是明文的),而且直连各家 API 会被 CORS 拦下。
                   * 与其让用户填完再撞一句「Tauri 运行时不可用」,不如一开始就
                   * 说清楚;那也是「点了没反应」和「明确说没有」的区别。
                   */}
                  {!isTauriRuntime() ? (
                    <p className="ai-privacy">
                      AI 助手与云端朗读仅在桌面版提供。浏览器里没有安全存放 API
                      密钥的地方(本地存储是明文的),直连各家服务也会被跨域策略拦下。
                    </p>
                  ) : (
                    <>
                      <AiProviderForm
                        providers={aiProviders}
                        configForm={aiConfigForm}
                        onFormChange={setAiConfigForm}
                        onSave={() => saveAiProvider()}
                        onRemove={removeAiProvider}
                        onApplyPreset={(preset) => {
                          setAiConfigForm((form) => ({
                            ...form,
                            name: preset.label,
                            baseUrl: preset.baseUrl,
                            model: preset.model,
                          }))
                        }}
                        error={aiProviderError}
                      />
                      {aiLoaded && aiProviders.length > 0 && (
                        <p className="ai-privacy">
                          配置好的服务会自动出现在阅读器 AI 助手与云端朗读里;当前生效:{' '}
                          {aiProviders.find((provider) => provider.id === aiActiveId)?.name ??
                            '未选择'}
                          。
                        </p>
                      )}
                    </>
                  )}
                </section>
              )}

              {settingsTab === 'data' && (
                <>
                  <section className="modal-section">
                    <p className="modal-section-label">备份与恢复</p>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void runBackup()}
                        disabled={backupBusy}
                      >
                        {/* 桌面端要选存到哪;浏览器端直接下载,没有"到哪"这一步。 */}
                        {backupBusy ? '备份中…' : isTauriRuntime() ? '备份到…' : '导出备份'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void runRestore(loadBooks)}
                        disabled={backupBusy}
                      >
                        {backupBusy ? '恢复中…' : '从备份恢复…'}
                      </button>
                    </div>
                    {backupMsg !== null && <p className="library-note">{backupMsg}</p>}
                    {/* 浏览器里书是自己存下来的,空间有上限 —— 在"备份"这一格
                        顺带如实告诉用户还剩多少,别等写满了才发现。 */}
                    {!isTauriRuntime() && storageUsage !== null && storageUsage.quota > 0 && (
                      <p className="library-note">
                        浏览器已用 {formatBytes(storageUsage.usage)},配额约{' '}
                        {formatBytes(storageUsage.quota)}。
                      </p>
                    )}
                  </section>
                  <section className="modal-section">
                    <p className="modal-section-label">更新</p>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void checkForUpdates()}
                        disabled={updateBusy}
                      >
                        {updateBusy ? '检查中…' : '检查更新'}
                      </button>
                      {update !== null && (
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => void installUpdate()}
                          disabled={updateBusy}
                        >
                          下载并安装
                        </button>
                      )}
                      {update !== null && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={ignoreUpdate}
                          disabled={updateBusy}
                        >
                          忽略此版本
                        </button>
                      )}
                    </div>
                    {updateMsg !== null && <p className="library-note">{updateMsg}</p>}
                  </section>
                </>
              )}
            </div>

            <footer className="modal-foot">
              <button type="button" className="btn-primary" onClick={() => setSettingsOpen(false)}>
                完成
              </button>
            </footer>
          </dialog>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS}
        className="visually-hidden"
        onChange={(event) => {
          void importFromBrowserFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <input
        ref={restoreInputRef}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void restoreBackupFile(file, loadBooks)
        }}
      />
    </div>
  )
}

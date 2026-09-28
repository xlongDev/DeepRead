import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpenText, Cloud, Gear, Sparkle, X } from '@phosphor-icons/react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  dailySeries,
  localDayKey,
  toAppError,
  type AppInfo,
  type NoteEntry,
} from '@deepread/shared'
import { extractCover, extractTitle } from '@deepread/reader-adapter'
import {
  ACCEPTED_EXTENSIONS,
  DIALOG_EXTENSIONS,
  classifyFile,
  browserBookUrl,
  convertFileSrc,
  deleteBrowserFile,
  getBrowserFile,
  openedBookFromLibrary,
  registerBrowserFile,
  type OpenedBook,
} from '../../lib/book-import'
import { readCachedCover, writeCachedCover } from '../../lib/cover-store'
import { loadReadingStats, type ReadingStats } from '../../lib/reading-stats'
import { loadNotes } from '../../lib/notes'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { SyncDrawer } from './SyncDrawer'
import { BookInfoDialog, type BookInfoDraft } from './BookInfoDialog'
import { LibrarySidebar } from './LibrarySidebar'
import { NotesView } from './NotesView'
import { ShelfView } from './ShelfView'
import { StatsView } from './StatsView'
import {
  APP_THEMES,
  BULK_CONFIRM,
  formatBytes,
  PROBLEM_MESSAGE,
  shelfTitle,
  SORT_DEFAULT_DIR,
  sortBooks,
  sortDirFromStorage,
  sortFromStorage,
  toggleFavoriteTag,
  viewFromStorage,
  type AppTheme,
  type LibraryView,
  type ShelfBook,
  type SortDir,
  type SortKey,
  type ViewMode,
} from './shelf-view'
import { AiProviderForm, useAiProviders } from '../settings/AiProviderSettings'

// Module-level: survives LibraryScreen remounts (reader roundtrips) within
// the app run. Blob URLs are per-run by nature, so no cross-restart cache.
const coverCache = new Map<string, string>()
const coverAttempted = new Set<string>()
/** Books whose title is not resolvable from metadata (txt/md/fb2/cbz) or already resolved. */
const titleAttempted = new Set<string>()
const TITLE_FORMATS: readonly string[] = ['epub', 'mobi', 'azw3', 'pdf']

/**
 * Browser mode (dev): the shelf state must survive LibraryScreen remounts
 * (reader roundtrips), so it lives next to the file registry at module level.
 * A reload still clears both — File handles cannot be persisted; that is what
 * the desktop build is for.
 */
let browserShelf: readonly ShelfBook[] = []

/** `confirmRemove` 与 `tagFilter` 的哨兵值在 shelf-view.ts 单点定义。 */

interface LibraryScreenProps {
  readonly onOpenBook: (book: OpenedBook) => void
  readonly backend: AppInfo | null
}

export function LibraryScreen({ onOpenBook, backend }: LibraryScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [books, setBooks] = useState<readonly ShelfBook[]>([])
  const [libraryLoaded, setLibraryLoaded] = useState(!isTauriRuntime())
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
        format: 'pdf',
        path: '/fixtures/demo.pdf',
        size: 11_000_000,
        addedAt: '2026-09-11T08:00:00Z',
        progress: 0.77,
        tags: ['科技'],
      },
    ]
    // 必须同时写进浏览器书架的模块缓存:否则紧随其后的 loadBooks 会拿它(空数组)
    // 覆盖掉示例书,?demoShelf 就一直是个空书架。
    browserShelf = demo
    setBooks(demo)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- dev-only seed, mount only
  }, [])
  const [sort, setSort] = useState<SortKey>(sortFromStorage)
  const [sortDir, setSortDir] = useState<SortDir>(() => sortDirFromStorage(SORT_DEFAULT_DIR[sort]))
  /** 书架自己的呈现方式(网格/列表);侧栏目的地是下面那个 `view`。 */
  const [shelfMode, setShelfMode] = useState<ViewMode>(viewFromStorage)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'appearance' | 'ai' | 'data'>('appearance')
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
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  /** 侧栏的三个目的地:书架 / 笔记 / 统计。统计不再是一个弹窗,而是一个页面。 */
  const [view, setView] = useState<LibraryView>('shelf')
  const [stats, setStats] = useState<ReadingStats | null>(null)
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

  const loadBooks = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      setLibraryLoaded(true)
      setBooks(browserShelf)
      return
    }
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
        // 浏览器模式从注册的 File 生成稳定 object URL('' 表示文件已不在会话里)。
        const bookUrl = isTauriRuntime() ? convertFileSrc(book.path) : browserBookUrl(book.hash)
        if (!isTauriRuntime() && bookUrl === '') continue

        // Resolve the real title once per book, then persist it so the shelf
        // stops showing download-site file names forever.
        if (book.displayName === null && !titleAttempted.has(book.hash)) {
          if (!TITLE_FORMATS.includes(book.format)) {
            titleAttempted.add(book.hash)
          } else {
            titleAttempted.add(book.hash)
            const title = await extractTitle(
              bookUrl,
              book.format as Parameters<typeof extractTitle>[1],
            )
            if (title === null) titleAttempted.delete(book.hash)
            else if (isTauriRuntime()) {
              try {
                const response = await invokeCommand('library.rename', {
                  bookHash: book.hash,
                  displayName: title,
                })
                setBooks((current) =>
                  current.map((item) =>
                    item.hash === book.hash
                      ? { ...item, displayName: response.book.displayName }
                      : item,
                  ),
                )
              } catch {
                titleAttempted.delete(book.hash)
              }
            } else {
              setBooks((current) =>
                current.map((item) =>
                  item.hash === book.hash ? { ...item, displayName: title } : item,
                ),
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
      registerBrowserFile(hash, file)
      imported.push({
        hash,
        fileName: file.name,
        displayName: null,
        format: classified.format,
        path: '',
        size: file.size,
        addedAt: new Date().toISOString(),
        progress: null,
        tags: [],
      })
    }
    if (imported.length > 0) {
      // 重导同一文件(同 hash)时替换而不是重复上榜。
      browserShelf = [
        ...imported,
        ...browserShelf.filter((book) => !imported.some((item) => item.hash === book.hash)),
      ]
      setBooks((current) => [
        ...imported,
        ...current.filter((book) => !imported.some((item) => item.hash === book.hash)),
      ])
    }
  }, [])

  const removeFromLibrary = useCallback(async (hash: string): Promise<void> => {
    if (!isTauriRuntime()) {
      browserShelf = browserShelf.filter((book) => book.hash !== hash)
      deleteBrowserFile(hash)
      setBooks((current) => current.filter((book) => book.hash !== hash))
      return
    }
    try {
      await invokeCommand('library.remove', { bookHash: hash })
      setBooks((current) => current.filter((b) => b.hash !== hash))
    } catch (error) {
      setProblem(toAppError(error).message ?? null)
    }
  }, [])

  const runBackup = useCallback(async (): Promise<void> => {
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

  const runRestore = useCallback(async (reload: () => void): Promise<void> => {
    const backupPath = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite 备份', extensions: ['db'] }],
    })
    if (!backupPath || typeof backupPath !== 'string') return
    const checksumPath = `${backupPath}.sha256`
    let checksum = ''
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

  // 浏览器模式下书架列表由 books 状态镜像回模块缓存(重挂载后还在)。
  useEffect(() => {
    if (!isTauriRuntime()) browserShelf = books
  }, [books])

  // 统计页每次进入现取:数字必须是最新的,不值得缓存。
  useEffect(() => {
    if (view !== 'stats') return
    let cancelled = false
    void loadReadingStats()
      .then((loaded) => {
        if (!cancelled) setStats(loaded)
      })
      .catch(() => {
        if (!cancelled) setStats({ days: [], totalSeconds: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [view])

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

  const todaySeconds = stats?.days.find((entry) => entry.day === localDayKey())?.seconds ?? 0
  const statsSeries = dailySeries(stats?.days ?? [], 7)
  // 柱高按当日峰值归一;全零时给个地板值,免得除零。
  const statsPeak = Math.max(60, ...statsSeries.map((entry) => entry.seconds))

  const allTags = useMemo(
    () => [...new Set(books.flatMap((book) => book.tags))].sort((a, b) => a.localeCompare(b, 'zh')),
    [books],
  )
  const visible = useMemo(
    () =>
      tagFilter === null ? filtered : filtered.filter((book) => book.tags.includes(tagFilter)),
    [filtered, tagFilter],
  )
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

  /** 书架偏好写 localStorage:这两个选择属于用户习惯,不该每次启动都重置。 */
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

  /** 标签是整组替换:桌面端落库,浏览器模式只改内存。 */
  const saveTags = async (book: ShelfBook, tags: readonly string[]): Promise<ShelfBook> => {
    if (!isTauriRuntime()) return { ...book, tags: [...tags] }
    const response = await invokeCommand('library.tag.set', {
      bookHash: book.hash,
      tags: [...tags],
    })
    return response.book
  }

  const tagSelected = async (): Promise<void> => {
    const tag = tagDraft.trim()
    if (tag === '' || selectedBooks.length === 0) return
    setBulkBusy(true)
    try {
      const updated = new Map<string, ShelfBook>()
      for (const book of selectedBooks) {
        if (book.tags.includes(tag)) continue
        try {
          const saved = await saveTags(book, [...book.tags, tag])
          updated.set(saved.hash, saved)
        } catch (error) {
          setProblem(toAppError(error).message)
        }
      }
      if (updated.size > 0) {
        setBooks((current) => current.map((book) => updated.get(book.hash) ?? book))
      }
      setTagDraft('')
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

  /**
   * 保存书籍信息:标题走 `library.rename`,标签走 `library.tag.set`。两条都是
   * 既有命令 —— 这一版没有新协议、没有迁移。两者分开提交:标题失败不会连带
   * 把标签一起丢掉,弹窗留在原地让用户重试。
   */
  const saveBookInfo = async (draft: BookInfoDraft): Promise<void> => {
    const book = editBook
    if (book === null) return
    setInfoBusy(true)
    setInfoError(null)
    try {
      let saved = book
      const title = draft.title.trim()
      if (title !== '' && title !== shelfTitle(book)) {
        if (isTauriRuntime()) {
          const response = await invokeCommand('library.rename', {
            bookHash: book.hash,
            displayName: title,
          })
          saved = response.book
        } else {
          saved = { ...saved, displayName: title }
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
  const reading = books.filter((book) => (book.progress ?? 0) > 0).length

  /** 浏览器模式从注册表里的 File 解析 URL;桌面端走 asset 协议。 */
  const openBook = (book: ShelfBook): void => {
    onOpenBook(
      openedBookFromLibrary(book, isTauriRuntime() ? undefined : getBrowserFile(book.hash)),
    )
  }

  /**
   * 从笔记页回到原文:把批注的 CFI 一起交给阅读器,它会直接落到那一句。
   * 书可能已经被移出书架(批注随之删除,但这一屏还是旧的),所以要如实说
   * 清楚,而不是打开一本不存在的书。
   */
  const openNote = (entry: NoteEntry): void => {
    const book = books.find((item) => item.hash === entry.bookHash)
    if (book === undefined) {
      setProblem('这本书已经不在书架里了,这条笔记暂时打不开。')
      return
    }
    setProblem(null)
    onOpenBook(
      openedBookFromLibrary(
        book,
        isTauriRuntime() ? undefined : getBrowserFile(book.hash),
        entry.cfi,
      ),
    )
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
      className={`library${dragging ? ' is-dragging' : ''}`}
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
      <header className="library-header" data-tauri-drag-region>
        <div className="library-brand-block" data-tauri-drag-region>
          <span className="library-mark" aria-hidden>
            <BookOpenText size={17} weight="fill" />
          </span>
          <span className="library-brand">Deepread</span>
          <span className="library-tagline">个人阅读操作系统</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="chrome-button"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="打开设置"
          >
            <Gear size={17} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className="chrome-button"
            onClick={() => setSyncOpen(true)}
            title="云同步(WebDAV)"
            aria-label="打开云同步"
          >
            <Cloud size={17} weight="regular" aria-hidden />
          </button>
        </div>
      </header>

      <LibrarySidebar
        view={view}
        onView={setView}
        shelfCount={books.length}
        tags={allTags}
        activeTag={tagFilter}
        onTag={(tag) => setTagFilter(tag)}
        filtered={tagFilter !== null}
      />

      <main className="library-main">
        {view === 'shelf' && (
          <>
            {isTauriRuntime() && !libraryLoaded ? (
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
                <section className="library-empty" aria-label="导入书籍">
                  <button
                    type="button"
                    className="library-drop-button"
                    onClick={triggerImport}
                    aria-label="导入书籍"
                  >
                    <BookOpenText size={44} weight="light" aria-hidden />
                    <span className="library-empty-title">
                      {isTauriRuntime() ? '把书拖进窗口,或点击导入' : '导入一本书'}
                    </span>
                    <span className="library-empty-hint">
                      EPUB、MOBI、AZW3、FB2、CBZ、PDF、TXT、Markdown
                    </span>
                  </button>
                  {!isTauriRuntime() && (
                    <p className="library-note">
                      浏览器模式:导入的书籍只在当前会话有效;下载桌面版获得书架与进度记忆。
                    </p>
                  )}
                </section>
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
                tagFilter={tagFilter}
                onTagFilter={setTagFilter}
                selecting={selecting}
                selected={selected}
                onToggleSelecting={() => (selecting ? exitSelection() : setSelecting(true))}
                onToggleSelected={toggleSelected}
                onOpenBook={openBook}
                onToggleFavorite={toggleFavorite}
                onEditInfo={openBookInfo}
                onImport={triggerImport}
                onOpenStats={() => setView('stats')}
                confirmRemove={confirmRemove}
                onRemoveClick={handleRemoveClick}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onTagSelected={() => void tagSelected()}
                onSelectAll={toggleSelectAll}
                onRemoveSelected={() => void removeSelected()}
                bulkBusy={bulkBusy}
                emptyHint={tagFilter ?? query}
              />
            )}
          </>
        )}

        {view === 'notes' && (
          <NotesView
            notes={notes}
            loading={!notesLoaded}
            error={notesError}
            onOpenNote={openNote}
          />
        )}

        {view === 'stats' && (
          <StatsView
            stats={stats}
            todaySeconds={todaySeconds}
            series={statsSeries}
            peak={statsPeak}
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
            <nav className="settings-tabs" aria-label="设置分区">
              <button
                type="button"
                className={settingsTab === 'appearance' ? 'is-active' : ''}
                onClick={() => setSettingsTab('appearance')}
              >
                外观
              </button>
              <button
                type="button"
                className={settingsTab === 'ai' ? 'is-active' : ''}
                onClick={() => setSettingsTab('ai')}
              >
                <Sparkle size={13} weight="fill" aria-hidden /> AI 服务
              </button>
              <button
                type="button"
                className={settingsTab === 'data' ? 'is-active' : ''}
                onClick={() => setSettingsTab('data')}
              >
                备份与更新
              </button>
            </nav>

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
                          <span className="theme-swatch-dot" style={{ background: theme.accent }} />
                        </span>
                        {theme.label}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="modal-section">
                  <p className="modal-section-label">书架偏好(自动保存)</p>
                  <p className="ai-privacy">
                    排序与视图选择自动记忆;阅读排版(字号、行距、翻页方式)在阅读器内的 Aa 面板设置。
                  </p>
                </section>
              </>
            )}

            {settingsTab === 'ai' && (
              <section className="modal-section">
                <p className="modal-section-label">AI 服务(OpenAI 兼容)</p>
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
                    {aiProviders.find((provider) => provider.id === aiActiveId)?.name ?? '未选择'}。
                  </p>
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
                      {backupBusy ? '备份中…' : '备份到…'}
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
    </div>
  )
}

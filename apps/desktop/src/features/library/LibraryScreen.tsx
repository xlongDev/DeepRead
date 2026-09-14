import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenText,
  Cloud,
  Gear,
  ListBullets,
  MagnifyingGlass,
  Plus,
  SquaresFour,
  X,
} from '@phosphor-icons/react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { toAppError, type AppInfo, type LibraryBook } from '@deepread/shared'
import { extractCover } from '@deepread/reader-adapter'
import {
  ACCEPTED_EXTENSIONS,
  DIALOG_EXTENSIONS,
  classifyFile,
  convertFileSrc,
  openedBookFromLibrary,
  type ImportProblem,
  type OpenedBook,
} from '../../lib/book-import'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { SyncDrawer } from './SyncDrawer'

const PROBLEM_MESSAGE: Readonly<Record<ImportProblem['kind'], string>> = {
  unsupported: '暂时不认识这个文件格式。目前支持 EPUB、MOBI、AZW3、FB2、CBZ、PDF、TXT、Markdown。',
  chm: 'CHM 暂不支持:阅读内核(foliate-js)还没有 CHM 解析器,我们如实告诉你,而不是假装能打开。',
}

/** Muted generated-cover palettes; picked deterministically by book hash. */
const COVER_PALETTES: readonly (readonly [string, string])[] = [
  ['#dfe7f5', '#b9c8e8'], // indigo mist
  ['#dcf0ea', '#aedccf'], // sage
  ['#f7ecdb', '#eed7b3'], // sand
  ['#fbe7df', '#f2c9bc'], // clay
  ['#e9e4f4', '#cfc4e6'], // lavender gray
  ['#e2eef4', '#bcd8e6'], // dusk blue
  ['#f5e0e8', '#e8becd'], // rose
  ['#e4efdd', '#c8e0b8'], // leaf
]

function coverPalette(hash: string): readonly [string, string] {
  let value = 0
  for (const char of hash) value = (value * 31 + char.charCodeAt(0)) | 0
  return COVER_PALETTES[Math.abs(value) % COVER_PALETTES.length] ?? COVER_PALETTES[0]!
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

type SortKey = 'added' | 'title' | 'size' | 'progress'
type ViewMode = 'grid' | 'list'
type AppTheme =
  'pure-white' | 'warm-paper' | 'ivory' | 'soft-gray' | 'dark' | 'oled' | 'liquid-glass'

const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  added: '最近添加',
  title: '书名',
  size: '文件大小',
  progress: '阅读进度',
}

const APP_THEMES: readonly {
  readonly id: AppTheme
  readonly label: string
  readonly swatch: string
}[] = [
  { id: 'pure-white', label: '纯白', swatch: '#f6f5f2' },
  { id: 'warm-paper', label: '暖纸', swatch: '#f3ecdd' },
  { id: 'ivory', label: '象牙', swatch: '#f8f4ea' },
  { id: 'soft-gray', label: '浅灰', swatch: '#ebebeb' },
  { id: 'dark', label: '深色', swatch: '#131210' },
  { id: 'oled', label: 'OLED 纯黑', swatch: '#000000' },
  { id: 'liquid-glass', label: '液态玻璃', swatch: '#dfe5ec' },
]

const sortFromStorage = (): SortKey => {
  const stored = localStorage.getItem('deepread.shelf.sort')
  return stored && stored in SORT_LABELS ? (stored as SortKey) : 'added'
}

const viewFromStorage = (): ViewMode => {
  const stored = localStorage.getItem('deepread.shelf.view')
  return stored === 'list' ? 'list' : 'grid'
}

// Module-level: survives LibraryScreen remounts (reader roundtrips) within
// the app run. Blob URLs are per-run by nature, so no cross-restart cache.
const coverCache = new Map<string, string>()
const coverAttempted = new Set<string>()

interface LibraryScreenProps {
  readonly onOpenBook: (book: OpenedBook) => void
  readonly backend: AppInfo | null
}

interface ShelfBook extends LibraryBook {
  readonly progress: number | null
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
    setBooks([
      {
        hash: 'demo1',
        fileName: '化雪的季节.txt',
        format: 'txt',
        path: '/fixtures/化雪的季节.txt',
        size: 382,
        addedAt: '2026-09-13T03:00:00Z',
        progress: 0.42,
      },
      {
        hash: 'demo2',
        fileName: '夜航书.epub',
        format: 'epub',
        path: '/fixtures/夜航书.epub',
        size: 2391,
        addedAt: '2026-09-13T02:00:00Z',
        progress: 0.08,
      },
      {
        hash: 'demo3',
        fileName: '山中手记.fb2',
        format: 'fb2',
        path: '/fixtures/山中手记.fb2',
        size: 619,
        addedAt: '2026-09-12T10:00:00Z',
        progress: null,
      },
      {
        hash: 'demo4',
        fileName: '阅读笔记.md',
        format: 'md',
        path: '/fixtures/阅读笔记.md',
        size: 300,
        addedAt: '2026-09-12T09:00:00Z',
        progress: null,
      },
      {
        hash: 'demo5',
        fileName: '图解大模型生成式AI原理与实战.pdf',
        format: 'pdf',
        path: '/fixtures/demo.pdf',
        size: 11_000_000,
        addedAt: '2026-09-11T08:00:00Z',
        progress: 0.77,
      },
    ])
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- dev-only seed, mount only
  }, [])
  const [sort, setSort] = useState<SortKey>(sortFromStorage)
  const [view, setView] = useState<ViewMode>(viewFromStorage)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [covers, setCovers] = useState<ReadonlyMap<string, string>>(new Map())
  const [appTheme, setAppTheme] = useState<AppTheme>(
    () => (localStorage.getItem('deepread.app-theme') as AppTheme | null) ?? 'pure-white',
  )
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [update, setUpdate] = useState<Update | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  useEffect(() => {
    document.documentElement.dataset['appTheme'] = appTheme
    localStorage.setItem('deepread.app-theme', appTheme)
  }, [appTheme])

  const loadBooks = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      setLibraryLoaded(true)
      return
    }
    try {
      const response = await invokeCommand('library.list', undefined)
      const withProgress = await Promise.all(
        response.books.map(async (book) => {
          try {
            const state = await invokeCommand('reader.state.get', { bookHash: book.hash })
            return { ...book, progress: state.state?.progress?.fraction ?? null }
          } catch {
            return { ...book, progress: null }
          }
        }),
      )
      setBooks(withProgress)
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
  useEffect(() => {
    if (!libraryLoaded) return
    // Sync already-cached covers immediately: remounts render without flicker.
    const cachedNow = new Map<string, string>()
    for (const book of books) {
      const cached = coverCache.get(book.hash)
      if (cached) cachedNow.set(book.hash, cached)
    }
    if (cachedNow.size > 0) setCovers((current) => new Map([...current, ...cachedNow]))

    let cancelled = false
    void (async () => {
      for (const book of books) {
        if (cancelled || coverAttempted.has(book.hash)) continue
        if (coverCache.has(book.hash)) {
          setCovers((current) => new Map(current).set(book.hash, coverCache.get(book.hash)!))
          continue
        }
        coverAttempted.add(book.hash)
        const bookUrl = isTauriRuntime() ? convertFileSrc(book.path) : book.path
        const cover = await extractCover(bookUrl, book.format as Parameters<typeof extractCover>[1])
        if (cancelled) return
        if (cover) {
          coverCache.set(book.hash, cover)
          setCovers((current) => new Map(current).set(book.hash, cover))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [books, libraryLoaded])

  const importPaths = useCallback(async (paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      try {
        const response = await invokeCommand('library.import', { path })
        setBooks((current) => [
          { ...response.book, progress: null },
          ...current.filter((b) => b.hash !== response.book.hash),
        ])
        setProblem(null)
      } catch (error) {
        setProblem(toAppError(error).message ?? null)
      }
    }
  }, [])

  const importFromDialog = useCallback(async (): Promise<void> => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: '电子书', extensions: DIALOG_EXTENSIONS }],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
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
      imported.push({
        hash,
        fileName: file.name,
        format: classified.format,
        path: '',
        size: file.size,
        addedAt: new Date().toISOString(),
        progress: null,
      })
    }
    if (imported.length > 0) {
      setBooks((current) => [...imported, ...current])
    }
  }, [])

  const removeFromLibrary = useCallback(async (hash: string): Promise<void> => {
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
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite 备份', extensions: ['db'] }],
    })
    if (!selected || typeof selected !== 'string') return
    const checksumPath = `${selected}.sha256`
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
      await invokeCommand('storage.restore', { path: selected, checksum })
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
    const base = q ? books.filter((book) => book.fileName.toLowerCase().includes(q)) : books
    const sorted = [...base]
    switch (sort) {
      case 'title':
        sorted.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh'))
        break
      case 'size':
        sorted.sort((a, b) => b.size - a.size)
        break
      case 'progress':
        sorted.sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1))
        break
      case 'added':
      default:
        sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
        break
    }
    return sorted
  }, [books, query, sort])

  const totalBytes = books.reduce((sum, book) => sum + book.size, 0)
  const reading = books.filter((book) => (book.progress ?? 0) > 0).length
  const openFileInput = (): void => inputRef.current?.click()

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
      <header className="library-header">
        <span className="library-brand">Deepread</span>
        <span className="library-tagline">个人阅读操作系统</span>
        <button
          type="button"
          className="chrome-button library-settings-button"
          onClick={() => setSettingsOpen(true)}
          title="设置"
          aria-label="打开设置"
        >
          <Gear size={17} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className="chrome-button library-settings-button"
          onClick={() => setSyncOpen(true)}
          title="云同步(WebDAV)"
          aria-label="打开云同步"
        >
          <Cloud size={17} weight="regular" aria-hidden />
        </button>
      </header>

      <main className="library-main">
        {libraryLoaded && books.length === 0 && !isTauriRuntime() && (
          <section className="library-empty" aria-label="导入书籍">
            <button
              type="button"
              className="library-drop-button"
              onClick={openFileInput}
              aria-label="导入书籍"
            >
              <BookOpenText size={44} weight="light" aria-hidden />
              <span className="library-empty-title">导入一本书</span>
              <span className="library-empty-hint">
                EPUB、MOBI、AZW3、FB2、CBZ、PDF、TXT、Markdown
              </span>
            </button>
            <p className="library-note">
              浏览器模式:导入的书籍只在当前会话有效;下载桌面版获得书架与进度记忆。
            </p>
          </section>
        )}

        {isTauriRuntime() && !libraryLoaded && (
          <div className="shelf-skeleton" aria-label="书架加载中">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="shelf-skeleton-card"
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </div>
        )}

        {isTauriRuntime() && libraryLoaded && books.length === 0 && (
          <section className="library-empty" aria-label="导入书籍">
            <button
              type="button"
              className="library-drop-button"
              onClick={triggerImport}
              aria-label="导入书籍"
            >
              <BookOpenText size={44} weight="light" aria-hidden />
              <span className="library-empty-title">把书拖进窗口,或点击导入</span>
              <span className="library-empty-hint">
                EPUB、MOBI、AZW3、FB2、CBZ、PDF、TXT、Markdown
              </span>
            </button>
          </section>
        )}

        {libraryLoaded && books.length > 0 && (
          <>
            <div className="shelf-toolbar">
              <h1 className="shelf-title">
                书架 <span className="shelf-count">{books.length}</span>
              </h1>
              <div className="shelf-search">
                <MagnifyingGlass size={15} weight="regular" aria-hidden />
                <input
                  type="search"
                  placeholder="搜索书名…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setQuery('')
                  }}
                  aria-label="搜索书名"
                />
              </div>
              <div className="shelf-view-toggle" role="toolbar" aria-label="视图切换">
                <button
                  type="button"
                  className={view === 'grid' ? 'is-active' : ''}
                  onClick={() => {
                    setView('grid')
                    localStorage.setItem('deepread.shelf.view', 'grid')
                  }}
                  title="网格视图"
                >
                  <SquaresFour size={15} weight="regular" aria-hidden />
                </button>
                <button
                  type="button"
                  className={view === 'list' ? 'is-active' : ''}
                  onClick={() => {
                    setView('list')
                    localStorage.setItem('deepread.shelf.view', 'list')
                  }}
                  title="列表视图"
                >
                  <ListBullets size={15} weight="regular" aria-hidden />
                </button>
              </div>
              <select
                className="shelf-sort"
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as SortKey)
                  localStorage.setItem('deepread.shelf.sort', event.target.value)
                }}
                aria-label="排序方式"
              >
                {Object.entries(SORT_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="shelf-import"
                onClick={triggerImport}
                aria-label="导入书籍"
              >
                <Plus size={15} weight="bold" aria-hidden /> 导入
              </button>
            </div>

            {filtered.length === 0 ? (
              <p className="shelf-none">没有匹配“{query}”的书。</p>
            ) : view === 'grid' ? (
              <ul className="shelf-grid" aria-label="书架">
                {filtered.map((book, index) => {
                  const palette = coverPalette(book.hash)
                  const title = book.fileName.replace(/\.[^.]+$/, '')
                  const progress = book.progress
                  const coverUrl = covers.get(book.hash) ?? null
                  return (
                    <li
                      key={book.hash}
                      className="book-card"
                      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
                    >
                      <button
                        type="button"
                        className="book-cover"
                        style={
                          coverUrl
                            ? undefined
                            : {
                                background: `linear-gradient(160deg, ${palette[0]}, ${palette[1]})`,
                              }
                        }
                        onClick={
                          book.format === 'unknown'
                            ? undefined
                            : () => onOpenBook(openedBookFromLibrary(book))
                        }
                        title={
                          book.format === 'unknown'
                            ? '重新导入同一文件即可恢复此书的进度与批注'
                            : `打开《${title}》`
                        }
                      >
                        {book.format === 'unknown' ? (
                          <span className="book-cover-missing">待重新导入</span>
                        ) : coverUrl ? (
                          <img src={coverUrl} alt="" className="book-cover-img" loading="lazy" />
                        ) : (
                          <>
                            <span className="book-cover-char">{title.charAt(0)}</span>
                            <span className="book-cover-title">{title}</span>
                          </>
                        )}
                        {book.format !== 'unknown' && (
                          <span className="book-format">{book.format.toUpperCase()}</span>
                        )}
                        {progress !== null && progress > 0 && (
                          <span className="book-progress" aria-hidden>
                            <span
                              className="book-progress-fill"
                              style={{ width: `${progress * 100}%` }}
                            />
                          </span>
                        )}
                      </button>
                      <div className="book-meta">
                        <span className="book-meta-title" title={book.fileName}>
                          {title}
                        </span>
                        <span className="book-meta-sub">
                          {book.format === 'unknown'
                            ? '重新导入同一文件即可恢复'
                            : progress !== null && progress > 0
                              ? `读到 ${Math.round(progress * 100)}% · ${formatBytes(book.size)}`
                              : formatBytes(book.size)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="book-remove"
                        onClick={() => void removeFromLibrary(book.hash)}
                        title="从书架移除(不删除原文件)"
                      >
                        <X size={13} weight="regular" aria-hidden />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <ul className="shelf-list" aria-label="书架">
                {filtered.map((book, index) => {
                  const title = book.fileName.replace(/\.[^.]+$/, '')
                  const progress = book.progress
                  const coverUrl = covers.get(book.hash) ?? null
                  const palette = coverPalette(book.hash)
                  return (
                    <li
                      key={book.hash}
                      className="book-row"
                      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
                    >
                      <button
                        type="button"
                        className="book-row-open"
                        onClick={() => onOpenBook(openedBookFromLibrary(book))}
                      >
                        <span
                          className="book-row-cover"
                          style={
                            coverUrl
                              ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover' }
                              : {
                                  background: `linear-gradient(160deg, ${palette[0]}, ${palette[1]})`,
                                }
                          }
                        >
                          {!coverUrl && <span className="book-cover-char">{title.charAt(0)}</span>}
                        </span>
                        <span className="book-row-main">
                          <span className="book-row-title">{title}</span>
                          <span className="book-row-sub">
                            {book.format.toUpperCase()} · {formatBytes(book.size)}
                            {progress !== null && progress > 0
                              ? ` · 读到 ${Math.round(progress * 100)}%`
                              : ''}
                          </span>
                        </span>
                        {progress !== null && progress > 0 && (
                          <span className="book-row-progress">
                            <span
                              className="book-progress-fill"
                              style={{ width: `${progress * 100}%` }}
                            />
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="book-remove book-row-remove"
                        onClick={() => void removeFromLibrary(book.hash)}
                        title="从书架移除(不删除原文件)"
                      >
                        <X size={13} weight="regular" aria-hidden />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
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

      {settingsOpen && (
        <div className="settings-overlay">
          <section className="settings-panel" aria-label="设置">
            <header className="lookup-head">
              <strong>设置</strong>
              <button
                type="button"
                className="chrome-button"
                onClick={() => setSettingsOpen(false)}
                title="关闭"
              >
                <X size={14} weight="regular" aria-hidden />
              </button>
            </header>
            <p className="settings-section-label">外观主题</p>
            <div className="theme-grid">
              {APP_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`theme-swatch${appTheme === theme.id ? ' is-active' : ''}`}
                  onClick={() => setAppTheme(theme.id)}
                >
                  <span className="theme-swatch-color" style={{ background: theme.swatch }} />
                  {theme.label}
                </button>
              ))}
            </div>
            <p className="settings-section-label">备份与恢复</p>
            <div className="segmented">
              <button type="button" onClick={() => void runBackup()} disabled={backupBusy}>
                {backupBusy ? '备份中…' : '备份到…'}
              </button>
              <button
                type="button"
                onClick={() => void runRestore(loadBooks)}
                disabled={backupBusy}
              >
                {backupBusy ? '恢复中…' : '从备份恢复…'}
              </button>
            </div>
            {backupMsg !== null && <p className="library-note">{backupMsg}</p>}
            <p className="settings-section-label">更新</p>
            <div className="segmented">
              <button type="button" onClick={() => void checkForUpdates()} disabled={updateBusy}>
                {updateBusy ? '检查中…' : '检查更新'}
              </button>
              {update !== null && (
                <button type="button" onClick={() => void installUpdate()} disabled={updateBusy}>
                  下载并安装
                </button>
              )}
              {update !== null && (
                <button type="button" onClick={ignoreUpdate} disabled={updateBusy}>
                  忽略此版本
                </button>
              )}
            </div>
            {updateMsg !== null && <p className="library-note">{updateMsg}</p>}
            <p className="settings-section-label">书架偏好(自动保存)</p>
            <p className="ai-privacy">
              排序与视图选择自动记忆;AI 服务在阅读器内的 ✦ 助手里配置(密钥存入系统钥匙串)。
            </p>
            <button
              type="button"
              className="reader-error-button"
              onClick={() => setSettingsOpen(false)}
            >
              完成
            </button>
          </section>
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

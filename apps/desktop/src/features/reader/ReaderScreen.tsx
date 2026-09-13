import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BookmarkSimple,
  Copy,
  GraduationCap,
  Headphones,
  Highlighter,
  List,
  MagnifyingGlass,
  Minus,
  Moon,
  Plus,
  Sparkle,
  Sun,
  TextAa,
  Trash,
  X,
} from '@phosphor-icons/react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  toAppError,
  type AnnotationRecord,
  type BookmarkRecord,
  type DictionaryMeta,
} from '@deepread/shared'
import type { ReaderTheme, TocItem } from '@deepread/reader-core'
import {
  applyRepair,
  buildIndex,
  chapterSections,
  FoliateAdapter,
  reviewRepair,
  inflateGzip,
  lookupWord,
  sanitizeDefinitionHtml,
  type DefinitionField,
  type EngineCallbacks,
  type EngineSelection,
} from '@deepread/reader-adapter'
import type { RepairChange } from '@deepread/reader-adapter'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { AiDrawer } from './AiDrawer'
import { LearningDrawer } from './LearningDrawer'
import { TtsDrawer } from './TtsDrawer'
import type { OpenedBook } from '../../lib/book-import'

const READER_THEMES: readonly { readonly label: string; readonly theme: ReaderTheme }[] = [
  {
    label: '纸白',
    theme: { name: 'Paper', background: '#ffffff', foreground: '#1d1b17', colorScheme: 'light' },
  },
  {
    label: '羊皮',
    theme: { name: 'Sepia', background: '#f4e8cf', foreground: '#3a3226', colorScheme: 'light' },
  },
  {
    label: '夜间',
    theme: { name: 'Night', background: '#131210', foreground: '#b8b2a7', colorScheme: 'dark' },
  },
]

const HIGHLIGHT_COLOR = '#f5d76e'
const FONT_SIZES = [14, 16, 18, 20] as const
// undefined means 原书排版 (the book's own typography wins)
const LINE_HEIGHT_OPTIONS: readonly {
  readonly label: string
  readonly value: number | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '紧凑', value: 1.45 },
  { label: '标准', value: 1.65 },
  { label: '宽松', value: 1.9 },
]
const FONT_FAMILY_OPTIONS: readonly {
  readonly label: string
  readonly value: 'serif' | 'sans' | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '衬线', value: 'serif' },
  { label: '无衬线', value: 'sans' },
]
type ViewMode = 'single' | 'dual' | 'scroll'
const VIEW_MODE_OPTIONS: readonly { readonly label: string; readonly value: ViewMode }[] = [
  { label: '单页', value: 'single' },
  { label: '双页', value: 'dual' },
  { label: '滚动', value: 'scroll' },
]
const CHROME_TIMEOUT_MS = 2500
const SAVE_DEBOUNCE_MS = 800
const MAX_SHOWN_SEARCH_RESULTS = 50

interface ReaderScreenProps {
  readonly book: OpenedBook
  readonly onBack: () => void
}

type Phase = 'opening' | 'reading' | 'error'

function toDomainAnnotation(record: AnnotationRecord, bookId: string) {
  const now = new Date().toISOString()
  return {
    ...record,
    bookId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    range: {
      start: { cfi: record.cfi, progress: 0 },
      end: { cfi: record.cfi, progress: 0 },
    },
    selectedText: record.excerpt ?? '',
  }
}

export function ReaderScreen({ book, onBack }: ReaderScreenProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<FoliateAdapter | null>(null)
  const callbacksRef = useRef<EngineCallbacks>({})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const progressRef = useRef<{ cfi: string; fraction: number } | null>(null)
  const annotationsRef = useRef<readonly AnnotationRecord[]>([])
  const bookmarksRef = useRef<readonly BookmarkRecord[]>([])
  const overlayOpenRef = useRef(false)
  const settingsRef = useRef({
    viewMode: 'single' as ViewMode,
    fontSize: 16,
    lineHeight: undefined as number | undefined,
    fontFamily: undefined as 'serif' | 'sans' | undefined,
    themeIndex: 0,
  })

  const [phase, setPhase] = useState<Phase>('opening')
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(book.name)
  const [toc, setToc] = useState<readonly TocItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [progress, setProgress] = useState<{
    cfi: string | null
    fraction: number
    location: { current: number; total: number } | undefined
  }>({ cfi: null, fraction: 0, location: undefined })
  const [selection, setSelection] = useState<EngineSelection | null>(null)
  const [activeAnnotation, setActiveAnnotation] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<readonly AnnotationRecord[]>([])
  const [bookmarks, setBookmarks] = useState<readonly BookmarkRecord[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>('single')
  const [fontSize, setFontSize] = useState<number>(16)
  const [lineHeight, setLineHeight] = useState<number | undefined>(undefined)
  const [fontFamily, setFontFamily] = useState<'serif' | 'sans' | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themeIndex, setThemeIndex] = useState(0)
  const [searchResults, setSearchResults] = useState<readonly { cfi: string; excerpt: string }[]>(
    [],
  )
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done'>('idle')
  const [dictionaries, setDictionaries] = useState<readonly DictionaryMeta[]>([])
  const [lookup, setLookup] = useState<{
    word: string
    rect: { top: number; left: number }
    results: readonly { dictName: string; word: string; fields: readonly DefinitionField[] }[]
  } | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [repairReview, setRepairReview] = useState<{
    proposals: readonly RepairChange[]
    accepted: ReadonlySet<string>
  } | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [ttsOpen, setTtsOpen] = useState(false)
  const [learningOpen, setLearningOpen] = useState(false)
  const sectionIndexRef = useRef(0)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [rebuildPattern, setRebuildPattern] = useState(
    () => localStorage.getItem(`deepread.chapterPattern.${book.hash}`) ?? '',
  )
  const [panelProblem, setPanelProblem] = useState<string | null>(null)
  const dictCacheRef = useRef(
    new Map<string, { entries: ReturnType<typeof buildIndex>; dict: Uint8Array }>(),
  )

  useEffect(() => {
    annotationsRef.current = annotations
  }, [annotations])

  useEffect(() => {
    bookmarksRef.current = bookmarks
  }, [bookmarks])

  useEffect(() => {
    overlayOpenRef.current = tocOpen || selection !== null || activeAnnotation !== null
  }, [tocOpen, selection, activeAnnotation])

  useEffect(() => {
    settingsRef.current = { viewMode, fontSize, lineHeight, fontFamily, themeIndex }
  }, [viewMode, fontSize, lineHeight, fontFamily, themeIndex])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      if (!isTauriRuntime()) return
      void invokeCommand('reader.state.set', {
        bookHash: book.hash,
        state: {
          progress: progressRef.current,
          annotations: annotationsRef.current,
          bookmarks: bookmarksRef.current,
          updatedAt: new Date().toISOString(),
        },
      }).catch(() => {
        // # ponytail: save failures surface on reopen; a retry queue belongs to
        // the sync engine (Phase 6), not to the reading path.
      })
    }, SAVE_DEBOUNCE_MS)
  }, [book.hash])

  useEffect(() => {
    callbacksRef.current = {
      onRelocate: (location) => {
        if (location.sectionIndex !== undefined) sectionIndexRef.current = location.sectionIndex
        const fraction =
          typeof location.fraction === 'number' && Number.isFinite(location.fraction)
            ? location.fraction
            : 0
        const cfi = location.cfi
        progressRef.current = cfi !== undefined ? { cfi, fraction } : progressRef.current
        setProgress({
          cfi: cfi ?? null,
          fraction,
          location: location.location,
        })
        scheduleSave()
      },
      onSelection: (sel) => {
        setActiveAnnotation(null)
        setSelection(sel)
        setChromeVisible(true)
      },
      onShowAnnotation: (cfi) => {
        setSelection(null)
        setActiveAnnotation(cfi)
        setChromeVisible(true)
      },
      onTapZone: (zone) => {
        if (zone === 'center') {
          setChromeVisible((visible) => !visible)
          return
        }
        const adapter = adapterRef.current
        if (!adapter) return
        void (zone === 'left' ? adapter.previousPage() : adapter.nextPage())
      },
    }
  })

  useEffect(() => {
    if (!isTauriRuntime()) return
    invokeCommand('dictionary.list', undefined)
      .then((response) => setDictionaries(response.dictionaries))
      .catch(() => {
        // Lookup is optional; the panel's import button retries the list.
      })
  }, [])

  // One effect owns the adapter lifecycle: create → open → restore → destroy.
  // Splitting create and open across effects raced under StrictMode's
  // double-mount and leaked a second kernel view into the host.
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    const adapter = new FoliateAdapter(hostRef.current ?? document.body, {
      onRelocate: (location) => callbacksRef.current.onRelocate?.(location),
      onSelection: (sel) => callbacksRef.current.onSelection?.(sel),
      onShowAnnotation: (cfi) => callbacksRef.current.onShowAnnotation?.(cfi),
      onTapZone: (zone) => callbacksRef.current.onTapZone?.(zone),
    })
    adapterRef.current = adapter
    let cancelled = false
    void (async () => {
      try {
        await adapter.open({
          bookId: book.bookId,
          format: book.format,
          url: book.url,
          name: book.name,
        })
        const [metadata, tocItems] = await Promise.all([
          adapter.getMetadata(),
          adapter.getTableOfContents(),
        ])
        if (cancelled) return
        setTitle(metadata.title || book.name)
        setToc(tocItems)
        await adapter.setTheme(
          READER_THEMES[settingsRef.current.themeIndex]?.theme ?? READER_THEMES[0]!.theme,
        )
        await adapter.setLayout({
          flow: settingsRef.current.viewMode === 'scroll' ? 'scrolled' : 'paginated',
          pageMode: settingsRef.current.viewMode === 'dual' ? 'dual' : 'single',
          fontSize: settingsRef.current.fontSize,
          lineHeight: settingsRef.current.lineHeight,
          fontFamily: settingsRef.current.fontFamily,
        })

        let restored = null
        if (isTauriRuntime()) {
          const response = await invokeCommand('reader.state.get', { bookHash: book.hash })
          restored = response.state
        }
        if (restored) {
          setAnnotations(restored.annotations)
          for (const record of restored.annotations) {
            await adapter.createAnnotation(toDomainAnnotation(record, book.bookId))
          }
          setBookmarks(restored.bookmarks)
          if (restored.progress) {
            await adapter.goTo({ cfi: restored.progress.cfi, progress: restored.progress.fraction })
          }
        }
        if (!cancelled) setPhase('reading')
      } catch (err) {
        if (!cancelled) {
          setError(toAppError(err).message)
          setPhase('error')
        }
      }
    })()
    return () => {
      cancelled = true
      adapterRef.current = null
      void adapter.destroy()
    }
  }, [book])

  // One bounded snippet of the current section, refreshed when the drawer
  // opens — enough context for explanations without shipping the whole book.
  const [aiContext, setAiContext] = useState<string | null>(null)
  // RAG sections: adapter-built books expose their source directly; kernel
  // books fall back to a single section from the live contents.
  const [ragSections, setRagSections] = useState<readonly { label: string; text: string }[]>([])
  const [sourceText, setSourceText] = useState<string | null>(null)
  useEffect(() => {
    if (!aiOpen) return
    const adapter = adapterRef.current
    if (!adapter) return
    void adapter
      .getText()
      .then((text) => {
        setAiContext(text.slice(0, 2000))
        const source = adapter.getSourceText()
        if (source !== null) {
          setSourceText(source)
          setRagSections(chapterSections(source))
        } else {
          setRagSections([{ label: '原书正文', text: text.slice(0, 20_000) }])
        }
      })
      .catch(() => {
        setAiContext(null)
      })
  }, [aiOpen])

  const showChrome = useCallback(() => {
    setChromeVisible(true)
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = setTimeout(() => {
      if (!overlayOpenRef.current) setChromeVisible(false)
    }, CHROME_TIMEOUT_MS)
  }, [])

  useEffect(() => {
    const onPointerMove = (): void => showChrome()
    const onKeyDown = (event: KeyboardEvent): void => {
      const adapter = adapterRef.current
      if (!adapter) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        void adapter.nextPage()
        showChrome()
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        void adapter.previousPage()
        showChrome()
      } else if (event.key === 'Escape') {
        setTocOpen(false)
        setSettingsOpen(false)
        setSelection(null)
        setActiveAnnotation(null)
      }
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [showChrome])

  const changeTheme = (delta: number): void => {
    const next = (themeIndex + delta + READER_THEMES.length) % READER_THEMES.length
    setThemeIndex(next)
    void adapterRef.current?.setTheme(READER_THEMES[next]?.theme ?? READER_THEMES[0]!.theme)
  }

  const updateLayout = (patch: {
    viewMode?: ViewMode
    fontSize?: number
    lineHeight?: number | undefined
    fontFamily?: 'serif' | 'sans' | undefined
  }): void => {
    const next = {
      viewMode: patch.viewMode ?? viewMode,
      fontSize: patch.fontSize ?? fontSize,
      lineHeight: patch.lineHeight !== undefined ? patch.lineHeight : lineHeight,
      fontFamily: patch.fontFamily !== undefined ? patch.fontFamily : fontFamily,
    }
    setViewMode(next.viewMode)
    setFontSize(next.fontSize)
    setLineHeight(next.lineHeight)
    setFontFamily(next.fontFamily)
    void adapterRef.current?.setLayout({
      flow: next.viewMode === 'scroll' ? 'scrolled' : 'paginated',
      pageMode: next.viewMode === 'dual' ? 'dual' : 'single',
      fontSize: next.fontSize,
      lineHeight: next.lineHeight,
      fontFamily: next.fontFamily,
    })
  }

  const changeFontSize = (delta: number): void => {
    const current = FONT_SIZES.indexOf(fontSize as (typeof FONT_SIZES)[number])
    updateLayout({
      fontSize: FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, current + delta))] ?? 16,
    })
  }

  const goToCfi = useCallback((cfi: string): void => {
    void adapterRef.current?.goTo({ cfi, progress: 0 })
    setTocOpen(false)
    setSelection(null)
    setActiveAnnotation(null)
  }, [])

  const goToTocItem = (item: TocItem): void => {
    void adapterRef.current?.goTo({
      ...(item.href !== undefined ? { href: item.href } : {}),
      progress: 0,
    })
    setTocOpen(false)
  }

  /** TTS 听书:当前 section 的纯文本(朗读起点为章首)。 */
  const ttsGetSectionText = useCallback(async (): Promise<string> => {
    const adapter = adapterRef.current
    if (!adapter) return ''
    return adapter.getSectionText(sectionIndexRef.current)
  }, [])

  /** TTS 听书:跳到下一个 section;全书结束时返回 false。 */
  const ttsAdvanceSection = useCallback(async (): Promise<boolean> => {
    const adapter = adapterRef.current
    if (!adapter) return false
    const count = await adapter.getSectionCount()
    const next = sectionIndexRef.current + 1
    if (next >= count) return false
    await adapter.goToSection(next)
    sectionIndexRef.current = next
    return true
  }, [])

  const addHighlight = async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter || selection === null) return
    const record: AnnotationRecord = {
      id: crypto.randomUUID(),
      cfi: selection.cfi,
      color: HIGHLIGHT_COLOR,
      excerpt: selection.text.slice(0, 500),
    }
    await adapter.createAnnotation(toDomainAnnotation(record, book.bookId))
    setAnnotations((current) => [...current, record])
    setSelection(null)
    scheduleSave()
  }

  const removeHighlight = async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter || activeAnnotation === null) return
    const record = annotations.find((a) => a.cfi === activeAnnotation)
    if (!record) return
    await adapter.removeAnnotation(record.id)
    setAnnotations((current) => current.filter((a) => a.id !== record.id))
    setActiveAnnotation(null)
    scheduleSave()
  }

  const copySelection = async (): Promise<void> => {
    if (selection === null) return
    await navigator.clipboard.writeText(selection.text)
    setSelection(null)
  }

  const isGzip = (data: Uint8Array): boolean => data[0] === 0x1f && data[1] === 0x8b

  const fetchBuffer = async (path: string): Promise<Uint8Array> => {
    const response = await fetch(convertFileSrc(path))
    if (!response.ok) throw new Error(`无法读取 ${path}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  const loadDictionary = async (
    meta: DictionaryMeta,
  ): Promise<{ entries: ReturnType<typeof buildIndex>; dict: Uint8Array }> => {
    const cached = dictCacheRef.current.get(meta.id)
    if (cached) return cached
    let idx = await fetchBuffer(meta.idxPath)
    let dict = await fetchBuffer(meta.dictPath)
    if (isGzip(idx)) idx = await inflateGzip(idx)
    if (isGzip(dict)) dict = await inflateGzip(dict)
    const loaded = { entries: buildIndex(idx), dict }
    dictCacheRef.current.set(meta.id, loaded)
    return loaded
  }

  const importDictionary = useCallback(async (): Promise<void> => {
    const path = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'StarDict 词典', extensions: ['ifo'] }],
    })
    if (!path) return
    try {
      await invokeCommand('dictionary.register', { path })
      const response = await invokeCommand('dictionary.list', undefined)
      setDictionaries(response.dictionaries)
      setPanelProblem(null)
    } catch (registerError) {
      setPanelProblem(toAppError(registerError).message ?? null)
    }
  }, [])

  const removeDictionary = useCallback(async (id: string): Promise<void> => {
    try {
      await invokeCommand('dictionary.remove', { id })
      setDictionaries((current) => current.filter((d) => d.id !== id))
      dictCacheRef.current.delete(id)
      setPanelProblem(null)
    } catch (removeError) {
      setPanelProblem(toAppError(removeError).message ?? null)
    }
  }, [])

  const startRepair = (): void => {
    const source = adapterRef.current?.getSourceText()
    if (source === null || source === undefined) return
    const review = reviewRepair(source)
    setRepairReview({
      proposals: [...review.proposals],
      accepted: new Set(review.proposals.map((proposal) => proposal.id)),
    })
  }

  const applyAcceptedRepairs = async (): Promise<void> => {
    const adapter = adapterRef.current
    const review = repairReview
    if (!adapter || !review) return
    const source = adapter.getSourceText()
    if (source === null) return
    const repaired = applyRepair(source, review.proposals, [...review.accepted])
    await adapter.replaceSource(repaired)
    setToc(await adapter.getTableOfContents())
    setRepairReview(null)
    await adapter.goTo({ href: 's0', progress: 0 })
  }

  const toggleRepairProposal = (id: string): void => {
    setRepairReview((current) => {
      if (!current) return current
      const accepted = new Set(current.accepted)
      if (accepted.has(id)) accepted.delete(id)
      else accepted.add(id)
      return { ...current, accepted }
    })
  }

  const applyRebuild = async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) return
    try {
      const count = await adapter.rebuildChapters(
        rebuildPattern.trim() === '' ? null : rebuildPattern.trim(),
      )
      localStorage.setItem(`deepread.chapterPattern.${book.hash}`, rebuildPattern.trim())
      setToc(await adapter.getTableOfContents())
      setRebuildOpen(false)
      setError(`章节重建完成:共 ${count} 节。`)
    } catch (rebuildError) {
      setError(toAppError(rebuildError).message)
    }
  }

  const runLookup = async (): Promise<void> => {
    if (!selection) return
    const word = selection.text
      .trim()
      .replace(/^[^\w\u4e00-\u9fff]+|[^\w\u4e00-\u9fff]+$/g, '')
      .slice(0, 40)
    const rect = { top: selection.rect.top, left: selection.rect.left }
    setSelection(null)
    if (!word) return
    setLookupLoading(true)
    setLookup({ word, rect, results: [] })
    const results: { dictName: string; word: string; fields: readonly DefinitionField[] }[] = []
    for (const meta of dictionaries) {
      try {
        const loaded = await loadDictionary(meta)
        for (const result of lookupWord(loaded.entries, loaded.dict, word, meta.sametypesequence)) {
          results.push({ dictName: meta.name, ...result })
        }
      } catch {
        // One unreadable dictionary must not break lookup for the rest.
      }
    }
    setLookup({ word, rect, results })
    setLookupLoading(false)
  }

  const toggleBookmark = (): void => {
    const current = progressRef.current
    if (!current) return
    const existing = bookmarks.find((b) => b.cfi === current.cfi)
    if (existing) {
      setBookmarks((list) => list.filter((b) => b.id !== existing.id))
    } else {
      setBookmarks((list) => [
        ...list,
        { id: crypto.randomUUID(), cfi: current.cfi, createdAt: new Date().toISOString() },
      ])
    }
    scheduleSave()
  }

  const removeBookmark = (id: string): void => {
    setBookmarks((list) => list.filter((b) => b.id !== id))
    scheduleSave()
  }

  const runSearch = async (): Promise<void> => {
    const adapter = adapterRef.current
    const query = searchInputRef.current?.value.trim()
    if (!adapter || !query) return
    setSearchState('searching')
    const results = await adapter.search(query)
    setSearchResults(
      results
        .slice(0, MAX_SHOWN_SEARCH_RESULTS)
        .map((r) => ({ cfi: r.location.cfi ?? '', excerpt: r.excerpt })),
    )
    setSearchState('done')
  }

  const theme = READER_THEMES[themeIndex] ?? READER_THEMES[0]!
  const percent = Math.round(progress.fraction * 1000) / 10
  const bookmarkedHere = progress.cfi !== null && bookmarks.some((b) => b.cfi === progress.cfi)

  const renderTocItems = (items: readonly TocItem[], level: number): React.ReactNode =>
    items.map((item) => (
      <div key={item.id}>
        <button
          type="button"
          className="toc-item"
          style={{ paddingLeft: 12 + level * 16 }}
          onClick={() => goToTocItem(item)}
        >
          {item.title}
        </button>
        {item.children.length > 0 && <div>{renderTocItems(item.children, level + 1)}</div>}
      </div>
    ))

  return (
    <div
      className={`reader${chromeVisible || tocOpen ? ' chrome-visible' : ''}`}
      style={
        {
          '--reader-bg': theme.theme.background,
          '--reader-fg': theme.theme.foreground,
        } as React.CSSProperties
      }
      onPointerDown={() => showChrome()}
    >
      <div ref={hostRef} className="reader-host" />

      {phase === 'opening' && <div className="reader-opening" data-title={`正在打开 ${title}…`} />}
      {phase === 'error' && (
        <div className="reader-error" role="alert">
          <p>{error}</p>
          <button type="button" className="reader-error-button" onClick={onBack}>
            返回书架
          </button>
        </div>
      )}

      <header className="reader-top">
        <button type="button" className="chrome-button" onClick={onBack} title="返回书架">
          <ArrowLeft size={18} weight="regular" aria-hidden />
        </button>
        <span className="reader-title">{title}</span>
        <button
          type="button"
          className="chrome-button"
          onClick={toggleBookmark}
          title={bookmarkedHere ? '移除书签' : '在此页添加书签'}
        >
          <BookmarkSimple
            size={18}
            weight={bookmarkedHere ? 'fill' : 'regular'}
            aria-hidden
            color={bookmarkedHere ? 'var(--color-accent)' : undefined}
          />
        </button>
        <button
          type="button"
          className="chrome-button"
          onClick={() => changeTheme(1)}
          title={`阅读主题:${theme.label}`}
        >
          {theme.theme.colorScheme === 'dark' ? (
            <Moon size={18} weight="regular" aria-hidden />
          ) : (
            <Sun size={18} weight="regular" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className={`chrome-button${settingsOpen ? ' is-active' : ''}`}
          onClick={() => setSettingsOpen((open) => !open)}
          title="排版设置"
        >
          <TextAa size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${aiOpen ? ' is-active' : ''}`}
          onClick={() => {
            setAiOpen((open) => !open)
            setTtsOpen(false)
            setLearningOpen(false)
          }}
          title="AI 助手"
        >
          <Sparkle size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${ttsOpen ? ' is-active' : ''}`}
          onClick={() => {
            setTtsOpen((open) => !open)
            setAiOpen(false)
            setLearningOpen(false)
          }}
          title="朗读 / 听书"
        >
          <Headphones size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${learningOpen ? ' is-active' : ''}`}
          onClick={() => {
            setLearningOpen((open) => !open)
            setAiOpen(false)
            setTtsOpen(false)
          }}
          title="学习(卡片 / 测验 / 错题本)"
        >
          <GraduationCap size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className="chrome-button"
          onClick={() => {
            setTocOpen((open) => !open)
            setChromeVisible(true)
          }}
          title="目录与搜索"
        >
          <List size={18} weight="regular" aria-hidden />
        </button>
      </header>

      {settingsOpen && (
        <section className="reader-settings" aria-label="排版设置">
          <div className="settings-row">
            <span className="settings-label">字号</span>
            <div className="segmented">
              <button
                type="button"
                className="chrome-button"
                onClick={() => changeFontSize(-1)}
                title="减小字号"
              >
                <Minus size={14} weight="regular" aria-hidden />
              </button>
              <span className="segmented-value">{fontSize}px</span>
              <button
                type="button"
                className="chrome-button"
                onClick={() => changeFontSize(1)}
                title="增大字号"
              >
                <Plus size={14} weight="regular" aria-hidden />
              </button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">行距</span>
            <div className="segmented">
              {LINE_HEIGHT_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={lineHeight === option.value ? 'is-active' : ''}
                  onClick={() => updateLayout({ lineHeight: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">字体</span>
            <div className="segmented">
              {FONT_FAMILY_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={fontFamily === option.value ? 'is-active' : ''}
                  onClick={() => updateLayout({ fontFamily: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          {panelProblem !== null && (
            <p className="lookup-empty" role="alert">
              {panelProblem}
            </p>
          )}
          {dictionaries.length > 0 && <p className="settings-label">词典</p>}
          {dictionaries.map((dictionary) => (
            <div key={dictionary.id} className="settings-row dictionary-row">
              <span className="settings-label">
                {dictionary.name} · {dictionary.wordCount}
              </span>
              <button
                type="button"
                className="chrome-button"
                onClick={() => void removeDictionary(dictionary.id)}
                title="移除词典"
              >
                <X size={12} weight="regular" aria-hidden />
              </button>
            </div>
          ))}
          <div className="settings-row">
            <span className="settings-label">导入词典</span>
            <div className="segmented">
              <button type="button" onClick={() => void importDictionary()}>
                选择 .ifo
              </button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">方式</span>
            <div className="segmented">
              {VIEW_MODE_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={viewMode === option.value ? 'is-active' : ''}
                  onClick={() => updateLayout({ viewMode: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {tocOpen && (
        <nav className="reader-toc" aria-label="目录与搜索">
          <div className="reader-toc-head">
            <span>目录</span>
            <button
              type="button"
              className="chrome-button"
              onClick={() => setTocOpen(false)}
              title="关闭"
            >
              <X size={16} weight="regular" aria-hidden />
            </button>
          </div>

          <div className="reader-search">
            <input
              ref={searchInputRef}
              type="search"
              className="reader-search-input"
              placeholder="搜索全书…"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch()
              }}
            />
            <button
              type="button"
              className="chrome-button"
              onClick={() => void runSearch()}
              title="搜索"
            >
              <MagnifyingGlass size={16} weight="regular" aria-hidden />
            </button>
          </div>
          {searchState === 'searching' && <p className="reader-toc-empty">搜索中…</p>}
          {searchState === 'done' && searchResults.length === 0 && (
            <p className="reader-toc-empty">没有找到匹配的正文。</p>
          )}
          {searchResults.map((result) => (
            <button
              key={result.cfi}
              type="button"
              className="toc-item search-result"
              onClick={() => goToCfi(result.cfi)}
              title="跳转到此处"
            >
              {result.excerpt}
            </button>
          ))}

          {book.format === 'txt' && (
            <>
              <div className="settings-row repair-row">
                <span className="settings-label">文本修整</span>
                <div className="segmented">
                  <button type="button" onClick={startRepair}>
                    检查
                  </button>
                </div>
              </div>
              <div className="settings-row repair-row">
                <span className="settings-label">章节重建</span>
                <div className="segmented">
                  <button type="button" onClick={() => setRebuildOpen((open) => !open)}>
                    {rebuildOpen ? '收起' : '自定义'}
                  </button>
                </div>
              </div>
              {rebuildOpen && (
                <div className="rebuild-form">
                  <input
                    className="ai-input"
                    placeholder="正则,如 第\s*\d+\s*章(留空用内置规则)"
                    value={rebuildPattern}
                    onChange={(event) => setRebuildPattern(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void applyRebuild()
                    }}
                  />
                  <button
                    type="button"
                    className="reader-error-button"
                    onClick={() => void applyRebuild()}
                  >
                    重建
                  </button>
                </div>
              )}
            </>
          )}

          {bookmarks.length > 0 && <p className="reader-section-label">书签</p>}
          {bookmarks.map((bookmark) => (
            <div key={bookmark.id} className="bookmark-row">
              <button
                type="button"
                className="toc-item"
                onClick={() => goToCfi(bookmark.cfi)}
                title="跳转到书签"
              >
                {bookmark.label ?? `书签 ${bookmark.cfi}`}
              </button>
              <button
                type="button"
                className="chrome-button"
                onClick={() => removeBookmark(bookmark.id)}
                title="删除书签"
              >
                <X size={12} weight="regular" aria-hidden />
              </button>
            </div>
          ))}

          {toc.length === 0 && searchResults.length === 0 && bookmarks.length === 0 ? (
            <p className="reader-toc-empty">这本书没有目录信息。</p>
          ) : (
            renderTocItems(toc, 0)
          )}
        </nav>
      )}

      <footer className="reader-bottom">
        <input
          type="range"
          className="reader-slider"
          min={0}
          max={1000}
          value={Math.round(progress.fraction * 1000)}
          aria-label="阅读进度"
          onChange={(event) => {
            const fraction = Number(event.target.value) / 1000
            setProgress((current) => ({ ...current, fraction }))
            progressRef.current =
              progressRef.current !== null ? { ...progressRef.current, fraction } : null
            void adapterRef.current?.goTo({ progress: fraction })
          }}
        />
        <ArrowLeft size={14} weight="regular" aria-hidden className="reader-arrow" />
        <ArrowRight size={14} weight="regular" aria-hidden className="reader-arrow" />
        <span className="reader-percent">{percent.toFixed(1)}%</span>
      </footer>

      {repairReview !== null && (
        <section className="repair-panel" aria-label="修整评审">
          <div className="lookup-head">
            <strong>修整建议({repairReview.proposals.length})</strong>
            <button
              type="button"
              className="chrome-button"
              onClick={() => setRepairReview(null)}
              title="放弃"
            >
              <X size={12} weight="regular" aria-hidden />
            </button>
          </div>
          {repairReview.proposals.length === 0 && (
            <p className="lookup-empty">没有发现可修整的内容。</p>
          )}
          {repairReview.proposals.map((proposal) => (
            <label
              key={proposal.id}
              className="repair-item"
              aria-label={`应用${proposal.rule === 'hard-break' ? '合并断行' : '多余空格'}修整`}
            >
              <input
                type="checkbox"
                checked={repairReview.accepted.has(proposal.id)}
                onChange={() => toggleRepairProposal(proposal.id)}
              />
              <span className="repair-body">
                <span className="repair-rule">
                  {proposal.rule === 'hard-break' ? '合并断行' : '多余空格'}
                </span>
                <s className="repair-before">{proposal.before.replace(/\n/g, ' ⏎ ')}</s>
                <span className="repair-after">{proposal.after}</span>
              </span>
            </label>
          ))}
          {repairReview.proposals.length > 0 && (
            <button
              type="button"
              className="reader-error-button"
              onClick={() => void applyAcceptedRepairs()}
            >
              应用已选({repairReview.accepted.size}/{repairReview.proposals.length})
            </button>
          )}
        </section>
      )}

      {aiOpen && (
        <AiDrawer
          selection={selection?.text ?? null}
          contextText={aiContext}
          sections={ragSections}
          bookHash={book.hash}
          title={title}
          sourceText={sourceText}
          onReplaceSource={async (text) => {
            const adapter = adapterRef.current
            if (!adapter) return
            await adapter.replaceSource(text)
            const source = adapter.getSourceText()
            if (source !== null) {
              setSourceText(source)
              setRagSections(chapterSections(source))
            }
            setToc(await adapter.getTableOfContents())
          }}
          onClose={() => setAiOpen(false)}
        />
      )}

      {ttsOpen && (
        <TtsDrawer
          bookHash={book.hash}
          bookTitle={title}
          getSectionText={ttsGetSectionText}
          advanceSection={ttsAdvanceSection}
          onClose={() => setTtsOpen(false)}
        />
      )}

      {learningOpen && (
        <LearningDrawer
          bookHash={book.hash}
          bookTitle={title}
          annotations={annotations}
          getChapterText={ttsGetSectionText}
          onClose={() => setLearningOpen(false)}
        />
      )}

      {selection !== null && (
        <div
          className="selection-toolbar"
          style={{
            top: Math.max(12, selection.rect.top - 52),
            left: Math.max(12, Math.min(selection.rect.left, window.innerWidth - 180)),
          }}
        >
          <button type="button" onClick={() => void copySelection()} title="复制">
            <Copy size={16} weight="regular" aria-hidden />
          </button>
          <button type="button" onClick={() => void addHighlight()} title="划线">
            <Highlighter size={16} weight="regular" aria-hidden />
          </button>
          {selection.text.trim().length <= 40 && (
            <button type="button" onClick={() => void runLookup()} title="查词典">
              <BookOpen size={16} weight="regular" aria-hidden />
            </button>
          )}
        </div>
      )}

      {(lookupLoading || lookup !== null) && (
        <div
          className="lookup-card"
          style={{
            top: Math.min(
              Math.max(64, (lookup?.rect.top ?? selection?.rect.top ?? 100) - 12),
              window.innerHeight - 260,
            ),
            left: Math.max(12, Math.min(lookup?.rect.left ?? 100, window.innerWidth - 320)),
          }}
        >
          <div className="lookup-head">
            <strong>{lookup?.word ?? '查询中…'}</strong>
            <button
              type="button"
              className="chrome-button"
              onClick={() => setLookup(null)}
              title="关闭"
            >
              <X size={12} weight="regular" aria-hidden />
            </button>
          </div>
          {lookupLoading && <p className="lookup-empty">查询中…</p>}
          {lookup !== null && lookup.results.length === 0 && !lookupLoading && (
            <p className="lookup-empty">词典中没有这个词条。</p>
          )}
          {lookup?.results.map((result, index) => (
            <div key={`${result.dictName}-${index}`} className="lookup-entry">
              <p className="lookup-dict">{result.dictName}</p>
              {result.fields.map((field, fieldIndex) =>
                field.type === 'html' ? (
                  <div
                    key={fieldIndex}
                    className="lookup-def"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeDefinitionHtml(field.content, new DOMParser()),
                    }}
                  />
                ) : (
                  <div key={fieldIndex} className="lookup-def">
                    {field.content}
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
      )}

      {activeAnnotation !== null && (
        <div className="selection-toolbar annotation-toolbar">
          <button type="button" onClick={() => void removeHighlight()} title="删除划线">
            <Trash size={16} weight="regular" aria-hidden />
          </button>
          <button type="button" onClick={() => setActiveAnnotation(null)} title="关闭">
            <X size={16} weight="regular" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}

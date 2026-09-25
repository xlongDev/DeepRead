import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  Copy,
  CornersOut,
  GraduationCap,
  Headphones,
  Highlighter,
  List,
  MagnifyingGlass,
  Minus,
  Moon,
  SlidersHorizontal,
  Plus,
  Sparkle,
  Sun,
  TextAa,
  Trash,
  X,
} from '@phosphor-icons/react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  toAppError,
  type AnnotationRecord,
  type BookmarkRecord,
  type DictionaryMeta,
  type ReadingFont,
} from '@deepread/shared'
import type { ReaderTheme, TocItem } from '@deepread/reader-core'
import {
  applyRepair,
  buildIndex,
  chapterSections,
  extractCover,
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
  readonly value: string | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '霞鹜文楷', value: 'wenkai' },
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

/** 书籍文档的 @font-face:内置霞鹜文楷 + 用户导入字体。 */
function buildFontFacesCss(
  customFonts: readonly { readonly name: string; readonly path: string }[],
): string {
  const rules = [
    `@font-face { font-family: 'LXGW WenKai'; src: url('${window.location.origin}/fonts/LxgwWenkai-Regular.ttf') format('truetype'); font-display: swap; }`,
  ]
  for (const font of customFonts) {
    const safeName = font.name.replace(/['"]/g, '')
    rules.push(
      `@font-face { font-family: '${safeName}'; src: url('${convertFileSrc(font.path)}') format('truetype'); font-display: swap; }`,
    )
  }
  return rules.join('\n')
}

/** 十六进制色 → 带 alpha 的 rgba,用于给阅读主题派生磨砂面板底色。 */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return hex
  const value = match[1] ?? ''
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 中英混排字数:中日韩字符按字计,连续西文按词计。 */
function countChars(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length
  const latinWords = (
    text
      .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ')
      .match(/[A-Za-z0-9'’-]+/g) ?? []
  ).length
  return cjk + latinWords
}

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

const ttsCoverCache = new Map<string, string>()

export function ReaderScreen({ book, onBack }: ReaderScreenProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<FoliateAdapter | null>(null)
  const callbacksRef = useRef<EngineCallbacks>({})
  const handleReaderKeyRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const progressRef = useRef<{ cfi: string; fraction: number } | null>(null)
  const annotationsRef = useRef<readonly AnnotationRecord[]>([])
  const bookmarksRef = useRef<readonly BookmarkRecord[]>([])
  const overlayOpenRef = useRef(false)
  const openPanelRef = useRef<'toc' | 'settings' | 'display' | 'ai' | 'tts' | 'learning' | null>(
    null,
  )
  /** 关闭面板那一刻的时间戳:同一次点击不会再触发翻页/切换 chrome。 */
  const panelClosedAtRef = useRef(0)
  const settingsRef = useRef({
    viewMode: 'single' as ViewMode,
    fontSize: 16,
    lineHeight: undefined as number | undefined,
    fontFamily: undefined as string | undefined,
    themeIndex: 0,
  })

  const [phase, setPhase] = useState<Phase>('opening')
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(book.name)
  const [toc, setToc] = useState<readonly TocItem[]>([])
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
  const [fontFamily, setFontFamily] = useState<string | undefined>(undefined)
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
  // 阅读器的面板互斥:同一时刻最多一个浮层(目录/排版/AI/朗读/学习)。
  const [openPanel, setOpenPanel] = useState<
    'toc' | 'settings' | 'display' | 'ai' | 'tts' | 'learning' | null
  >(null)
  const [bookLanguage, setBookLanguage] = useState<string | undefined>(undefined)
  const [sectionLabel, setSectionLabel] = useState<string | null>(null)
  const [ttsMinimized, setTtsMinimized] = useState(false)
  const [ttsActive, setTtsActive] = useState(false)
  const [ttsCoverUrl, setTtsCoverUrl] = useState<string | null>(
    () => ttsCoverCache.get(book.hash) ?? null,
  )
  const [fullscreen, setFullscreen] = useState(false)
  const [turnDir, setTurnDir] = useState<'next' | 'prev' | null>(null)
  /** 当前章字数(千分位在渲染层做);null = 还没算出来。 */
  const [sectionChars, setSectionChars] = useState<number | null>(null)
  /** 底栏统计显示偏好(进度条/字数/预计时间),自绘开关控制。 */
  /** 用户导入字体(fonts.list);变更后重建 @font-face 并重设引擎样式。 */
  const [customFonts, setCustomFonts] = useState<readonly ReadingFont[]>([])
  const [fontBusy, setFontBusy] = useState(false)
  /** 翻页动画:滑动/覆盖/仿真/淡入。 */
  const [pageTurnStyle, setPageTurnStyle] = useState<'slide' | 'cover' | 'flip' | 'fade'>(
    () => (localStorage.getItem('deepread.reader.pageTurn') as 'slide' | null) ?? 'slide',
  )
  const [statsSettings, setStatsSettings] = useState<{
    progress: boolean
    words: boolean
    time: boolean
  }>(() => {
    try {
      const stored = localStorage.getItem('deepread.reader.stats')
      return stored
        ? { progress: true, words: true, time: true, ...(JSON.parse(stored) as object) }
        : { progress: true, words: true, time: true }
    } catch {
      return { progress: true, words: true, time: true }
    }
  })
  const sectionIndexRef = useRef(0)
  const lastLightIndexRef = useRef(0)
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
    overlayOpenRef.current = openPanel !== null || selection !== null || activeAnnotation !== null
  }, [openPanel, selection, activeAnnotation])

  // 内核回调(constant closure)需要读到最新的面板状态。
  useEffect(() => {
    openPanelRef.current = openPanel
  }, [openPanel])

  useEffect(() => {
    settingsRef.current = { viewMode, fontSize, lineHeight, fontFamily, themeIndex }
  }, [viewMode, fontSize, lineHeight, fontFamily, themeIndex])

  const saveNow = useCallback((): void => {
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
  }, [book.hash])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }, [saveNow])

  // Crash recovery (spec §128): the debounce can lose up to SAVE_DEBOUNCE_MS
  // of progress on a force-quit — flush when the page hides or is backgrounded.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      saveNow()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [saveNow])

  useEffect(() => {
    callbacksRef.current = {
      onRelocate: (location) => {
        if (location.sectionIndex !== undefined) sectionIndexRef.current = location.sectionIndex
        if (location.tocLabel !== undefined) setSectionLabel(location.tocLabel)
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
        // 书页内容在 iframe 里,父层收不到 pointerdown;任何书内交互都兼作
        // "点空白"——面板开着时先收起面板(内核翻页 zone 有 250ms 延迟,
        // panelClosedAtRef 保证同一次点击不再被当成翻页)。
        if (openPanelRef.current !== null) {
          panelClosedAtRef.current = Date.now()
          setOpenPanel(null)
        }
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
        if (openPanelRef.current !== null) {
          panelClosedAtRef.current = Date.now()
          setOpenPanel(null)
          return
        }
        if (Date.now() - panelClosedAtRef.current < 600) return
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

  // 朗读播放条的封面缩略图:与书架同一提取管线,模块级缓存。
  useEffect(() => {
    if (ttsCoverUrl) return
    let cancelled = false
    void extractCover(book.url, book.format)
      .then((url) => {
        if (!cancelled && url) {
          ttsCoverCache.set(book.hash, url)
          setTtsCoverUrl(url)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [book, ttsCoverUrl])

  // 导入字体列表 → 组装 @font-face → 注入书籍文档。
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void invokeCommand('fonts.list', undefined)
      .then((fonts) => {
        if (cancelled) return
        setCustomFonts(fonts)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    void adapterRef.current?.setFontFaces(
      buildFontFacesCss(customFonts.map((font) => ({ name: font.name, path: font.path }))),
    )
  }, [customFonts, phase])

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
      onKeyDown: (event) => handleReaderKeyRef.current(event),
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
        setBookLanguage(metadata.language)
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
          for (const record of restored.annotations.filter((a) => !a.deleted)) {
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
    if (openPanel !== 'ai') return
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
  }, [openPanel])

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      // 浏览器模式退化为 Fullscreen API,dev 下也能验证视觉。
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen().catch(() => {})
      return
    }
    const tauriWindow = getCurrentWindow()
    const next = !(await tauriWindow.isFullscreen())
    await tauriWindow.setFullscreen(next)
    setFullscreen(next)
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void getCurrentWindow()
      .listen('tauri://resize', async () => {
        setFullscreen(await getCurrentWindow().isFullscreen())
      })
      .then((fn) => {
        unlisten = fn
      })
    return () => unlisten?.()
  }, [])

  // 点空白处关闭当前面板:面板/顶栏/底栏之外的按下即收起,不打断书内交互。
  useEffect(() => {
    if (openPanel === null) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          '.reader-top,.reader-bottom,.reader-toc,.reader-settings,.reader-display,.ai-drawer,.selection-toolbar,.lookup-card,.repair-panel,.page-flip,.dropdown-menu,.reader-theme-row,.tts-mini',
        )
      )
        return
      setOpenPanel(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [openPanel])

  /** 夜间一键切换:记住亮色主题,再点返回;背景细选仍走排版设置。 */
  const toggleNightTheme = useCallback((): void => {
    const nightIndex = READER_THEMES.findIndex(
      (option) => option.theme.colorScheme === 'dark',
    )
    if (themeIndex === nightIndex) {
      const restore = lastLightIndexRef.current ?? 0
      setThemeIndex(restore)
      void adapterRef.current?.setTheme(READER_THEMES[restore]?.theme ?? READER_THEMES[0]!.theme)
    } else {
      lastLightIndexRef.current = themeIndex
      setThemeIndex(nightIndex === -1 ? 0 : nightIndex)
      void adapterRef.current?.setTheme(
        (nightIndex === -1 ? READER_THEMES[0] : READER_THEMES[nightIndex])?.theme ??
          READER_THEMES[0]!.theme,
      )
    }
  }, [themeIndex])

  const showChrome = useCallback(() => {
    setChromeVisible(true)
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = setTimeout(() => {
      if (!overlayOpenRef.current) setChromeVisible(false)
    }, CHROME_TIMEOUT_MS)
  }, [])

  /** 带方向感的翻页反馈:动画类上屏后再执行内核翻页,新内容带着
   *  过渡进来——先翻后播会像没动画。 */
  const turnPage = useCallback(
    async (dir: 'next' | 'prev'): Promise<void> => {
      const adapter = adapterRef.current
      if (!adapter) return
      setTurnDir(dir)
      try {
        // 双 rAF:确保 React 已把动画 class 写入 DOM 并开始播放。
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        if (dir === 'next') await adapter.nextPage()
        else await adapter.previousPage()
      } finally {
        setTimeout(() => setTurnDir(null), 320)
      }
      showChrome()
    },
    [showChrome],
  )

  useEffect(() => {
    const onPointerMove = (): void => showChrome()
    window.addEventListener('pointermove', onPointerMove)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
    }
  }, [showChrome])

  // 方向键切页:window 与书内 iframe 两个入口共用同一处理。
  const handleReaderKey = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key === 'F11' || (event.key === 'f' && event.ctrlKey && event.metaKey)) {
        event.preventDefault()
        void toggleFullscreen()
        return
      }
      const adapter = adapterRef.current
      if (!adapter) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        void turnPage('next')
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        void turnPage('prev')
      } else if (event.key === 'Escape') {
        setOpenPanel(null)
        setSelection(null)
        setActiveAnnotation(null)
      }
    },
    [turnPage],
  )

  useEffect(() => {
    handleReaderKeyRef.current = handleReaderKey
    window.addEventListener('keydown', handleReaderKey)
    return () => window.removeEventListener('keydown', handleReaderKey)
  }, [handleReaderKey])

  const updateLayout = (patch: {
    viewMode?: ViewMode
    fontSize?: number
    lineHeight?: number | undefined
    fontFamily?: string | undefined
  }): void => {
    // `in` checks, not ?? merges: an explicit undefined means "reset to the
    // book's own typography" and must win over the previous setting.
    const next = {
      viewMode: patch.viewMode ?? viewMode,
      fontSize: patch.fontSize ?? fontSize,
      lineHeight: 'lineHeight' in patch ? patch.lineHeight : lineHeight,
      fontFamily: 'fontFamily' in patch ? patch.fontFamily : fontFamily,
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
    setOpenPanel(null)
    setSelection(null)
    setActiveAnnotation(null)
  }, [])

  const goToTocItem = (item: TocItem): void => {
    void adapterRef.current?.goTo({
      ...(item.href !== undefined ? { href: item.href } : {}),
      progress: 0,
    })
    setOpenPanel(null)
  }

  /** TTS 听书:当前 section 的纯文本(朗读起点为章首)。 */
  const ttsGetSectionText = useCallback(async (): Promise<string> => {
    const adapter = adapterRef.current
    if (!adapter) return ''
    return adapter.getSectionText(sectionIndexRef.current)
  }, [])

  /** TTS 听书:按 ±1 跳转章节;越界返回 false。 */
  const ttsJumpSection = useCallback(async (delta: number): Promise<boolean> => {
    const adapter = adapterRef.current
    if (!adapter) return false
    const count = await adapter.getSectionCount()
    const next = sectionIndexRef.current + delta
    if (next < 0 || next >= count) return false
    await adapter.goToSection(next)
    sectionIndexRef.current = next
    return true
  }, [])

  // 当前章字数:切章时后台取一次纯文本计数(与 TTS 同一数据面,廉价)。
  useEffect(() => {
    if (phase !== 'reading') return
    let cancelled = false
    void adapterRef.current
      ?.getSectionText(sectionIndexRef.current)
      .then((text) => {
        if (cancelled) return
        setSectionChars(countChars(text))
      })
      .catch(() => {
        if (!cancelled) setSectionChars(null)
      })
    return () => {
      cancelled = true
    }
  }, [phase, progress.location?.current])

  const addHighlight = async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter || selection === null) return
    const record: AnnotationRecord = {
      id: crypto.randomUUID(),
      cfi: selection.cfi,
      color: HIGHLIGHT_COLOR,
      excerpt: selection.text.slice(0, 500),
      updatedAt: new Date().toISOString(),
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
    // Keep a tombstone so other devices never resurrect this annotation.
    setAnnotations((current) =>
      current.map((a) =>
        a.id === record.id ? { ...a, deleted: true, updatedAt: new Date().toISOString() } : a,
      ),
    )
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

  const importReadingFont = useCallback(async (): Promise<void> => {
    const path = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    })
    if (!path) return
    setFontBusy(true)
    try {
      await invokeCommand('fonts.import', { path })
      const fonts = await invokeCommand('fonts.list', undefined)
      setCustomFonts(fonts)
      const imported = fonts[fonts.length - 1]
      if (imported) updateLayout({ fontFamily: imported.name })
    } catch (fontError) {
      setPanelProblem(toAppError(fontError).message ?? null)
    } finally {
      setFontBusy(false)
    }
  }, [])

  const removeReadingFont = useCallback(
    async (name: string): Promise<void> => {
      const target = customFonts.find((font) => font.name === name)
      if (!target) return
      try {
        await invokeCommand('fonts.remove', { id: target.id })
        const fonts = await invokeCommand('fonts.list', undefined)
        setCustomFonts(fonts)
        if (fontFamily === name) updateLayout({ fontFamily: undefined })
      } catch (fontError) {
        setPanelProblem(toAppError(fontError).message ?? null)
      }
    },
    [customFonts, fontFamily],
  )

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
      setBookmarks((list) => list.map((b) => (b.id === existing.id ? { ...b, deleted: true } : b)))
    } else {
      setBookmarks((list) => [
        ...list,
        { id: crypto.randomUUID(), cfi: current.cfi, createdAt: new Date().toISOString() },
      ])
    }
    scheduleSave()
  }

  const removeBookmark = (id: string): void => {
    setBookmarks((list) => list.map((b) => (b.id === id ? { ...b, deleted: true } : b)))
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
  const liveBookmarks = bookmarks.filter((b) => !b.deleted)
  const bookmarkedHere = progress.cfi !== null && liveBookmarks.some((b) => b.cfi === progress.cfi)

  // 页码 / 字数 / 预计剩余阅读时间。时间按语言取每页平均用时估算,标注"约"。
  const readingStats = useMemo(() => {
    const location = progress.location
    const pages =
      location && location.total > 0
        ? { current: location.current, total: location.total }
        : null
    const isCjk = bookLanguage === undefined || /^[a-z]{2,3}[-_]?/i.exec(bookLanguage) === null
    let timeLabel: string | null = null
    if (pages && progress.fraction > 0) {
      const secondsPerPage = isCjk ? 90 : 45
      const remainingMinutes = Math.max(
        1,
        Math.round(((1 - progress.fraction) * pages.total * secondsPerPage) / 60),
      )
      timeLabel = remainingMinutes >= 60 ? '约 1 小时+' : `约剩 ${remainingMinutes} 分钟`
    }
    return {
      page: pages ? `${pages.current} / ${pages.total} 页` : null,
      chars: sectionChars !== null ? `本章 ${sectionChars.toLocaleString('zh-Hans-CN')} 字` : null,
      time: timeLabel,
    }
  }, [progress.location, progress.fraction, bookLanguage, sectionChars])

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
      className="reader-scope"
      style={
        {
          '--reader-bg': theme.theme.background,
          '--reader-fg': theme.theme.foreground,
          '--reader-panel': withAlpha(theme.theme.background, 0.86),
          '--reader-panel-solid': theme.theme.background,
        } as React.CSSProperties
      }
    >
    <div
      className={`reader${chromeVisible || openPanel !== null ? ' chrome-visible' : ''}${ttsActive && ttsMinimized ? ' tts-mini-active' : ''}`}
      onPointerDown={() => showChrome()}
    >
      <div
        ref={hostRef}
        className={`reader-host page-turn-${pageTurnStyle}${turnDir ? ` turn-${turnDir}` : ''}`}
      />

      {/* 左右悬浮翻页钮:贴近边缘悬停时浮现。 */}
      <button
        type="button"
        className="page-flip page-flip-left"
        onClick={() => void turnPage('prev')}
        title="上一页"
        aria-label="上一页"
      >
        <CaretLeft size={20} weight="bold" aria-hidden />
      </button>
      <button
        type="button"
        className="page-flip page-flip-right"
        onClick={() => void turnPage('next')}
        title="下一页"
        aria-label="下一页"
      >
        <CaretRight size={20} weight="bold" aria-hidden />
      </button>

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
          className={`chrome-button${theme.theme.colorScheme === 'dark' ? ' is-active' : ''}`}
          onClick={toggleNightTheme}
          title={`阅读背景:点击切换夜间(当前 ${theme.label},在排版设置中可选)`}
        >
          {theme.theme.colorScheme === 'dark' ? (
            <Moon size={18} weight="regular" aria-hidden />
          ) : (
            <Sun size={18} weight="regular" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className={`chrome-button${fullscreen ? ' is-active' : ''}`}
          onClick={() => void toggleFullscreen()}
          title="全屏阅读(F11 / Ctrl+⌘+F)"
        >
          <CornersOut size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${openPanel === 'settings' ? ' is-active' : ''}`}
          onClick={() => setOpenPanel((panel) => (panel === 'settings' ? null : 'settings'))}
          title="排版设置"
        >
          <TextAa size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${openPanel === 'display' ? ' is-active' : ''}`}
          onClick={() =>
            setOpenPanel((panel) => (panel === 'display' ? null : 'display'))
          }
          title="显示设置"
        >
          <SlidersHorizontal size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${openPanel === 'ai' ? ' is-active' : ''}`}
          onClick={() =>
            setOpenPanel((panel) => (panel === 'ai' ? null : 'ai'))
          }
          title="AI 助手"
        >
          <Sparkle size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${openPanel === 'tts' ? ' is-active' : ''}`}
          onClick={() =>
            setOpenPanel((panel) => (panel === 'tts' ? null : 'tts'))
          }
          title="朗读 / 听书"
        >
          <Headphones size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className={`chrome-button${openPanel === 'learning' ? ' is-active' : ''}`}
          onClick={() =>
            setOpenPanel((panel) => (panel === 'learning' ? null : 'learning'))
          }
          title="学习(卡片 / 测验 / 错题本)"
        >
          <GraduationCap size={18} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className="chrome-button"
          onClick={() => {
            setOpenPanel((panel) => (panel === 'toc' ? null : 'toc'))
            setChromeVisible(true)
          }}
          title="目录与搜索"
        >
          <List size={18} weight="regular" aria-hidden />
        </button>
      </header>

      {openPanel === 'settings' && (
        <section className="reader-settings" aria-label="排版设置">
          <div className="settings-column">
            <span className="settings-label">阅读背景</span>
            <div className="reader-theme-row">
              {READER_THEMES.map((option, index) => (
                <button
                  key={option.label}
                  type="button"
                  className={`reader-theme-swatch${themeIndex === index ? ' is-active' : ''}`}
                  style={{
                    background: option.theme.background,
                    color: option.theme.foreground,
                  }}
                  onClick={() => {
                    setThemeIndex(index)
                    void adapterRef.current?.setTheme(option.theme)
                  }}
                  aria-pressed={themeIndex === index}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
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
          <div className="settings-column">
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
              {customFonts.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  className={fontFamily === font.name ? 'is-active' : ''}
                  onClick={() => updateLayout({ fontFamily: font.name })}
                  title={`${font.name}(点按使用;长按列表删除)`}
                >
                  {font.name.length > 6 ? `${font.name.slice(0, 5)}…` : font.name}
                </button>
              ))}
            </div>
            <div className="font-custom-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void importReadingFont()}
                disabled={fontBusy}
              >
                <Plus size={13} weight="bold" aria-hidden />
                {fontBusy ? '导入中…' : '导入字体'}
              </button>
              {fontFamily !== undefined &&
                !FONT_FAMILY_OPTIONS.some((option) => option.value === fontFamily) && (
                  <button
                    type="button"
                    className="btn btn-ghost font-remove"
                    onClick={() => void removeReadingFont(fontFamily)}
                    title="删除当前使用的自定义字体"
                  >
                    <Trash size={13} aria-hidden /> 删除当前字体
                  </button>
                )}
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
        </section>
      )}

      {openPanel === 'display' && (
        <section className="reader-settings reader-display" aria-label="显示设置">
          <div className="settings-column">
            <span className="settings-label">显示</span>
            <div className="stats-toggles">
              {(
                [
                  { key: 'progress', label: '进度条与页码' },
                  { key: 'words', label: '字数' },
                  { key: 'time', label: '预计时间' },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`stats-toggle${statsSettings[item.key] ? ' is-on' : ''}`}
                  role="switch"
                  aria-checked={statsSettings[item.key]}
                  onClick={() => {
                    setStatsSettings((current) => {
                      const next = { ...current, [item.key]: !current[item.key] }
                      localStorage.setItem('deepread.reader.stats', JSON.stringify(next))
                      return next
                    })
                  }}
                >
                  <span className="stats-toggle-label">{item.label}</span>
                  <span className="stats-toggle-track" aria-hidden>
                    <span className="stats-toggle-thumb" />
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings-column">
            <span className="settings-label">翻页动画</span>
            <div className="segmented">
              {(
                [
                  { key: 'slide', label: '滑动' },
                  { key: 'cover', label: '覆盖' },
                  { key: 'flip', label: '仿真' },
                  { key: 'fade', label: '淡入' },
                ] as const
              ).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={pageTurnStyle === option.key ? 'is-active' : ''}
                  onClick={() => {
                    setPageTurnStyle(option.key)
                    localStorage.setItem('deepread.reader.pageTurn', option.key)
                  }}
                >
                  {option.label}
                </button>
              ))}
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
          <p className="ai-privacy">关闭进度条后,底部工具栏整体隐藏,阅读更沉浸。</p>
        </section>
      )}

      {openPanel === 'toc' && (
        <nav className="reader-toc" aria-label="目录与搜索">
          <div className="reader-toc-head">
            <span>目录</span>
            <button
              type="button"
              className="chrome-button"
              onClick={() => setOpenPanel(null)}
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

          {liveBookmarks.length > 0 && <p className="reader-section-label">书签</p>}
          {liveBookmarks.map((bookmark) => (
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

          {toc.length === 0 && searchResults.length === 0 && liveBookmarks.length === 0 ? (
            <p className="reader-toc-empty">这本书没有目录信息。</p>
          ) : (
            renderTocItems(toc, 0)
          )}
        </nav>
      )}

      {statsSettings.progress && (
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
        <span className="reader-arrow" aria-hidden>
          <ArrowLeft size={14} weight="regular" />
        </span>
        <span className="reader-arrow" aria-hidden>
          <ArrowRight size={14} weight="regular" />
        </span>
        {statsSettings.words && readingStats.chars && (
          <span className="reader-percent">{readingStats.chars}</span>
        )}
        {statsSettings.time && readingStats.time && (
          <span className="reader-percent">{readingStats.time}</span>
        )}
        {statsSettings.progress && readingStats.page && (
          <span className="reader-percent reader-percent-strong">{readingStats.page}</span>
        )}
      </footer>
      )}

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

      {openPanel === 'ai' && (
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
          onClose={() => setOpenPanel(null)}
        />
      )}

      {(openPanel === 'tts' || ttsActive) && (
        <TtsDrawer
          bookHash={book.hash}
          bookTitle={title}
          bookLanguage={bookLanguage}
          coverUrl={ttsCoverUrl}
          sectionLabel={sectionLabel}
          minimized={ttsMinimized || openPanel !== 'tts'}
          onPlayingChange={setTtsActive}
          getSectionText={ttsGetSectionText}
          jumpSection={ttsJumpSection}
          onExpand={() => {
            setTtsMinimized(false)
            setOpenPanel('tts')
          }}
          onMinimize={() => setTtsMinimized(true)}
          onClose={() => {
            setOpenPanel((panel) => (panel === 'tts' ? null : panel))
            setTtsMinimized(false)
          }}
        />
      )}

      {openPanel === 'learning' && (
        <LearningDrawer
          bookHash={book.hash}
          bookTitle={title}
          annotations={annotations}
          getChapterText={ttsGetSectionText}
          onClose={() => setOpenPanel(null)}
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
    </div>
  )
}

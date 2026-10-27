import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  Columns,
  Copy,
  CornersOut,
  GraduationCap,
  Headphones,
  List,
  MagnifyingGlass,
  Minus,
  Moon,
  PencilSimple,
  Plus,
  Ruler,
  SlidersHorizontal,
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
  type AiProviderConfig,
  type AnnotationRecord,
  type BookmarkRecord,
  type DictionaryMeta,
  type ReadingFont,
} from '@deepread/shared'
import type {
  AnnotationStyle,
  ReaderLayout,
  TocItem,
  ZhConvertVariant,
} from '@deepread/reader-core'
import { localDayKey } from '@deepread/shared'
import { countChars } from '@deepread/reader-core'
import {
  applyRepair,
  buildIndex,
  chapterSections,
  extractCover,
  FoliateAdapter,
  isFixedLayoutFormat,
  reviewRepair,
  inflateGzip,
  lookupWord,
  sanitizeDefinitionHtml,
  type DefinitionField,
  type EngineCallbacks,
  type EngineSelection,
} from '@deepread/reader-adapter'
import type { RepairChange } from '@deepread/reader-adapter'
import {
  createSseParser,
  extractDelta,
  buildChapterRuleMessages,
  buildTranslateMessages,
  parseChapterRuleCandidates,
  parseTranslation,
  streamTranslationView,
  TRANSLATE_MAX_CHARS,
  type ChapterRule,
  type ChapterRuleCandidate,
} from '@deepread/ai-core'
import { invokeCommand, invokeStreamingCommand, isTauriRuntime } from '../../lib/ipc'
import {
  buildFontFacesCss,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_DEFAULT,
  FONT_SIZES,
  FONT_STACK_PREVIEW,
  FONT_WEIGHT_OPTIONS,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_PALETTE,
  layoutOverrides,
  LINE_HEIGHT_OPTIONS,
  loadPageTurnStyle,
  loadRulerSettings,
  loadStatsSettings,
  loadTypography,
  materializeCustomDefaults,
  mergeTypography,
  PAGE_MARGIN_BLOCK_DEFAULT,
  PAGE_MARGIN_BLOCK_OPTIONS,
  PAGE_MARGIN_INLINE_DEFAULT,
  PAGE_MARGIN_INLINE_OPTIONS,
  PAGE_TURN_OPTIONS,
  PARAGRAPH_MARGIN_OPTIONS,
  persistPageTurnStyle,
  persistRulerSettings,
  persistStatsSettings,
  persistTypography,
  loadTranslateTarget,
  persistTranslateTarget,
  READER_THEMES,
  RULER_DIM_OPTIONS,
  RULER_FOCUS_LINES,
  TEXT_INDENT_OPTIONS,
  TRANSLATE_TARGETS,
  VIEW_MODE_OPTIONS,
  WRITING_MODE_OPTIONS,
  ZH_CONVERT_OPTIONS,
  withAlpha,
  type PageTurnStyle,
  type ReadingRulerSettings,
  type StatsSettings,
  type TypographySettings,
  type ViewMode,
  type WritingModeChoice,
} from './reader-options'
import { buildReadingStats } from './reading-indicators'
import { isEditableTarget, readerKeyAction } from './reader-keys'
import { reportReadingTime } from '../../lib/reading-stats'
import { DropdownMenu } from '../../components/DropdownMenu'
import { AiDrawer } from './AiDrawer'
import { newTaskId } from '../../lib/ai-chat'
import { ChapterRulesPanel } from './ChapterRulesPanel'
import { LearningDrawer } from './LearningDrawer'
import { SelectionToolbar } from './SelectionToolbar'
import { ParallelPicker } from './ParallelPicker'
import { Segmented } from './Segmented'
import {
  anchorFromRect,
  placeCompanionCard,
  windowFrame,
  type ReadingFrame,
} from './selection-place'
import { animateFlipTurn } from './page-flip'
import { animatePageTurn } from './page-turn'
import { TtsDrawer, type TtsDrawerHandle } from './TtsDrawer'
import { primeTtsAudio } from './tts/audio'
import type { OpenedBook } from '../../lib/book-import'

const CHROME_TIMEOUT_MS = 2500
/**
 * 翻页期间(含片尾)不唤起 chrome 的窗口。
 *
 * 最长的一档动画是「覆盖」= 240ms 退场 + 340ms 进场;余量留给 WebKit 在
 * 内容位移后继续补发的那几个 pointermove(见 showChrome 的注释)。
 */
const TURN_WAKE_SUPPRESS_MS = 900
const SAVE_DEBOUNCE_MS = 800
const MAX_SHOWN_SEARCH_RESULTS = 50
/** 与 `reader.note.update` 的上限对齐(shared 协议里那条 zod)。 */
const NOTE_MAX_CHARS = 4000
const EXCERPT_MAX_CHARS = 500
/** 翻译卡的估计高度:算避让位置用(卡片 max-height 420,流式中会变)。 */
const TRANSLATE_CARD_HEIGHT = 300
/** 词典卡的估计高度(max-height 300),同用于避让工具条。 */
const LOOKUP_CARD_HEIGHT = 280

/**
 * 偏好 → 内核版式对象(开书初值 / 偏好下发 / 改动下发三处共用)。
 *
 * 版式(flow / pageMode)、字号与两把边距任何时候都下发 —— 那是读者的阅读
 * 舒适度;行距、段间距一类的**书自己的排版**先看总开关(见
 * `layoutOverrides`):原书排版开着的默认值下,它们一律 undefined,内核因此
 * 保留书里原有的值。三处各写一遍是「某一处漏掉默认值 → 偏偏那个入口表现不
 * 一样」这种 bug 的固定来源,所以收成一个入口。
 */
function readerLayout(settings: TypographySettings): ReaderLayout {
  return {
    flow: settings.viewMode === 'scroll' ? 'scrolled' : 'paginated',
    pageMode: settings.viewMode === 'dual' ? 'dual' : 'single',
    fontSize: settings.fontSize ?? FONT_SIZE_DEFAULT,
    margin: settings.pageMarginBlock ?? PAGE_MARGIN_BLOCK_DEFAULT,
    marginInline: settings.pageMargin ?? PAGE_MARGIN_INLINE_DEFAULT,
    ...layoutOverrides(settings),
  }
}

/**
 * 并行阅读时宿主塞给一栏的桥接。
 *
 * 一栏自己不知道对面存在 —— 它只管「我是不是活动栏」「对面要我跳到哪」
 * 「我位置变了」,对位关系全部由 ParallelReader 持有。这样单本阅读时这个
 * 桥接就是 undefined,组件里所有并行相关的分支都退化成空操作。
 */
export interface PaneBridge {
  /** 活动栏:只有它能响应键盘。非活动栏的 chrome 由 CSS 收起。 */
  readonly active: boolean
  /** 用户在这一栏上按下(任何地方):切活动栏。 */
  readonly onActivate: () => void
  /** 对面要求本栏跳到这个进度(按全书比例)。`nonce` 区分「哪一次请求」。 */
  readonly sync?: { readonly fraction: number; readonly nonce: number } | undefined
  /** 本栏位置变了 —— 宿主持它去驱动对面。`cfi` 也带上:关掉对照时要能
   *  立刻回到这一页,而不靠「刚写的进度是否比重新打开更快落地」这种赛跑。 */
  readonly onRelocate?: ((fraction: number, cfi: string | undefined) => void) | undefined
}

interface ReaderScreenProps {
  readonly book: OpenedBook
  /**
   * 返回书架。`ttsPlaying` = TTS 仍在播(含暂停):宿主应隐藏而不是卸载,
   * 让听书跨屏继续;没有在播就正常卸载收内存。
   */
  readonly onBack: (ttsPlaying: boolean) => void
  /** 阅读器被宿主隐藏(退到书架但听书继续)时为 true。 */
  readonly hidden?: boolean
  /** 隐藏期间用户点迷你条「展开」:请宿主切回阅读器。 */
  readonly onRequestShow?: () => void
  /** 并行阅读:本栏的桥接;单本阅读时不传。 */
  readonly pane?: PaneBridge
  /** 顶栏「对照阅读」选定第二本书:请宿主并排打开。 */
  readonly onOpenParallel?: ((other: OpenedBook) => void) | undefined
}

type Phase = 'opening' | 'reading' | 'error'

/** 同一时刻只开一个浮层:它们共用顶栏按钮的激活态与「点空白关闭」逻辑。 */
type OpenPanel = 'toc' | 'settings' | 'display' | 'ai' | 'tts' | 'learning' | 'parallel'

/**
 * 正在编辑的批注笔记。`id` 缺失 = 这条笔记还没有对应的划线,提交时新建;
 * 有 `id` = 改已有批注的 note 字段(空串 = 清回纯高亮)。
 */
interface NoteDraft {
  readonly id?: string
  readonly cfi: string
  readonly excerpt: string
  readonly color: string
  readonly style: AnnotationStyle
  readonly note: string
}

/**
 * CFI 的前两段标识它所在的那个 spine 项 —— 同一次 `getCFI(index, …)` 产出的
 * CFI 共享这个前缀(epubcfi(/6/4…)),所以它可以当"章节键"用,不必再问内核。
 * 解析不出来就返回 null(比如某些非 EPUB 的大段落),调用方退回"全书"。
 */
/**
 * 按章节 label 在目录里找一项(跨书搜索正文命中定位用)。先精确匹配,
 * 再容忍首尾空白 —— 目录标题常带不可见空格,而 label 来自 RAG chunk。
 */
function findTocItem(items: readonly TocItem[], label: string): TocItem | null {
  const want = label.trim()
  for (const item of items) {
    if (item.title.trim() === want) return item
    const nested = findTocItem(item.children, want)
    if (nested !== null) return nested
  }
  return null
}

function cfiChapter(cfi: string): string | null {
  const match = /epubcfi\(\/(\d+)\/(\d+)/.exec(cfi)
  return match === null ? null : `${match[1]}/${match[2]}`
}

function toDomainAnnotation(record: AnnotationRecord, bookId: string) {
  const now = new Date().toISOString()
  return {
    ...record,
    // wire 的 note 是 string | null(生成类型);领域模型用 undefined 表示「没有」。
    note: record.note ?? undefined,
    // style 在 wire 上是裸 String(Rust 只校验形状),这里收口成三态联合 ——
    // 预 v8 的行和手写请求带来的怪值按背景高亮走,渲染层同一约定。
    style: toAnnotationStyle(record.style),
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

/** wire 的 style 字符串 → 领域三态。非法值一律 highlight(与 Rust / zod 同约定)。 */
function toAnnotationStyle(style: string | undefined): AnnotationStyle {
  return style === 'underline' || style === 'squiggly' ? style : 'highlight'
}

const ttsCoverCache = new Map<string, string>()

export function ReaderScreen({
  book,
  onBack,
  hidden = false,
  onRequestShow,
  pane,
  onOpenParallel,
}: ReaderScreenProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<FoliateAdapter | null>(null)
  const callbacksRef = useRef<EngineCallbacks>({})
  const handleReaderKeyRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 最近一次指针活动的时刻:chrome 自动隐藏以它为基准。 */
  const lastChromeActivityRef = useRef(0)
  /** 翻页期间(含片尾)不唤起 chrome 的截止时刻(见 showChrome)。 */
  const turnWakeUntilRef = useRef(0)
  /** chrome 显隐函数的 ref:内核回调(constant closure)经它调用最新版本。 */
  const showChromeRef = useRef<() => void>(() => {})
  /** 并排阅读的「激活我」:adapter 挂载时一次建成,回调要走 ref 才能拿到当次渲染的 pane。 */
  const paneActivateRef = useRef<(() => void) | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  /** 浏览器端导入阅读字体的文件选择器(桌面端走 openFileDialog)。 */
  const fontInputRef = useRef<HTMLInputElement>(null)
  const progressRef = useRef<{ cfi: string; fraction: number } | null>(null)
  const annotationsRef = useRef<readonly AnnotationRecord[]>([])
  const bookmarksRef = useRef<readonly BookmarkRecord[]>([])
  const openPanelRef = useRef<OpenPanel | null>(null)
  const storedTypography = loadTypography()
  /**
   * 滚动形态只对可重排书籍与 PDF 存在(见 reader-adapter 的 isFixedLayoutFormat):
   * CBZ 等固定排版没有可预排的页尺寸,「滚动」档对它们是空操作。存量的
   * 「滚动」偏好在这类书上按单页起 —— 否则 UI 勾着滚动、画面却既不动也没
   * 翻页动画。只改内存里的档位,不写回用户的全局偏好(换本书就恢复)。
   */
  const scrollModeSupported = book.format === 'pdf' || !isFixedLayoutFormat(book.format)
  const initialViewMode: ViewMode =
    storedTypography.viewMode === 'scroll' && !scrollModeSupported
      ? 'single'
      : (storedTypography.viewMode ?? 'single')
  const settingsRef = useRef<TypographySettings>({
    originalLayout: storedTypography.originalLayout ?? true,
    viewMode: initialViewMode,
    fontSize: storedTypography.fontSize,
    lineHeight: storedTypography.lineHeight,
    fontFamily: storedTypography.fontFamily,
    fontWeight: storedTypography.fontWeight,
    themeIndex: storedTypography.themeIndex ?? 0,
    pageMargin: storedTypography.pageMargin ?? PAGE_MARGIN_INLINE_DEFAULT,
    pageMarginBlock: storedTypography.pageMarginBlock ?? PAGE_MARGIN_BLOCK_DEFAULT,
    paragraphMargin: storedTypography.paragraphMargin,
    textIndent: storedTypography.textIndent,
    writingMode: storedTypography.writingMode,
    zhConvert: storedTypography.zhConvert ?? ('none' as ZhConvertVariant),
  })
  /** True while the progress slider is being dragged or key-stepped. */
  const scrubbingRef = useRef(false)
  /**
   * 开书流程(恢复批次位置)走完之前,内核报的 relocate 是「程序在摆位置」,
   * 不是用户翻页 —— 并行阅读不能拿它去拽对面那一栏,否则一开书两本就被强行
   * 对到同一进度。
   */
  const readyRef = useRef(false)
  /**
   * ready 之后的第一条上报仍然要跳过:恢复进度是异步的,它的 relocate 常常
   * 晚于 ready 才到(见 onRelocate 里的联动门)。只跳过一条 —— 重渲染的重复
   * 上报即使漏过去,拖动的也是同一个位置,视觉上是空操作。
   */
  const openingReportSkippedRef = useRef(false)
  /** 已经执行过的联动请求编号;重复渲染不该重复跳。 */
  const appliedSyncRef = useRef(0)
  /**
   * 本栏是否是活动栏。单本阅读时 undefined(不是"非活动"),键盘门控要按
   * `=== false` 判,不能用取反 —— 否则单本模式会退出所有快捷键。
   */
  const paneActive = pane?.active

  const [phase, setPhase] = useState<Phase>('opening')
  const [error, setError] = useState<string | null>(null)
  /** Transient toast (rebuild/repair results); the error channel is fatal-only. */
  const [notice, setNotice] = useState<{ text: string; danger: boolean } | null>(null)
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
  /** 编辑模式划词工具的锚点:划线的实测选区框。点中的是已有划线时没有
   *  伴随选区可问,不测一个工具条就会落在 (0,0)(左上角)。 */
  const [activeAnnotationRect, setActiveAnnotationRect] = useState<{
    readonly top: number
    readonly left: number
    readonly height: number
  } | null>(null)
  /** 读者上次用的墨水:新选区画得可预期,不用每次重挑。 */
  const [lastInk, setLastInk] = useState<{ color: string; style: AnnotationStyle }>({
    color: HIGHLIGHT_COLOR,
    style: 'highlight',
  })
  const [annotations, setAnnotations] = useState<readonly AnnotationRecord[]>([])
  const [bookmarks, setBookmarks] = useState<readonly BookmarkRecord[]>([])
  /**
   * 排版与版式的单一状态面:过去是 11 个独立 useState,又在 settingsRef
   * effect 与 updateLayout 里手工拼装同步 —— 收拢为一个对象,唯一变更入口
   * 是 updateLayout(patch)(合并语义见 reader-options 的 mergeTypography,
   * 显式 undefined = 复位到原书排版)。themeIndex(即时换色)与
   * zhConvert(切档重开书)生命周期不同,仍是独立 state。
   */
  const [typography, setTypography] = useState<TypographySettings>(() => ({
    originalLayout: storedTypography.originalLayout ?? true,
    viewMode: initialViewMode,
    /** undefined = 读者还没动过(切到自定义排版时才会落到 18px,见
        `materializeCustomDefaults`);面板显示与下发仍按 16 兜底。 */
    fontSize: storedTypography.fontSize,
    lineHeight: storedTypography.lineHeight,
    fontFamily: storedTypography.fontFamily,
    /**
     * 页边距 · 左右(px)。内核没有横向边距属性,这一路由栏宽上限模拟(见
     * reader-adapter 的 #maxInlineSize):数字越大留白越宽、栏越窄。
     */
    pageMargin: storedTypography.pageMargin ?? PAGE_MARGIN_INLINE_DEFAULT,
    /** 页边距 · 上下(px):直接是 paginator 的 margin 属性。 */
    pageMarginBlock: storedTypography.pageMarginBlock ?? PAGE_MARGIN_BLOCK_DEFAULT,
    paragraphMargin: storedTypography.paragraphMargin,
    textIndent: storedTypography.textIndent,
    fontWeight: storedTypography.fontWeight,
    writingMode: storedTypography.writingMode,
  }))
  const [zhConvert, setZhConvert] = useState<ZhConvertVariant>(
    () => storedTypography.zhConvert ?? 'none',
  )
  const [themeIndex, setThemeIndex] = useState(() => storedTypography.themeIndex ?? 0)
  const [rulerSettings, setRulerSettings] = useState<ReadingRulerSettings>(loadRulerSettings)
  /**
   * 阅读尺只吃可重排的横排正文:固定排版(PDF/CBZ)的「行」是画布上的影子
   * 文本层,量不出行盒;竖排的「行」是竖列,蒙版要整块换轴。两档不给入口,
   * 免得用户开了只看见一块歪掉的暗区。
   */
  const rulerSupported =
    !isFixedLayoutFormat(book.format) && typography.writingMode !== 'vertical-rl'
  const rulerActive = rulerSupported && rulerSettings.enabled
  const [searchResults, setSearchResults] = useState<readonly { cfi: string; excerpt: string }[]>(
    [],
  )
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle')
  /** 命中数超过展示上限:必须说清楚,否则用户以为搜索不全。 */
  const [searchTruncated, setSearchTruncated] = useState(false)
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
  // 阅读器的面板互斥:同一时刻最多一个浮层(目录/排版/AI/朗读/学习/对照)。
  const [openPanel, setOpenPanel] = useState<OpenPanel | null>(null)
  const [bookLanguage, setBookLanguage] = useState<string | undefined>(undefined)
  const [sectionLabel, setSectionLabel] = useState<string | null>(null)
  const [ttsMinimized, setTtsMinimized] = useState(false)
  const [ttsActive, setTtsActive] = useState(false)
  /**
   * TTS 会话开关:从「朗读此处」到真正出声之间有个 idle 间隙(取章节文本 +
   * 合成请求都还没回来,ttsActive 仍为 false),只靠 ttsActive 挂载抽屉会在
   * 这个间隙把它卸掉 —— 起播闭包随卸载作废,用户看到「点了朗读没反应」。
   * 会话开启后只有停止并关闭(×)才熄灭。
   */
  const [ttsSession, setTtsSession] = useState(false)
  const ttsDrawerRef = useRef<TtsDrawerHandle>(null)
  /** 划词工具的「朗读此处」:选区文本 + 起点偏移等在这,等 TTS 抽屉挂载
   *  后起播。「开面板」和「起播」必须分两步 —— ref 在抽屉挂载前是 null。
   *  偏移来自内核(与章节文本同一坐标系),编辑模式没有选区时为 null。 */
  const [pendingSpeak, setPendingSpeak] = useState<{
    readonly text: string
    readonly start: number | null
  } | null>(null)
  /**
   * TTS 抽屉是否挂着(portal 到 body 的那一个)。三态任一为真即挂着:
   * 面板开着 / 在播(含暂停)/ 会话进行中(起播间隙)。
   * Escape 的归属看它:抽屉在时 Esc 归抽屉(收起成迷你条),
   * ReaderScreen 若也清 openPanel,抽屉连最小化那一帧都画不出来就被卸载。
   */
  const ttsMounted = openPanel === 'tts' || ttsActive || ttsSession
  /** mini 播放条(信息胶囊)此刻在场吗(会话活着、且没展开成完整面板)。
   *  与传给抽屉的 minimized 是同一个式子 —— 两者严格同帧。胶囊悬浮在
   *  底栏上方(见 global.css .tts-mini-float),不为它收缩或重排书页。 */
  const ttsMiniVisible = ttsMounted && (ttsMinimized || openPanel !== 'tts')
  const [ttsCoverUrl, setTtsCoverUrl] = useState<string | null>(
    () => ttsCoverCache.get(book.hash) ?? null,
  )
  /** 当前章字数(千分位在渲染层做);null = 还没算出来。 */
  const [sectionChars, setSectionChars] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  /** 全书正文统计(后台逐节统计;PDF 等固定排版为 null)。 */
  const [bookCharStats, setBookCharStats] = useState<{
    total: number
    cjk: number
  } | null>(null)
  /** 用户导入字体(fonts.list);变更后重建 @font-face 并重设引擎样式。 */
  const [customFonts, setCustomFonts] = useState<readonly ReadingFont[]>([])
  const [fontBusy, setFontBusy] = useState(false)
  /** 翻页动画:滑动/覆盖/仿真/淡入。 */
  const [pageTurnStyle, setPageTurnStyle] = useState<PageTurnStyle>(loadPageTurnStyle)
  const [statsSettings, setStatsSettings] = useState<StatsSettings>(loadStatsSettings)
  const sectionIndexRef = useRef(0)
  /** 本章字数请求的序号:乱序返回时丢弃过期结果。 */
  const charCountTokenRef = useRef(0)
  const lastLightIndexRef = useRef(0)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  /** 目录侧栏在「目录 / 批注」两个页签间切换;批注页签再按 本章/全书 过滤。 */
  const [tocTab, setTocTab] = useState<'toc' | 'annotations'>('toc')
  const [annotationScope, setAnnotationScope] = useState<'chapter' | 'book'>('book')
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  /** AI 服务列表:翻译要显示用的哪个 provider/model(成本诚实)。 */
  const [aiProviders, setAiProviders] = useState<readonly AiProviderConfig[]>([])
  /** 划选翻译的浮层状态;null = 没在翻译。 */
  const [translation, setTranslation] = useState<{
    readonly rect: { readonly top: number; readonly left: number }
    readonly lang: string | null
    readonly body: string
    readonly provider: string
    readonly truncated: boolean
    readonly error: string | null
    readonly loading: boolean
  } | null>(null)
  /** 目标语言:null = 没手动选过,跟着书的语言走(见 effectiveTranslateTarget)。 */
  const [translateTarget, setTranslateTarget] = useState<string | null>(loadTranslateTarget)
  /** 目标语言的实际取值:没手动选过时,中文书译英、其余译中。 */
  const effectiveTranslateTarget =
    translateTarget ?? (bookLanguage?.toLowerCase().startsWith('zh') ? 'English' : '中文')
  const [panelProblem, setPanelProblem] = useState<string | null>(null)
  /** 旧版 per-book 自定义正则(B7.2 之前的实现):给规则面板做一键导入用。 */
  const legacyChapterPattern =
    typeof localStorage === 'undefined'
      ? ''
      : (localStorage.getItem(`deepread.chapterPattern.${book.hash}`) ?? '')
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
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 内核回调(constant closure)需要读到最新的面板状态。
  useEffect(() => {
    openPanelRef.current = openPanel
  }, [openPanel])

  useEffect(() => {
    settingsRef.current = { ...typography, themeIndex, zhConvert }
  }, [typography, themeIndex, zhConvert])

  const saveNow = useCallback((): void => {
    void invokeCommand('reader.state.set', {
      bookHash: book.hash,
      state: {
        progress: progressRef.current,
        annotations: [...annotationsRef.current],
        bookmarks: [...bookmarksRef.current],
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
      // 卸载前把最后一段进度落盘(「关闭对照」会立刻换掉这一栏)。
      // 开书还没走完时不能写:那时 annotationsRef 还是空数组,一写就把
      // 已经存下的批注清空了 —— 所以按 readyRef 守一道。
      if (readyRef.current) flush()
    }
  }, [saveNow])

  /**
   * 当前章字数:后台取一次纯文本计数(与 TTS 同一数据面,廉价)。快速连翻
   * 时结果可能乱序,token 保证只采用最后一次请求。
   */
  const countSectionChars = useCallback((sectionIndex: number): void => {
    const token = charCountTokenRef.current + 1
    charCountTokenRef.current = token
    void adapterRef.current
      ?.getSectionText(sectionIndex)
      .then((text) => {
        if (token === charCountTokenRef.current) setSectionChars(countChars(text))
      })
      .catch(() => {
        if (token === charCountTokenRef.current) setSectionChars(null)
      })
  }, [])

  useEffect(() => {
    callbacksRef.current = {
      onRelocate: (location) => {
        if (
          location.sectionIndex !== undefined &&
          location.sectionIndex !== sectionIndexRef.current
        ) {
          void countSectionChars(location.sectionIndex)
        }
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
        // 并行阅读的联动:位置变了就报给宿主(由它决定要不要拽对面那一栏)。
        if (readyRef.current) {
          if (openingReportSkippedRef.current) {
            pane?.onRelocate?.(fraction, cfi)
          } else {
            // 开书后的第一次上报是恢复/初始位置:每本书都有自己的进度,联动它
            // 只会把对面那栏拽到本栏的开书位置上(实测:开书瞬间对面白跳一次)。
            // 用户翻页、拖进度、点目录产生的上报才该联动。
            openingReportSkippedRef.current = true
          }
        }
      },
      onSelection: (sel) => {
        // 书页内容在 iframe 里,父层收不到 pointerdown;任何书内交互都兼作
        // "点空白"——面板开着、工具条开着,这一下都先把它们收起。
        if (openPanelRef.current !== null) setOpenPanel(null)
        setActiveAnnotation(null)
        setSelection(sel)
        // 点按/翻页(空选区)不打扰 chrome 的显隐节奏;真正划选文本才唤起。
        if (sel !== null) showChromeRef.current()
      },
      onShowAnnotation: (cfi) => {
        setSelection(null)
        setActiveAnnotation(cfi)
        // 点中的是已有划线:没有伴随选区,锚点由内核把 CFI 解回 Range 现测。
        setActiveAnnotationRect(adapterRef.current?.rectOfAnnotation(cfi) ?? null)
        showChromeRef.current()
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
  // 两个平台同一条命令:桌面端读应用数据目录,浏览器端读 IndexedDB(fonts.list
  // 在 ipc 层被分流)。
  useEffect(() => {
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
    // 内核就绪前注入无效(adapter 还是 null),所以等进入阅读态再刷一次。
    if (phase !== 'reading') return
    void adapterRef.current?.setFontFaces(
      buildFontFacesCss(customFonts.map((font) => ({ name: font.name, path: font.path }))),
    )
  }, [customFonts, phase])

  useEffect(() => {
    invokeCommand('ai.config.list', undefined)
      .then((response) => setAiProviders(response?.providers ?? []))
      .catch(() => {
        // 没配 AI 服务时翻译按钮会说明原因,这里不打扰。
      })
  }, [])

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
    readyRef.current = false
    openingReportSkippedRef.current = false
    const adapter = new FoliateAdapter(hostRef.current ?? document.body, {
      onRelocate: (location) => callbacksRef.current.onRelocate?.(location),
      onSelection: (sel) => callbacksRef.current.onSelection?.(sel),
      onShowAnnotation: (cfi) => callbacksRef.current.onShowAnnotation?.(cfi),
      onKeyDown: (event) => handleReaderKeyRef.current(event),
      // 正文 iframe 上的指针活动转发:chrome 收起后鼠标在书上动一动就能
      // 唤回顶栏/底栏(否则设置面板在沉浸模式下点不到)。
      onPointerActivity: () => showChromeRef.current(),
      // 在正文上按下 = 「这一栏归我」:并行阅读里两栏都挂着,只有活动栏响应
      // 键盘、显示 chrome。iframe 内的按下不跨界,必须由内核转发。
      onPointerDown: () => paneActivateRef.current?.(),
    })
    adapterRef.current = adapter
    let cancelled = false
    void (async () => {
      try {
        // 简繁档位要先于 open 下发:wasm 预热是异步的,load 钩子里的转换
        // 必须同步可用(见 FoliateAdapter#setChineseVariant)。zhConvert
        // 在依赖里:切档位即整体重开书(位置由下方恢复逻辑拿回),已挂载
        // 的 section 不会自动重转 —— 与 readest 的 recreateViewer 同语义。
        await adapter.setChineseVariant(zhConvert)
        // 持久化排版随 open 一起下发(见 ReaderOpenInit):内核在每个 section
        // 挂载时读计算样式定竖排/横排,open 之后才下发 writing-mode 会把首节
        // 留在原书几何里 —— 竖排书开篇那一页就是错的。
        await adapter.open(
          {
            bookId: book.bookId,
            format: book.format,
            url: book.url,
            name: book.name,
          },
          {
            theme:
              READER_THEMES[settingsRef.current.themeIndex ?? 0]?.theme ?? READER_THEMES[0]!.theme,
            layout: readerLayout(settingsRef.current),
          },
        )
        // 被销毁(StrictMode 换挂载 / 换书)后 open() 会空 resolve —— 此时
        // 内核里什么都没有,IIFE 必须就此停手。漏掉这一句,后面的
        // getMetadata 会现造一个没有 book 的 view 钉在宿主机里,下一个
        // 适配器采用它开书,半个 paginator 直接把阅读尺探针打翻。
        if (cancelled) return
        const [metadata, tocItems] = await Promise.all([
          adapter.getMetadata(),
          adapter.getTableOfContents(),
        ])
        if (cancelled) return
        setTitle(metadata.title || book.name)
        setToc(tocItems)
        setBookLanguage(metadata.language)
        await adapter.setTheme(
          READER_THEMES[settingsRef.current.themeIndex ?? 0]?.theme ?? READER_THEMES[0]!.theme,
        )
        await adapter.setLayout(readerLayout(settingsRef.current))

        // 跨书搜索的正文命中:先按章节 label 定位。找不到那一章就照常
        // (恢复上次进度 / 开头),但要说一声 —— 用户点的是「跳到命中处」,
        // 悄悄落在别处比告诉他没找到更糟。
        let locatedByLabel = false
        if (book.sectionLabel !== undefined) {
          const match = findTocItem(tocItems, book.sectionLabel)
          if (match?.href !== undefined) {
            await adapter.goTo({ href: match.href, progress: 0 })
            locatedByLabel = true
          } else {
            setNotice({
              text: `没找到「${book.sectionLabel}」这一章,已按常规位置打开。`,
              danger: false,
            })
          }
        }

        // 两个平台都回读:桌面端读 SQLite,浏览器端在 ipc 层被分流到
        // IndexedDB —— 这正是「web 端也能记住读到哪」的关键一步。读不到
        // (全新导入 / 存储异常)就当没有,不挡打开这本书。
        const restored = await invokeCommand('reader.state.get', { bookHash: book.hash })
          .then((response) => response.state)
          .catch(() => null)
        if (restored) {
          setAnnotations(restored.annotations)
          for (const record of restored.annotations.filter((a) => !a.deleted)) {
            await adapter.createAnnotation(toDomainAnnotation(record, book.bookId))
          }
          setBookmarks(restored.bookmarks)
          // 从笔记页点进来时以那条批注为准:用户点的是「回到原文」,不是
          // 「继续阅读」,所以不能被上次读到的位置盖掉。
          if (book.cfi !== undefined) {
            await adapter.goTo({ cfi: book.cfi, progress: 0 })
          } else if (!locatedByLabel && restored.progress) {
            await adapter.goTo({ cfi: restored.progress.cfi, progress: restored.progress.fraction })
          }
        } else if (book.cfi !== undefined) {
          await adapter.goTo({ cfi: book.cfi, progress: 0 })
        }
        if (!cancelled) {
          setPhase('reading')
          // 从这里起,内核报的位置才是用户读到的位置。
          readyRef.current = true
          // 开书即进入常规节奏:工具栏短暂可见后自动收起。
          showChromeRef.current()
        }
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
  }, [book, zhConvert])

  /**
   * 并行阅读的联动:对面那一栏翻到了别处,本栏跟着跳。
   *
   * 用 nonce 判「是不是新请求」而不是比进度值:两本书进度可能恰好相同,
   * 按值比较会把重复请求当成空操作,偶尔漏跳。也不要把它并到开书 effect 里
   * —— 那个 effect 的依赖是 book,换书才该重跑。
   *
   * 内核还没就绪(开书竞态 / 慢书)时**不记账**:请求留在 syncRequest 里,
   * phase 到 reading 后 effect 重跑再放一次。否则 goTo 对着一个还没建好的
   * renderer 抛错,请求被静默吞掉 —— 用户看到的就是「左边翻了右边没动」,
   * 而且只偶现(取决于那一栏开书快慢)。
   */
  const syncRequest = pane?.sync
  useEffect(() => {
    if (syncRequest === undefined || syncRequest.nonce === 0) return
    if (syncRequest.nonce === appliedSyncRef.current) return
    if (phase !== 'reading') return
    const adapter = adapterRef.current
    if (adapter === null) return
    const nonce = syncRequest.nonce
    appliedSyncRef.current = nonce
    void adapter.goTo({ progress: syncRequest.fraction }, { animate: true }).catch(() => {
      // 跳转失败(内核正在换章等):把记账还回去,让后续一次 effect 重放。
      if (appliedSyncRef.current === nonce) appliedSyncRef.current = 0
    })
  }, [syncRequest, phase])

  // 「朗读此处」的第二拍:抽屉挂载后(ref 就位)把等的文本交给它。
  // 有待播文本就动手(迷你条形态直接起播);文本在调用瞬间就被清掉,
  // 重复渲染不会重放同一段(StrictMode 的双调 effect 也只会播一次)。
  useEffect(() => {
    if (pendingSpeak === null) return
    const drawer = ttsDrawerRef.current
    if (drawer === null) return
    const { text, start } = pendingSpeak
    setPendingSpeak(null)
    drawer.speakFromText(text, start)
  }, [pendingSpeak])

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

  /**
   * 阅读时长统计:只在"书在屏上且窗口可见"时累计,每 30s 上报一次增量
   * (离屏/失焦的间隔一律不计),离开阅读态时补一次尾账。
   */
  useEffect(() => {
    if (phase !== 'reading') return
    let lastTick = Date.now()
    let pending = 0
    const flush = (): void => {
      if (pending < 1) return
      void reportReadingTime(book.hash, localDayKey(), pending).catch(() => {})
      pending = 0
    }
    const tick = (): void => {
      const now = Date.now()
      // 单次 tick 最多计 90s:超过说明机器睡了,不能算成阅读。
      const elapsed = Math.min(now - lastTick, 90_000) / 1000
      lastTick = now
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      pending += elapsed
      if (pending >= 30) flush()
    }
    const onVisibility = (): void => {
      // 切回前台时重新起算,避免把后台停留时间算进去。
      lastTick = Date.now()
      if (document.visibilityState === 'hidden') flush()
    }
    const timer = window.setInterval(tick, 15_000)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onVisibility)
      window.removeEventListener('focus', onVisibility)
      flush()
    }
  }, [phase, book.hash])

  // 系统级全屏(绿色按钮 / 快捷键)也要同步按钮状态。
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
          '.reader-top,.reader-bottom,.reader-toc,.reader-settings,.reader-display,.reader-pick,.ai-drawer,.selection-toolbar,.lookup-card,.repair-panel,.page-flip,.dropdown-menu,.reader-theme-row,.tts-mini',
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
    const nightIndex = READER_THEMES.findIndex((option) => option.theme.colorScheme === 'dark')
    if (themeIndex === nightIndex) {
      const restore = lastLightIndexRef.current ?? 0
      setThemeIndex(restore)
      persistTypography({ themeIndex: restore })
      void adapterRef.current?.setTheme(READER_THEMES[restore]?.theme ?? READER_THEMES[0]!.theme)
    } else {
      lastLightIndexRef.current = themeIndex
      const next = nightIndex === -1 ? 0 : nightIndex
      setThemeIndex(next)
      persistTypography({ themeIndex: next })
      void adapterRef.current?.setTheme(
        (nightIndex === -1 ? READER_THEMES[0] : READER_THEMES[nightIndex])?.theme ??
          READER_THEMES[0]!.theme,
      )
    }
  }, [themeIndex])

  // chrome 显隐的统一节奏:任何显示路径只置可见 + 记活动时刻,
  // 自动隐藏由下方 effect 统一负责(可见且无浮层 → 距最后活动 2.5s 收起)。
  //
  // 抑制窗口:翻页会把整块正文在**静止的指针**底下挪走,WebKit 据此补发一串
  // pointermove —— 那不是用户的动作,却是"键盘每翻一页顶栏底栏闪一下"的
  // 全部来源。唤醒路径有五条(父窗口与 iframe 的 pointermove、选区、批注、
  // 面板外按下),出口只有这一个函数,闸门守在这里就够。
  const showChrome = useCallback((): void => {
    if (Date.now() < turnWakeUntilRef.current) return
    lastChromeActivityRef.current = Date.now()
    setChromeVisible(true)
  }, [])

  useEffect(() => {
    showChromeRef.current = showChrome
  }, [showChrome])

  // 无依赖数组:每次渲染都追平(ParallelReader 传的 onActivate 是新闭包)。
  useEffect(() => {
    paneActivateRef.current = pane?.onActivate ?? null
  })

  /**
   * 本阅读器的正文区矩形(窗口坐标系)。划词工具、翻译卡、词典卡都靠它夹取
   * 落点;并行阅读时窗口里有两个正文区,所以量**自己的宿主**,不全局查。
   * 返回值在调用时才算,不是渲染期读 ref。
   */
  const readFrame = useCallback(
    (): ReadingFrame =>
      hostRef.current?.getBoundingClientRect() ??
      windowFrame(window.innerWidth, window.innerHeight),
    [],
  )

  // chrome 自动隐藏:可见且无任何浮层(面板/选区/批注)时收起;指针活动
  // 会刷新计时。翻页不在此列——沉浸阅读不被翻页打断。
  useEffect(() => {
    // 写笔记时 chrome 不能收:顶栏一走,编辑器的锚点参照物也没了。
    if (
      !chromeVisible ||
      openPanel !== null ||
      selection !== null ||
      activeAnnotation !== null ||
      noteDraft !== null
    ) {
      return
    }
    const schedule = (): ReturnType<typeof setTimeout> =>
      setTimeout(
        () => setChromeVisible(false),
        Math.max(0, CHROME_TIMEOUT_MS - (Date.now() - lastChromeActivityRef.current)),
      )
    let timer = schedule()
    const onActivity = (): void => {
      clearTimeout(timer)
      lastChromeActivityRef.current = Date.now()
      timer = schedule()
    }
    window.addEventListener('pointermove', onActivity)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', onActivity)
    }
  }, [chromeVisible, openPanel, selection, activeAnnotation, noteDraft])

  /**
   * 翻页动画分两条路:
   * - 「滑动」档(默认)借内核自带的 animated 翻页:foliate-paginator 挂上
   *   `animated` 后自己播 300ms easeOutQuad 滑动,是 iframe 内的**真实内容
   *   运动**,全程无空窗。旧实现(宿主 WAAPI 两段动画夹一次内核翻页)中间
   *   必露一段空窗 ——  foliate `#turnPage` 默认每次翻页强制 `wait(100)`
   *   debounce,旧页滑出后屏幕只剩纸色 ~100ms 再滑入新页,这就是用户看到
   *   的「翻页闪一下」。且 transform 动在 iframe 的祖先层,WKWebView 下
   *   还有提层瞬间的栅格闪烁风险。
   * - 「覆盖/淡入」档走宿主 WAAPI 两段动画(见 page-turn.ts),这时内核必须
   *   **瞬间**翻页(传 animate:false 摘下 debounce),空窗由 page-turn 的
   *   「停车」钉在不可见状态。
   * - 「仿真」档走 page-flip.ts 的纸叶:整页书克隆成一张纸盖住正文,内核在
   *   纸叶底下瞬间翻页,纸叶再绕书脊转走。翻页窗口全程被盖着,不存在空窗。
   *   纸叶建不起来(固定排版 / 内核未就绪)才退回上一条的两段动画。
   * 翻页不唤起工具栏:沉浸阅读时翻页不应打断 chrome 的显隐节奏。
   */
  const turnPage = useCallback(
    async (dir: 'next' | 'prev'): Promise<void> => {
      const adapter = adapterRef.current
      if (!adapter) return
      // 这一次翻页(以及它的动画片尾)不再唤起 chrome —— 见 showChrome。
      // 键盘连翻时这是唯一该动的地方:按钮/键盘/尺走到页尾都汇到这里。
      turnWakeUntilRef.current = Date.now() + TURN_WAKE_SUPPRESS_MS
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const animated =
        pageTurnStyle !== 'none' && !reducedMotion && typography.viewMode !== 'scroll'
      // 滑动档 = 内核动画;其余档位 = 宿主动画(内核瞬间翻)。
      const kernelAnimated = animated && pageTurnStyle === 'slide'
      const flip = (): Promise<void> =>
        dir === 'next'
          ? adapter.nextPage({ animate: kernelAnimated })
          : adapter.previousPage({ animate: kernelAnimated })
      if (animated && pageTurnStyle !== 'slide') {
        const host = hostRef.current
        if (host !== null && typeof host.animate === 'function') {
          // 仿真档先试纸叶:它要克隆书页,拿不到(固定排版、内核未就绪)就
          // 返回 false,再退回宿主的旧页抬起动画。
          if (pageTurnStyle === 'flip') {
            const turned = await animateFlipTurn({
              host,
              layers: adapter.flipLeafLayers?.() ?? [],
              dir,
              columns: typography.viewMode === 'dual' ? 2 : 1,
              flip,
            }).catch(() => false)
            if (turned) return
          }
          // 动画失败(内核翻页抛错等)不向调用方冒泡 —— 按钮的 void 调用
          // 会把 rejection 变成 unhandled,而翻页失败不值得打断阅读。
          await animatePageTurn(host, pageTurnStyle, dir, flip).catch(() => {})
          return
        }
      }
      await flip().catch(() => {})
    },
    [pageTurnStyle, typography.viewMode],
  )

  useEffect(() => {
    const onPointerMove = (): void => showChrome()
    window.addEventListener('pointermove', onPointerMove)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
    }
  }, [showChrome])

  // 目录面板不在屏时,搜索命中高亮一并摘除 —— 查完就走,高亮不该赖在书上。
  // (含 Esc、点关闭、切到别的面板三条路;引擎不支持时是空操作。)
  useEffect(() => {
    if (openPanel === 'toc') return
    void adapterRef.current?.clearSearchHits?.().catch(() => {})
  }, [openPanel])

  // 方向键切页:window 与书内 iframe 两个入口共用同一处理。
  const handleReaderKey = useCallback(
    (event: KeyboardEvent): void => {
      // 隐藏态(退到书架听书):按键属于书架界面,别在背后偷偷翻页/关面板。
      if (hidden) return
      // 并行阅读:两栏都挂 window 监听,只让活动栏响应 —— 否则按一次 → 两本
      // 一起翻,想单翻一本就没办法了。
      if (paneActive === false) return
      const action = readerKeyAction(event)
      if (action === null) return
      // 焦点在输入框/文本域/滑杆等可编辑元素上时,翻页与阅读尺键让位给原生
      // 行为:搜索框里敲空格是打字,进度滑杆的 ←→ 是调滑杆。Escape 仍放行
      // —— 面板内按 Esc 关面板是既有行为,不因焦点在搜索框里而失效。
      if (action !== 'escape' && action !== 'fullscreen' && isEditableTarget(event.target)) return
      // 除全屏外,内核未就绪时不处理按键。
      // 实测结论(别照直觉推):adapterRef 在挂载 effect 起始处就同步赋值,
      // 开书失败只走 catch、并不清 ref,只有卸载 cleanup 才置 null。所以这条
      // 守卫实际只在「挂载 effect 还没跑」那一瞬生效 —— error 态下 ref 非空,
      // Escape 关面板与翻页都是通的。见 ReaderScreen.test 的「错误态下
      // Escape 也能关闭面板」。
      if (action !== 'fullscreen' && adapterRef.current === null) return
      // 上下方向键归阅读尺:关着尺时保持「未绑定」,什么都不做(也不吞按键)。
      if (action === 'ruler-up' || action === 'ruler-down') {
        if (!rulerActive) return
        event.preventDefault()
        void adapterRef.current?.moveReadingRuler?.(action === 'ruler-down' ? 1 : -1)
        return
      }
      // Escape 不 preventDefault —— 原实现只在翻页分支里调用,别顺手扩大范围,
      // 否则会挡掉宿主对 Esc 的默认处理(原生 <dialog> 的 Esc 关闭等)。
      if (action !== 'escape') event.preventDefault()
      if (action === 'fullscreen') {
        void toggleFullscreen()
      } else if (action === 'next') {
        void turnPage('next')
      } else if (action === 'prev') {
        void turnPage('prev')
      } else if (ttsMounted) {
        // Esc 归 TtsDrawer:它把自己收起成迷你条(播放不中断)。这里若跟着
        // 清 openPanel,抽屉在「最小化动画第一帧」就被卸载,用户看到的是
        // 「按 Esc 面板直接关了,没有小条」。
      } else {
        setOpenPanel(null)
        setSelection(null)
        setActiveAnnotation(null)
        setNoteDraft(null)
      }
    },
    [turnPage, toggleFullscreen, hidden, ttsMounted, paneActive, rulerActive],
  )

  useEffect(() => {
    handleReaderKeyRef.current = handleReaderKey
    window.addEventListener('keydown', handleReaderKey)
    return () => window.removeEventListener('keydown', handleReaderKey)
  }, [handleReaderKey])

  /**
   * 阅读尺设置:合并 → 落盘(下发见下面的 effect)。
   *
   * 只从事件处理器调用,所以直接读当前 state 合并、把副作用留在 updater
   * 外面 —— setState 的 updater 在 StrictMode 下会跑两次,副作用混进去
   * 会被双份执行。
   */
  const updateRuler = useCallback(
    (patch: Partial<ReadingRulerSettings>): void => {
      const next = { ...rulerSettings, ...patch }
      setRulerSettings(next)
      persistRulerSettings(next)
    },
    [rulerSettings],
  )

  const updateLayout = useCallback(
    (patch: {
      viewMode?: ViewMode
      originalLayout?: boolean
      fontSize?: number | undefined
      lineHeight?: number | undefined
      fontFamily?: string | undefined
      fontWeight?: number | undefined
      pageMargin?: number
      pageMarginBlock?: number
      paragraphMargin?: number | undefined
      textIndent?: number | undefined
      writingMode?: WritingModeChoice | undefined
    }): void => {
      const merged = mergeTypography(typography, patch)
      // 切到自定义排版:还没选过的维度先落到标准档 —— 否则「关了原书排版」
      // 在画面上什么都不变(每项仍是 undefined = 书自己的值),读者只会以为
      // 开关坏了。只在「开 → 关」的跳变瞬间物化;关着的时候再点「原书」档
      // (显式 undefined)必须原样保留,不然那一项永远弹回标准档、点不亮。
      const switchingToCustom =
        merged.originalLayout === false && typography.originalLayout !== false
      const next = switchingToCustom ? materializeCustomDefaults(merged) : merged
      setTypography(next)
      persistTypography(next)
      void adapterRef.current?.setLayout(readerLayout(next))
    },
    [typography],
  )

  /** 切简繁档位:state 进 open effect 依赖 → 整体重开书(见开书 effect)。 */
  const changeZhConvert = useCallback((variant: ZhConvertVariant): void => {
    setZhConvert(variant)
    persistTypography({ zhConvert: variant })
  }, [])

  /** 尺的总开关(顶栏按钮 / 设置面板共用)。版式不跟着动。 */
  const toggleRuler = useCallback((): void => {
    updateRuler({ enabled: !rulerActive })
  }, [rulerActive, updateRuler])

  // 尺是跨书偏好:偏好一变就下发;刚开完书(phase → reading)也补一次 ——
  // 内核建好之前没有版面可播种,early return 会把这次开尺吞掉。
  // 版式与尺互不干涉:尺在三种版式下都只做高亮,「把当前行钉在视口中间」
  // 是滚动排版才有的能力(分页下内核只按栏横滚),由内核自己判断。
  useEffect(() => {
    if (phase !== 'reading') return
    adapterRef.current?.setReadingRuler?.(
      rulerActive
        ? { focusLines: rulerSettings.focusLines, dimOpacity: rulerSettings.dimOpacity }
        : null,
    )
  }, [phase, rulerActive, rulerSettings.focusLines, rulerSettings.dimOpacity])

  const changeFontSize = (delta: number): void => {
    const current = FONT_SIZES.indexOf(
      (typography.fontSize ?? FONT_SIZE_DEFAULT) as (typeof FONT_SIZES)[number],
    )
    updateLayout({
      fontSize:
        FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, current + delta))] ??
        FONT_SIZE_DEFAULT,
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

  /** AI 引用 chip → 跳章:剥掉多块后缀「(2)」后按标题在目录里找。
      ai-core 与内核对 TXT 的切章实现不同,不按序号对位,按标题对位才稳;
      目录没有对应条目(如内核书的「原书正文」blob)就不动,chip 只是展示。 */
  const jumpToCitation = (label: string): void => {
    const wanted = label.replace(/\(\d+\)$/, '').trim()
    if (wanted === '') return
    const match = (items: readonly TocItem[]): TocItem | null => {
      for (const item of items) {
        const entryTitle = item.title.trim()
        if (entryTitle === wanted || entryTitle.startsWith(wanted)) return item
        const child = match(item.children)
        if (child !== null) return child
      }
      return null
    }
    const item = match(toc)
    if (item === null || item.href === undefined) return
    goToTocItem(item)
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

  // 当前章字数:切章时后台取一次纯文本计数(与 TTS 同一数据面,廉价)。切章
  // 信号来自内核 onRelocate,这里只负责进入阅读态时的首次计算。
  useEffect(() => {
    if (phase !== 'reading') return
    void countSectionChars(sectionIndexRef.current)
  }, [phase, countSectionChars])

  // 全书统计:打开书后一次性后台解析(逐节 createDocument,不挂载渲染),
  // 供"全书"字数与按字数的剩余时间估算;PDF 等固定排版为 null。
  useEffect(() => {
    if (phase !== 'reading') return
    let cancelled = false
    void adapterRef.current
      ?.getBookCharStats()
      .then((stats) => {
        if (!cancelled) setBookCharStats(stats)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [phase])

  // useCallback:色板那五个按钮在每次渲染都要复用同一个句柄,否则 React
  // Compiler 会把「渲染期间调用了含 Date 的函数」当成不确定性来源。
  const addHighlight = useCallback(
    async (color: string, style: AnnotationStyle): Promise<void> => {
      const adapter = adapterRef.current
      if (!adapter || selection === null) return
      const record: AnnotationRecord = {
        id: crypto.randomUUID(),
        cfi: selection.cfi,
        color,
        style,
        excerpt: selection.text.slice(0, EXCERPT_MAX_CHARS),
        updatedAt: new Date().toISOString(),
      }
      await adapter.createAnnotation(toDomainAnnotation(record, book.bookId))
      setAnnotations((current) => [...current, record])
      setLastInk({ color, style })
      // 工具栏不关:接着点色板就是改这条划线(编辑模式),而不是叠一条新的。
      // 点空白处(onSelection(null))才收工具栏。
      setActiveAnnotation(record.cfi)
      // 刚落笔的划线沿用选区的框:紧接着的编辑动作(改墨/朗读)都以它为锚。
      setActiveAnnotationRect(selection.rect)
      scheduleSave()
    },
    [book.bookId, scheduleSave, selection],
  )

  /** 重绘已有划线:换墨不换锚点,划线在原地变色变形。 */
  const restyleAnnotation = useCallback(
    async (record: AnnotationRecord, color: string, style: AnnotationStyle): Promise<void> => {
      await adapterRef.current?.removeAnnotation(record.id)
      await adapterRef.current?.createAnnotation(
        toDomainAnnotation({ ...record, color, style }, book.bookId),
      )
      setAnnotations((current) =>
        current.map((item) =>
          item.id === record.id
            ? { ...item, color, style, updatedAt: new Date().toISOString() }
            : item,
        ),
      )
      setLastInk({ color, style })
      scheduleSave()
    },
    [book.bookId, scheduleSave],
  )

  /**
   * 划选翻译:走 ai.chat 流式通道,边收边渲染,收完 zod 校验。
   * 门槛是「有没有配 AI 服务」——没配就说清楚,不做假的翻译结果。
   */
  const runTranslate = useCallback(async (): Promise<void> => {
    const current = selection
    if (current === null) return
    const provider = aiProviders[0]
    if (provider === undefined) {
      setNotice({ text: '还没有配置 AI 服务:先在 AI 助手里添加一个,再回来翻译。', danger: false })
      return
    }
    const source = current.text
    const text = source.slice(0, TRANSLATE_MAX_CHARS)
    // 卡片落点避开还开着的划词工具:工具在选区下方,卡片去工具底下(见
    // selection-place 的三级退让),不再不管不顾地压在选区上。
    const frame =
      hostRef.current?.getBoundingClientRect() ?? windowFrame(window.innerWidth, window.innerHeight)
    const rect = {
      top: placeCompanionCard(frame, anchorFromRect(current.rect), TRANSLATE_CARD_HEIGHT).top,
      left: current.rect.left,
    }
    setTranslation({
      rect,
      lang: null,
      body: '',
      provider: `${provider.name} · ${provider.model}`,
      truncated: source.length > TRANSLATE_MAX_CHARS,
      error: null,
      loading: true,
    })
    const taskId = newTaskId()
    let buffer = ''
    const parser = createSseParser((data) => {
      const delta = extractDelta(data)
      if (delta.type !== 'delta') return
      buffer += delta.text
      const view = streamTranslationView(buffer)
      setTranslation((state) =>
        state === null ? state : { ...state, lang: view.lang, body: view.body },
      )
    })
    try {
      await invokeStreamingCommand(
        'ai.chat',
        {
          taskId,
          configId: provider.id,
          messages: [
            ...buildTranslateMessages({
              text,
              targetLang: effectiveTranslateTarget,
              context: text,
            }),
          ],
        },
        (event) => {
          if (event.type === 'chunk') parser.push(event.data)
        },
      )
      parser.end()
      const parsed = parseTranslation(buffer)
      setTranslation((state) =>
        state === null
          ? state
          : { ...state, lang: parsed.detectedLang, body: parsed.translation, loading: false },
      )
    } catch (cause) {
      setTranslation((state) =>
        state === null ? state : { ...state, loading: false, error: toAppError(cause).message },
      )
    }
  }, [aiProviders, effectiveTranslateTarget, selection])

  /** 下笔:选中即成划线 + 一条笔记。已有批注只改 note,高亮本身不动。 */
  const commitNote = async (): Promise<void> => {
    const draft = noteDraft
    if (draft === null) return
    const trimmed = draft.note.trim()
    if (draft.id !== undefined) {
      setAnnotations((current) =>
        current.map((record) => {
          if (record.id !== draft.id) return record
          const stripped = { ...record }
          // 空串 = 清回纯高亮:必须真的删掉这个键,否则旧 note 会被摊平留下。
          delete stripped.note
          return {
            ...stripped,
            updatedAt: new Date().toISOString(),
            ...(trimmed === '' ? {} : { note: trimmed }),
          }
        }),
      )
      setNoteDraft(null)
      scheduleSave()
      return
    }
    const adapter = adapterRef.current
    if (!adapter) return
    const record: AnnotationRecord = {
      id: crypto.randomUUID(),
      cfi: draft.cfi,
      color: draft.color,
      style: draft.style,
      excerpt: draft.excerpt.slice(0, EXCERPT_MAX_CHARS),
      updatedAt: new Date().toISOString(),
      ...(trimmed === '' ? {} : { note: trimmed }),
    }
    await adapter.createAnnotation(toDomainAnnotation(record, book.bookId))
    setAnnotations((current) => [...current, record])
    setNoteDraft(null)
    setSelection(null)
    scheduleSave()
  }

  /** 从选区或批注列表/已有划线起稿:`source` 决定这是对谁下笔。 */
  const startNote = (source: {
    readonly id?: string
    readonly cfi: string
    readonly excerpt?: string | null
    readonly color: string
    readonly style?: AnnotationStyle
    readonly note?: string | null
  }): void =>
    setNoteDraft({
      ...(source.id !== undefined ? { id: source.id } : {}),
      cfi: source.cfi,
      excerpt: source.excerpt ?? '',
      color: source.color,
      style: source.style ?? 'highlight',
      note: source.note ?? '',
    })

  /** 删除划线(列表 / 点中的划线两条路同一处收敛)。
   *
   *  乐观更新:先把 UI 收掉(墓碑落 state + scheduleSave),再交内核删绘制
   *  —— 以前的顺序等内核返回才动 UI,而内核删除要解析 CFI,锚点偶尔解析
   *  失败抛错,后面那句 setActiveAnnotation 永远跑不到,用户看到的就是
   *  「点删除没反应」。墓碑本来就落库(跨设备也不复活),内核失败只少画
   *  一帧,不值得让按钮装死。 */
  const removeAnnotation = async (id: string): Promise<void> => {
    setAnnotations((current) =>
      current.map((record) =>
        record.id === id
          ? { ...record, deleted: true, updatedAt: new Date().toISOString() }
          : record,
      ),
    )
    setNoteDraft((current) => (current?.id === id ? null : current))
    setActiveAnnotation(null)
    setActiveAnnotationRect(null)
    scheduleSave()
    try {
      await adapterRef.current?.removeAnnotation(id)
    } catch {
      // 墓碑已落:重开会书不会重建这条划线,内核残留的绘制随重开消失。
    }
  }

  /**
   * 选区笔记的落点:还没有划线,所以先按当前墨水下笔(划线是笔记的载体,
   * 见 ColorReader 同款约定),再写 note。传 null = 只要划线,不写笔记。
   */
  const commitSelectionNote = async (note: string | null): Promise<void> => {
    if (selection === null) return
    const adapter = adapterRef.current
    if (!adapter) return
    const record: AnnotationRecord = {
      id: crypto.randomUUID(),
      cfi: selection.cfi,
      color: lastInk.color,
      style: lastInk.style,
      excerpt: selection.text.slice(0, EXCERPT_MAX_CHARS),
      updatedAt: new Date().toISOString(),
      ...(note === null ? {} : { note }),
    }
    await adapter.createAnnotation(toDomainAnnotation(record, book.bookId))
    setAnnotations((current) => [...current, record])
    // 同 addHighlight:笔记落笔后工具栏留着,转入这条划线的编辑模式。
    setActiveAnnotation(record.cfi)
    setActiveAnnotationRect(selection.rect)
    scheduleSave()
  }

  /** 改已有划线的 note(null = 清回纯划线)。与 commitNote 的既有分支同一约定。 */
  const updateAnnotationNote = async (id: string, note: string | null): Promise<void> => {
    setAnnotations((current) =>
      current.map((record) => {
        if (record.id !== id) return record
        const stripped = { ...record }
        // 空串 = 清回纯划线:必须真的删掉这个键,否则旧 note 会被摊平留下。
        delete stripped.note
        return {
          ...stripped,
          updatedAt: new Date().toISOString(),
          ...(note === null ? {} : { note }),
        }
      }),
    )
    scheduleSave()
  }

  const removeAnnotationNote = async (id: string): Promise<void> => {
    await updateAnnotationNote(id, null)
  }

  /** AI 选区问答的回答 → 批注笔记:这条选区已有划线就追加,还没有就
      「先落划线再写笔记」(commitSelectionNote 的既有约定)。 */
  const saveAnswerToNote = async (text: string): Promise<void> => {
    if (selection === null) return
    const existing = annotations.find((record) => record.cfi === selection.cfi && !record.deleted)
    if (existing !== undefined) {
      const merged = existing.note ? `${existing.note}\n\n${text}` : text
      await updateAnnotationNote(existing.id, merged)
    } else {
      await commitSelectionNote(text)
    }
  }

  const copySelection = async (): Promise<void> => {
    if (selection === null) return
    await navigator.clipboard.writeText(selection.text)
    // 工具栏不关:复制之后常常还想翻译/划线,收起等于逼用户重新划一次。
  }

  /**
   * 朗读选中的这一段:走 TTS 管线(Edge 合成),从划线所在的那一句起连播。
   *
   * 不再用系统 speechSynthesis:音质与速度都不受读者控制,而 TTS 抽屉本就挂在阅读器里
   * (音色、语速、进度、跟词高亮都是现成的)——为一句话再搭一套系统合成才是重复建轮子。
   *
   * 编辑模式(点中的是已有划线、没有伴随选区)也能读:文本取划线的 excerpt,
   * 起点仍由 locateSpeechUnit 在正文里现找 —— 划线在屏幕上,excerpt 就一定能
   * 落回当前章的某一句。
   *
   * 起播形态:直接落到**迷你播放条**(合成中带波形动画),不开整块抽屉 ——
   * 划词朗读是「读这一段」的轻动作,全屏抽屉把正文遮掉一半太重。选区文本
   * 存进 pendingSpeak;drawer 挂载后 effect 经 ref 调 speakFromText。
   * 划词工具条随朗读关闭:播放控制在迷你条上,留着它只会遮住正文。
   */
  const speakSelection = useCallback((): void => {
    // 选区的文本与偏移优先;编辑模式回退到划线自己的 excerpt(没有偏移,
    // 起点由 TtsDrawer 里的文本匹配现找)。
    const source =
      selection?.text ?? annotations.find((a) => a.cfi === activeAnnotation)?.excerpt ?? ''
    const text = source.trim()
    if (text === '') return
    // 音频解锁必须在这次点击里:WebKit 只认手势内创建/恢复的 AudioContext,
    // 而首个 clip 的合成在两次 await 之后(章节文本 + 供应商往返),手势早已
    // 过期。不在这里解锁,用户看到的就是「点了朗读没反应,再点播放才响」。
    primeTtsAudio()
    setSelection(null)
    setActiveAnnotation(null)
    setActiveAnnotationRect(null)
    setTtsMinimized(true)
    setOpenPanel(null)
    setTtsSession(true)
    setPendingSpeak({ text, start: selection?.start ?? null })
  }, [selection, annotations, activeAnnotation])

  /** 问 AI:带上选区打开抽屉。scope 由读者在抽屉里切,这里只负责送上下文。 */
  const askAboutSelection = useCallback((): void => {
    if (selection === null) return
    setOpenPanel('ai')
    // 不关 selection:AiDrawer 的 selection 作用域要读它。
  }, [selection])

  /** 在本书中搜索选中文本:复用侧栏搜索那套结果,填进输入框直接搜。 */
  const searchSelectionInBook = useCallback((): void => {
    if (selection === null) return
    const query = selection.text.trim().slice(0, 60)
    if (query === '') return
    if (searchInputRef.current !== null) searchInputRef.current.value = query
    setOpenPanel('toc')
    setSearchState('searching')
    void adapterRef.current
      ?.search(query)
      .then((results) => {
        setSearchTruncated(results.length > MAX_SHOWN_SEARCH_RESULTS)
        setSearchResults(
          results
            .slice(0, MAX_SHOWN_SEARCH_RESULTS)
            .map((r) => ({ cfi: r.location.cfi ?? '', excerpt: r.excerpt })),
        )
        setSearchState('done')
      })
      .catch(() => setSearchState('done'))
    // 工具栏不关:搜索结果在侧栏,选区的墨水/笔记还能接着用。
  }, [selection])

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

  /** 浏览器端拿到字体 File 之后的那一段(桌面端走 `fonts.import`)。 */
  const importFontFile = useCallback(
    async (file: File): Promise<void> => {
      setFontBusy(true)
      try {
        const { putStoredFont } = await import('../../lib/web-store')
        const name = file.name.replace(/\.[^.]+$/, '')
        await putStoredFont({
          id: `font-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          fileName: file.name,
          blob: file,
        })
        const fonts = await invokeCommand('fonts.list', undefined)
        setCustomFonts(fonts)
        const imported = fonts[fonts.length - 1]
        if (imported) updateLayout({ fontFamily: imported.name })
      } catch (fontError) {
        setPanelProblem(toAppError(fontError).message || null)
      } finally {
        setFontBusy(false)
      }
    },
    [updateLayout],
  )

  const importReadingFont = useCallback(async (): Promise<void> => {
    // 浏览器端没有 `openFileDialog`,走隐藏的 file input(见 JSX 里那个)。
    if (!isTauriRuntime()) {
      fontInputRef.current?.click()
      return
    }
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
  }, [updateLayout])

  const removeReadingFont = useCallback(
    async (name: string): Promise<void> => {
      const target = customFonts.find((font) => font.name === name)
      if (!target) return
      try {
        await invokeCommand('fonts.remove', { id: target.id })
        const fonts = await invokeCommand('fonts.list', undefined)
        setCustomFonts(fonts)
        if (typography.fontFamily === name) updateLayout({ fontFamily: undefined })
      } catch (fontError) {
        setPanelProblem(toAppError(fontError).message ?? null)
      }
    },
    [customFonts, typography.fontFamily, updateLayout],
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
    const repaired = applyRepair(source, [...review.accepted])
    await adapter.replaceSource(repaired)
    setToc(await adapter.getTableOfContents())
    setRepairReview(null)
    setNotice({ text: `已应用 ${review.accepted.size} 处排版修复。`, danger: false })
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

  /**
   * 章节规则样本行:书开头 60 个非空行。预览与 AI 推断都在它上面跑 ——
   * 模型/用户都只看得到开头,与洞察区"基于章节开头"同一口径。
   * 打开面板的这一次点击里取(ref 只能在 render 外读)。
   */
  const [chapterSampleLines, setChapterSampleLines] = useState<readonly string[]>([])
  const toggleRebuildPanel = useCallback((): void => {
    setRebuildOpen((open) => {
      if (open) return false
      const source = adapterRef.current?.getSourceText() ?? ''
      setChapterSampleLines(
        source
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(0, 60),
      )
      return true
    })
  }, [])

  /** AI 推断章节规则候选:与翻译同一条流式通路,输出交面板走强制预览。 */
  const inferChapterCandidates = useCallback(async (): Promise<readonly ChapterRuleCandidate[]> => {
    const provider = aiProviders[0]
    if (provider === undefined) return []
    const taskId = newTaskId()
    let full = ''
    const parser = createSseParser((data) => {
      const delta = extractDelta(data)
      if (delta.type === 'delta') full += delta.text
    })
    await invokeStreamingCommand(
      'ai.chat',
      {
        taskId,
        configId: provider.id,
        messages: [...buildChapterRuleMessages(chapterSampleLines, book.name)],
      },
      (event) => {
        if (event.type === 'chunk') parser.push(event.data)
      },
    )
    parser.end()
    return parseChapterRuleCandidates(full)
  }, [aiProviders, book.name, chapterSampleLines])

  /** 保存并生效:重建章节 + 刷新目录;旧版 per-book 正则至此被规则接管。 */
  const applyChapterRules = useCallback(
    async (rules: readonly ChapterRule[]): Promise<void> => {
      const adapter = adapterRef.current
      if (!adapter) return
      const count = await adapter.rebuildChapters(rules)
      setToc(await adapter.getTableOfContents())
      // 规则已落库成为唯一事实来源,旧键再留着只会造成"改了两处"的错觉。
      localStorage.removeItem(`deepread.chapterPattern.${book.hash}`)
      setNotice({ text: `章节重建完成:共 ${count} 节。`, danger: false })
    },
    [book.hash],
  )

  /** Jump to the fraction the slider was released on (once per scrub). */
  const commitScrub = (): void => {
    if (!scrubbingRef.current) return
    scrubbingRef.current = false
    const fraction = progressRef.current?.fraction
    if (fraction !== undefined) void adapterRef.current?.goTo({ progress: fraction })
  }

  const runLookup = async (): Promise<void> => {
    if (!selection) return
    const word = selection.text
      .trim()
      .replace(/^[^\w\u4e00-\u9fff]+|[^\w\u4e00-\u9fff]+$/g, '')
      .slice(0, 40)
    // 词典卡与翻译卡同套避让(工具条现在不关),选区也留给后续动作。
    const frame =
      hostRef.current?.getBoundingClientRect() ?? windowFrame(window.innerWidth, window.innerHeight)
    const rect = {
      top: placeCompanionCard(frame, anchorFromRect(selection.rect), LOOKUP_CARD_HEIGHT).top,
      left: selection.rect.left,
    }
    if (!word) return
    setLookupLoading(true)
    setLookup({ word, rect, results: [] })
    const results: { dictName: string; word: string; fields: readonly DefinitionField[] }[] = []
    for (const meta of dictionaries) {
      try {
        const loaded = await loadDictionary(meta)
        for (const result of lookupWord(
          loaded.entries,
          loaded.dict,
          word,
          meta.sametypesequence ?? undefined,
        )) {
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
        {
          id: crypto.randomUUID(),
          cfi: current.cfi,
          // 记下当时的章节名:书签列表里比原始 CFI 有意义得多。
          ...(sectionLabel !== null && sectionLabel.trim() !== '' ? { label: sectionLabel } : {}),
          createdAt: new Date().toISOString(),
        },
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
    try {
      const results = await adapter.search(query)
      setSearchTruncated(results.length > MAX_SHOWN_SEARCH_RESULTS)
      setSearchResults(
        results
          .slice(0, MAX_SHOWN_SEARCH_RESULTS)
          .map((r) => ({ cfi: r.location.cfi ?? '', excerpt: r.excerpt })),
      )
      setSearchState('done')
      // 命中处上屏:淡蓝高亮标出每一条,翻页重放;新搜索或关面板时摘除。
      void adapterRef.current
        ?.showSearchHits?.(results.map((r) => r.location.cfi ?? '').filter(Boolean))
        .catch(() => {})
    } catch {
      // 内核搜索失败要有明确终态 —— 否则 searchState 永远停在「搜索中」。
      setSearchState('error')
    }
  }

  const theme = READER_THEMES[themeIndex] ?? READER_THEMES[0]!
  /** 阅读主题变量:阅读器根层与 TTS 播放器的 portal 外壳共用同一份 ——
   *  播放器 portal 到 body 后就离开了 .reader-scope,变量得随身带。 */
  const readerVars = {
    '--reader-bg': theme.theme.background,
    '--reader-fg': theme.theme.foreground,
    '--reader-panel': withAlpha(theme.theme.background, 0.86),
    '--reader-panel-solid': theme.theme.background,
  } as React.CSSProperties
  const liveBookmarks = bookmarks.filter((b) => !b.deleted)
  const bookmarkedHere = progress.cfi !== null && liveBookmarks.some((b) => b.cfi === progress.cfi)
  const liveAnnotations = annotations.filter((a) => !a.deleted)
  /** 当前点中的那条划线(CFI 是内核回传的锚点;墓碑不算数,否则刚删完的
   *  划线会在工具条上残留一帧「还在编辑」的假象)。 */
  const activeRecord = annotations.find((a) => a.cfi === activeAnnotation && !a.deleted)
  /** 当前用的字体是自定义导入(不在内置档里)才给「删除字体」入口;
   *  取值在渲染期定死成局部常量 —— 回调闭包里属性窄化会失效。 */
  const customFontInUse =
    typography.fontFamily !== undefined &&
    !FONT_FAMILY_OPTIONS.some((option) => option.value === typography.fontFamily)
      ? typography.fontFamily
      : null
  /** 「本章」= 当前页 CFI 所在的那一节;解析不出就按全书给,好过给个错的。 */
  const currentChapter = progress.cfi === null ? null : cfiChapter(progress.cfi)
  const shownAnnotations =
    annotationScope === 'chapter' && currentChapter !== null
      ? liveAnnotations.filter((a) => cfiChapter(a.cfi) === currentChapter)
      : liveAnnotations

  // 页码 / 字数(本章或全书)/ 预计剩余阅读时间。算法见 reading-indicators.ts。
  const readingStats = useMemo(
    () =>
      buildReadingStats({
        location: progress.location,
        fraction: progress.fraction,
        bookLanguage,
        sectionChars,
        bookCharStats,
        wordsScope: statsSettings.wordsScope,
      }),
    [
      progress.location,
      progress.fraction,
      bookLanguage,
      sectionChars,
      bookCharStats,
      statsSettings.wordsScope,
    ],
  )

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
    <div className="reader-scope" style={readerVars}>
      {/* 浏览器端导入阅读字体用(桌面端走 openFileDialog,不会碰它)。 */}
      <input
        ref={fontInputRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void importFontFile(file)
        }}
      />
      <div
        className={`reader${pane === undefined ? '' : ' reader-embedded'}${
          chromeVisible || openPanel !== null ? ' chrome-visible' : ''
        }${ttsActive && ttsMinimized ? ' tts-mini-active' : ''}`}
        onPointerDown={() => {
          showChrome()
          // 一栏里任何一次按下都切换活动栏:与「窗口聚焦」同一个直觉,
          // 也是键盘方向的唯一归属依据。
          pane?.onActivate()
        }}
      >
        {/* data-reading-content:划词工具按这个矩形夹取位置 —— 面板属于 chrome,
            必须留在阅读区里,而不是挂到窗口边(窗口比阅读卡片宽,圆角处会露头)。 */}
        <div ref={hostRef} className="reader-host" data-reading-content />

        {/* 左右悬浮翻页钮:按钮自己是 2/3 书高的透明热区,鼠标进入边缘才
            让芯片现身(见 .page-flip);按下不冒泡 —— 点翻页不该顺带唤起
            顶栏/底栏(每次点击「闪一下」的来源)。 */}
        <button
          type="button"
          className="page-flip page-flip-left"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void turnPage('prev')}
          title="上一页"
          aria-label="上一页"
        >
          <span className="page-flip-chip">
            <CaretLeft size={16} weight="bold" aria-hidden />
          </span>
        </button>
        <button
          type="button"
          className="page-flip page-flip-right"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void turnPage('next')}
          title="下一页"
          aria-label="下一页"
        >
          <span className="page-flip-chip">
            <CaretRight size={16} weight="bold" aria-hidden />
          </span>
        </button>

        {phase === 'opening' && (
          <div className="reader-opening" data-title={`正在打开 ${title}…`} />
        )}
        {phase === 'error' && (
          <div className="reader-error" role="alert">
            <p>{error}</p>
            <button type="button" className="reader-error-button" onClick={() => onBack(false)}>
              返回书架
            </button>
          </div>
        )}

        <header className="reader-top">
          <button
            type="button"
            className="chrome-button"
            onClick={() => {
              // 听书还在播时收成迷你条再退场:宿主会隐藏(而非卸载)阅读器,
              // 朗读跨屏继续;没在播就直接走。
              setTtsMinimized(true)
              onBack(ttsActive)
            }}
            title="返回书架"
          >
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
            onClick={() => setOpenPanel((panel) => (panel === 'display' ? null : 'display'))}
            title="显示设置"
          >
            <SlidersHorizontal size={18} weight="regular" aria-hidden />
          </button>
          {/* 阅读尺是一个「开着的模式」,所以给顶栏一颗常驻开关:开着的时候
              它像夜间/全屏一样是亮的,关掉即回到普通正文。开尺会把版式切到
              滚动(当前行居中的唯一版式),关尺还原 —— 见 toggleRuler。 */}
          <button
            type="button"
            className={`chrome-button${rulerActive ? ' is-active' : ''}`}
            onClick={toggleRuler}
            disabled={!rulerSupported}
            aria-pressed={rulerActive}
            title={
              rulerSupported
                ? rulerActive
                  ? '关闭阅读尺'
                  : '阅读尺:聚焦当前行、淡化其他行(滚轮 / ↑↓ 移尺,滚动排版下当前行居中)'
                : '阅读尺暂不支持固定排版(PDF / 漫画)与竖排'
            }
          >
            <Ruler size={18} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={`chrome-button${openPanel === 'ai' ? ' is-active' : ''}`}
            onClick={() => setOpenPanel((panel) => (panel === 'ai' ? null : 'ai'))}
            title="AI 助手"
          >
            <Sparkle size={18} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={`chrome-button${openPanel === 'tts' ? ' is-active' : ''}`}
            onClick={() => setOpenPanel((panel) => (panel === 'tts' ? null : 'tts'))}
            title="朗读 / 听书"
          >
            <Headphones size={18} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={`chrome-button${openPanel === 'learning' ? ' is-active' : ''}`}
            onClick={() => setOpenPanel((panel) => (panel === 'learning' ? null : 'learning'))}
            title="学习(卡片 / 测验 / 错题本)"
          >
            <GraduationCap size={18} weight="regular" aria-hidden />
          </button>
          {/* 对照阅读是「再加一本书」而不是又一个视图开关,所以放在目录前、
              紧贴最右:读者翻到这里时手已经在最右侧了。已在并排模式时藏起来
              —— 一栏里没有第三栏可开。 */}
          {onOpenParallel !== undefined && pane === undefined && (
            <button
              type="button"
              className={`chrome-button${openPanel === 'parallel' ? ' is-active' : ''}`}
              onClick={() => {
                setOpenPanel((panel) => (panel === 'parallel' ? null : 'parallel'))
                setChromeVisible(true)
              }}
              title="对照阅读(两本书并排)"
              aria-haspopup="dialog"
              aria-expanded={openPanel === 'parallel'}
            >
              <Columns size={18} weight="regular" aria-hidden />
            </button>
          )}
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

        {openPanel === 'parallel' && onOpenParallel !== undefined && (
          <ParallelPicker
            excludeHash={book.hash}
            onPick={(other) => {
              setOpenPanel(null)
              onOpenParallel(other)
            }}
            onClose={() => setOpenPanel(null)}
          />
        )}

        {openPanel === 'settings' && (
          <section className="reader-settings" aria-label="排版设置">
            {/* 主题:与正文同屏,换档立刻看得见。 */}
            <div className="settings-group">
              <span className="settings-group-label">阅读背景</span>
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
                      persistTypography({ themeIndex: index })
                      void adapterRef.current?.setTheme(option.theme)
                    }}
                    aria-pressed={themeIndex === index}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 原书排版总开关(默认开):开着由书决定,关掉逐项重写。 */}
            <div className="settings-group">
              <button
                type="button"
                className={`settings-toggle${typography.originalLayout ? ' is-on' : ''}`}
                role="switch"
                aria-checked={typography.originalLayout}
                onClick={() => updateLayout({ originalLayout: !typography.originalLayout })}
                title={typography.originalLayout ? '关闭后逐项自定义排版' : '恢复这本书自己的排版'}
              >
                <span className="settings-toggle-label">原书排版</span>
                <span className="settings-toggle-track" aria-hidden>
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
              <p className="settings-hint">
                {typography.originalLayout
                  ? '行距、段间距、缩进、字重与方向都用书自己的;字体仍可自选。'
                  : '按下面的档位重写这本书的排版;任一档位还能单独选回「原书」。'}
              </p>
            </div>

            {/* 自定义排版:这几项在「原书排版」下由书决定,不开入口 —— 一排
                按不动的灰按钮只会让人以为坏了。关掉开关就整组出现。 */}
            {!typography.originalLayout && (
              <div className="settings-group">
                <span className="settings-group-label">正文</span>
                <div className="settings-stack">
                  <div className="settings-row">
                    <span className="settings-label">行距</span>
                    <Segmented>
                      {LINE_HEIGHT_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className={typography.lineHeight === option.value ? 'is-active' : ''}
                          onClick={() => updateLayout({ lineHeight: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </Segmented>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">段间距</span>
                    <Segmented>
                      {PARAGRAPH_MARGIN_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className={typography.paragraphMargin === option.value ? 'is-active' : ''}
                          onClick={() => updateLayout({ paragraphMargin: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </Segmented>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">段首缩进</span>
                    <Segmented>
                      {TEXT_INDENT_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className={typography.textIndent === option.value ? 'is-active' : ''}
                          onClick={() => updateLayout({ textIndent: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </Segmented>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">字重</span>
                    <Segmented>
                      {FONT_WEIGHT_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className={typography.fontWeight === option.value ? 'is-active' : ''}
                          style={{ fontWeight: option.cssWeight }}
                          onClick={() => updateLayout({ fontWeight: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </Segmented>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">排版方向</span>
                    <Segmented>
                      {WRITING_MODE_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className={typography.writingMode === option.value ? 'is-active' : ''}
                          onClick={() => updateLayout({ writingMode: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </Segmented>
                  </div>
                </div>
              </div>
            )}

            {/* 字号与两把边距:阅读舒适度,与是否「原书排版」无关。 */}
            <div className="settings-group">
              <span className="settings-group-label">页面</span>
              <div className="settings-stack">
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
                    <span className="segmented-value">
                      {typography.fontSize ?? FONT_SIZE_DEFAULT}px
                    </span>
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
                  <span className="settings-label">左右边距</span>
                  <Segmented>
                    {PAGE_MARGIN_INLINE_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        className={typography.pageMargin === option.value ? 'is-active' : ''}
                        onClick={() => updateLayout({ pageMargin: option.value })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </Segmented>
                </div>
                <div className="settings-row">
                  <span className="settings-label">上下边距</span>
                  <Segmented>
                    {PAGE_MARGIN_BLOCK_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        className={typography.pageMarginBlock === option.value ? 'is-active' : ''}
                        onClick={() => updateLayout({ pageMarginBlock: option.value })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </Segmented>
                </div>
              </div>
            </div>

            {/* 字体独立于总开关:读哪本书都用自己的字体是阅读口味,不是「书的
                排版」—— 两种模式下都给入口,选「原书」才回到书自带的字体。 */}
            <div className="settings-group">
              <span className="settings-group-label">字体</span>
              <Segmented className="segmented-wrap">
                {FONT_FAMILY_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.fontFamily === option.value ? 'is-active' : ''}
                    style={
                      option.value !== undefined && FONT_STACK_PREVIEW[option.value]
                        ? { fontFamily: FONT_STACK_PREVIEW[option.value] }
                        : undefined
                    }
                    onClick={() => updateLayout({ fontFamily: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
                {customFonts.map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    className={typography.fontFamily === font.name ? 'is-active' : ''}
                    onClick={() => updateLayout({ fontFamily: font.name })}
                    title={`${font.name}(点按使用;长按列表删除)`}
                  >
                    {font.name.length > 6 ? `${font.name.slice(0, 5)}…` : font.name}
                  </button>
                ))}
              </Segmented>
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
                {customFontInUse !== null && (
                  <button
                    type="button"
                    className="btn btn-ghost font-remove"
                    onClick={() => void removeReadingFont(customFontInUse)}
                    title="删除当前使用的自定义字体"
                  >
                    <Trash size={13} aria-hidden /> 删除当前字体
                  </button>
                )}
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group-label">文字与词典</span>
              <div className="settings-stack">
                <div className="settings-row">
                  <span className="settings-label">简繁转换</span>
                  {/* 二级菜单:9 档全展开会占掉半个面板(还会把字体行挤出视口),
                      触发器只显示当前档位,点开才是完整列表。 */}
                  <DropdownMenu
                    value={zhConvert}
                    options={ZH_CONVERT_OPTIONS}
                    onChange={changeZhConvert}
                    ariaLabel="简繁转换"
                    title="转换正文与目录;切换后重新打开本书生效"
                    themeVars={readerVars}
                  />
                </div>
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
              </div>
            </div>
            {panelProblem !== null && (
              <p className="lookup-empty" role="alert">
                {panelProblem}
              </p>
            )}
          </section>
        )}

        {openPanel === 'display' && (
          <section className="reader-settings reader-display" aria-label="显示设置">
            <div className="settings-group">
              <span className="settings-group-label">显示</span>
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
                        persistStatsSettings(next)
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
            <div className="settings-group">
              <span className="settings-group-label">翻页动画</span>
              <Segmented>
                {PAGE_TURN_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={pageTurnStyle === option.value ? 'is-active' : ''}
                    onClick={() => {
                      setPageTurnStyle(option.value)
                      persistPageTurnStyle(option.value)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
            <div className="settings-row">
              <span className="settings-label">方式</span>
              <Segmented>
                {VIEW_MODE_OPTIONS.filter(
                  (option) => option.value !== 'scroll' || scrollModeSupported,
                ).map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.viewMode === option.value ? 'is-active' : ''}
                    onClick={() => updateLayout({ viewMode: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
            <div className="settings-group">
              <span className="settings-group-label">阅读尺</span>
              <div className="stats-toggles">
                <button
                  type="button"
                  className={`stats-toggle${rulerActive ? ' is-on' : ''}`}
                  role="switch"
                  aria-checked={rulerActive}
                  disabled={!rulerSupported}
                  onClick={toggleRuler}
                >
                  <span className="stats-toggle-label">聚焦当前行,淡化其他行</span>
                  <span className="stats-toggle-track" aria-hidden>
                    <span className="stats-toggle-thumb" />
                  </span>
                </button>
              </div>
            </div>
            {rulerActive && (
              <>
                <div className="settings-row">
                  <span className="settings-label">聚焦行数</span>
                  <Segmented>
                    {RULER_FOCUS_LINES.map((count) => (
                      <button
                        key={count}
                        type="button"
                        className={rulerSettings.focusLines === count ? 'is-active' : ''}
                        onClick={() => updateRuler({ focusLines: count })}
                      >
                        {count}
                      </button>
                    ))}
                  </Segmented>
                </div>
                <div className="settings-row">
                  <span className="settings-label">淡化</span>
                  <Segmented>
                    {RULER_DIM_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        className={rulerSettings.dimOpacity === option.value ? 'is-active' : ''}
                        onClick={() => updateRuler({ dimOpacity: option.value })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </Segmented>
                </div>
              </>
            )}
            <p className="ai-privacy">
              {!rulerSupported
                ? '阅读尺暂不支持固定排版(PDF / 漫画)与竖排正文。'
                : '滚轮与 ↑↓ 移动聚焦行,走到页尾自动翻页;当前排版是滚动时,移动后当前行会回到视口中间。分页排版只高亮、不滚动页面。'}
            </p>
          </section>
        )}

        {openPanel === 'toc' && (
          <nav className="reader-toc" aria-label="目录与搜索">
            <div className="reader-toc-head">
              <div className="reader-toc-tabs">
                <button
                  type="button"
                  className={tocTab === 'toc' ? 'is-active' : ''}
                  onClick={() => setTocTab('toc')}
                  aria-pressed={tocTab === 'toc'}
                >
                  目录
                </button>
                <button
                  type="button"
                  className={tocTab === 'annotations' ? 'is-active' : ''}
                  onClick={() => setTocTab('annotations')}
                  aria-pressed={tocTab === 'annotations'}
                >
                  批注{liveAnnotations.length > 0 ? ` ${liveAnnotations.length}` : ''}
                </button>
              </div>
              <button
                type="button"
                className="chrome-button"
                onClick={() => setOpenPanel(null)}
                title="关闭"
              >
                <X size={16} weight="regular" aria-hidden />
              </button>
            </div>

            {tocTab === 'toc' ? (
              <>
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
                {searchState === 'error' && (
                  <p className="reader-toc-empty" role="alert">
                    搜索失败,请重试。
                  </p>
                )}
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
                {searchTruncated && (
                  <p className="reader-toc-empty">
                    仅显示前 {MAX_SHOWN_SEARCH_RESULTS} 条,请细化关键词。
                  </p>
                )}

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
                      <span className="settings-label">章节规则</span>
                      <div className="segmented">
                        <button type="button" onClick={toggleRebuildPanel}>
                          {rebuildOpen ? '收起' : '自定义'}
                        </button>
                      </div>
                    </div>
                    {rebuildOpen && (
                      <ChapterRulesPanel
                        sampleLines={chapterSampleLines}
                        onInferCandidates={
                          aiProviders[0] === undefined ? null : inferChapterCandidates
                        }
                        onApply={applyChapterRules}
                        legacyPattern={legacyChapterPattern}
                      />
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
                      {bookmark.label ?? `书签 ${bookmark.cfi.slice(0, 18)}…`}
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
              </>
            ) : (
              <>
                <div className="segmented annotation-scope">
                  <button
                    type="button"
                    className={annotationScope === 'chapter' ? 'is-active' : ''}
                    onClick={() => setAnnotationScope('chapter')}
                  >
                    本章
                  </button>
                  <button
                    type="button"
                    className={annotationScope === 'book' ? 'is-active' : ''}
                    onClick={() => setAnnotationScope('book')}
                  >
                    全书
                  </button>
                </div>
                {shownAnnotations.length === 0 ? (
                  <p className="reader-toc-empty">
                    {annotationScope === 'chapter' && currentChapter !== null
                      ? '本章还没有批注。'
                      : '还没有批注 —— 在正文里划选即可。'}
                  </p>
                ) : (
                  shownAnnotations.map((record) => (
                    <div key={record.id} className="annotation-row">
                      <span
                        className="annotation-dot"
                        style={{ background: record.color }}
                        aria-hidden
                      />
                      <div className="annotation-body">
                        <button
                          type="button"
                          className="annotation-item"
                          onClick={() => goToCfi(record.cfi)}
                          title="跳到原文"
                        >
                          <span className="annotation-excerpt">{record.excerpt}</span>
                          {record.note !== undefined && record.note !== '' && (
                            <span className="annotation-note">{record.note}</span>
                          )}
                        </button>
                        {noteDraft?.id === record.id && (
                          <NoteEditor
                            draft={noteDraft}
                            onChange={setNoteDraft}
                            onSave={() => void commitNote()}
                            onCancel={() => setNoteDraft(null)}
                          />
                        )}
                      </div>
                      <div className="annotation-actions">
                        <button
                          type="button"
                          className="chrome-button"
                          onClick={() =>
                            startNote({
                              id: record.id,
                              cfi: record.cfi,
                              excerpt: record.excerpt,
                              color: record.color,
                              note: record.note,
                            })
                          }
                          title="写笔记"
                        >
                          <PencilSimple size={12} weight="regular" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="chrome-button"
                          onClick={() => void removeAnnotation(record.id)}
                          title="删除划线"
                        >
                          <Trash size={12} weight="regular" aria-hidden />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </>
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
                // Scrubbing only moves the thumb: a goTo per input event relayouts
                // the whole book. The jump happens once, on release.
                const fraction = Number(event.target.value) / 1000
                setProgress((current) => ({ ...current, fraction }))
                progressRef.current =
                  progressRef.current !== null ? { ...progressRef.current, fraction } : null
              }}
              onPointerDown={() => {
                scrubbingRef.current = true
              }}
              onPointerUp={() => commitScrub()}
              onKeyDown={() => {
                scrubbingRef.current = true
              }}
              onKeyUp={() => commitScrub()}
              onBlur={() => commitScrub()}
            />
            <span className="reader-arrow" aria-hidden>
              <ArrowLeft size={14} weight="regular" />
            </span>
            <span className="reader-arrow" aria-hidden>
              <ArrowRight size={14} weight="regular" />
            </span>
            {statsSettings.words && readingStats.chars && (
              <button
                type="button"
                className="reader-count-toggle"
                title={`当前显示${statsSettings.wordsScope === 'book' ? '全书' : '本章'}字数,点按切换`}
                onClick={() => {
                  setStatsSettings((current) => {
                    const next = {
                      ...current,
                      wordsScope:
                        current.wordsScope === 'book' ? ('section' as const) : ('book' as const),
                    }
                    persistStatsSettings(next)
                    return next
                  })
                }}
              >
                {readingStats.chars}
              </button>
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
            themeVars={readerVars}
            onJumpToCitation={jumpToCitation}
            onSaveAnswerToNote={saveAnswerToNote}
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

        {openPanel === 'learning' && (
          <LearningDrawer
            bookHash={book.hash}
            bookTitle={title}
            annotations={annotations}
            getChapterText={ttsGetSectionText}
            onClose={() => setOpenPanel(null)}
          />
        )}
        {(selection !== null || activeRecord !== undefined) && (
          <SelectionToolbar
            rect={selection?.rect ?? activeAnnotationRect ?? { top: 0, left: 0, height: 0 }}
            readFrame={readFrame}
            text={selection?.text ?? activeRecord?.excerpt ?? ''}
            annotation={activeRecord ?? null}
            defaultColor={lastInk.color}
            defaultStyle={lastInk.style}
            onCopy={() => void copySelection()}
            onLookup={() => void runLookup()}
            onTranslate={() => void runTranslate()}
            onAsk={askAboutSelection}
            onSpeak={speakSelection}
            onSearch={searchSelectionInBook}
            onHighlight={(color, style) => void addHighlight(color, style)}
            onRestyle={(color, style) => {
              if (activeRecord !== undefined) void restyleAnnotation(activeRecord, color, style)
            }}
            onNote={(note) => {
              if (selection !== null) {
                // 选区的笔记:还没有划线,先按当前墨水下笔,再写/清 note。
                void commitSelectionNote(note)
                return
              }
              if (activeRecord === undefined) return
              if (note === null) {
                void removeAnnotationNote(activeRecord.id)
                return
              }
              void updateAnnotationNote(activeRecord.id, note)
            }}
            onDelete={() => {
              if (activeRecord !== undefined) void removeAnnotation(activeRecord.id)
            }}
            onClose={() => {
              setSelection(null)
              setActiveAnnotation(null)
            }}
          />
        )}

        {noteDraft !== null && noteDraft.id === undefined && (
          <div className="lookup-card note-editor-float">
            <NoteEditor
              draft={noteDraft}
              onChange={setNoteDraft}
              onSave={() => void commitNote()}
              onCancel={() => setNoteDraft(null)}
            />
          </div>
        )}

        {translation !== null && (
          <div
            className="lookup-card translate-card"
            aria-label="翻译"
            style={{
              // rect.top 已是避开划词工具算好的落点(见 runTranslate),这里只做
              // 视口兜底;卡片 max-height 由 CSS 管,流式变高时自己滚。
              top: Math.min(Math.max(64, translation.rect.top ?? 100), window.innerHeight - 300),
              left: Math.max(12, Math.min(translation.rect.left ?? 100, window.innerWidth - 340)),
            }}
          >
            <div className="lookup-head">
              <strong>翻译 → {effectiveTranslateTarget}</strong>
              <button
                type="button"
                className="chrome-button"
                onClick={() => setTranslation(null)}
                title="关闭"
              >
                <X size={12} weight="regular" aria-hidden />
              </button>
            </div>
            <DropdownMenu
              className="tts-card-dropdown"
              ariaLabel="翻译目标语言"
              themeVars={readerVars}
              value={effectiveTranslateTarget}
              options={TRANSLATE_TARGETS.map((target) => ({ value: target, label: target }))}
              onChange={(target) => {
                setTranslateTarget(target)
                persistTranslateTarget(target)
              }}
            >
              <span className="tts-card-value">{effectiveTranslateTarget}</span>
              <span className="tts-card-label">目标语言</span>
            </DropdownMenu>
            {translation.truncated && (
              <p className="reader-toc-empty">
                选中内容超过 {TRANSLATE_MAX_CHARS} 字,只译了前 {TRANSLATE_MAX_CHARS} 字。
              </p>
            )}
            {translation.error !== null ? (
              <p className="ai-error" role="alert">
                {translation.error}
              </p>
            ) : (
              <p className="translate-body">
                {translation.body === ''
                  ? translation.loading
                    ? '翻译中…'
                    : '没有返回译文。'
                  : translation.body}
              </p>
            )}
            <div className="translate-foot">
              {/* 成本诚实:这译文是谁出的、用的哪个模型,直接写在卡片上。 */}
              <span className="translate-provider">{translation.provider}</span>
              <div className="translate-actions">
                {translation.lang !== null && (
                  <span className="translate-provider">源语言 {translation.lang}</span>
                )}
                <button
                  type="button"
                  className="chrome-button"
                  onClick={() => void navigator.clipboard?.writeText(translation.body)}
                  title="复制译文"
                >
                  <Copy size={12} weight="regular" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        )}

        {(lookupLoading || lookup !== null) && (
          <div
            className="lookup-card"
            style={{
              // 同翻译卡:rect.top 已是避开工具条算好的落点,这里只做视口兑底。
              top: Math.min(
                Math.max(64, lookup?.rect.top ?? selection?.rect.top ?? 100),
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

        {notice !== null && (
          <div
            className={`reader-notice${notice.danger ? ' is-danger' : ''}`}
            role={notice.danger ? 'alert' : 'status'}
            aria-live="polite"
          >
            {notice.text}
          </div>
        )}
      </div>

      {/* TTS 播放器:portal 到 body —— 退到书架听书时阅读器整体隐藏,
          播放条必须活在那层隐藏之外。.reader-scope 外壳(display:contents)
          带阅读主题变量,毛玻璃与文字色在任何阅读主题下都跟书走;它必须在
          portal 里面 —— 包在 createPortal 外面的话,变量壳会留在阅读器树里
          当空壳,播放条在 body 上直接裸奔(夜间白底深字,书名看不见)。 */}
      {ttsMounted &&
        createPortal(
          <div className="reader-scope" style={readerVars}>
            <TtsDrawer
              ref={ttsDrawerRef}
              bookHash={book.hash}
              bookTitle={title}
              bookLanguage={bookLanguage}
              coverUrl={ttsCoverUrl}
              sectionLabel={sectionLabel}
              colorScheme={theme.theme.colorScheme}
              minimized={ttsMiniVisible}
              themeVars={readerVars}
              onPlayingChange={setTtsActive}
              getSectionText={ttsGetSectionText}
              jumpSection={ttsJumpSection}
              onHighlight={(highlight) => {
                const adapter = adapterRef.current
                if (!adapter) return
                if (highlight === null) {
                  void adapter.clearTTSHighlight()
                  return
                }
                void adapter.setTTSHighlightByOffset(
                  highlight.start,
                  highlight.end,
                  highlight.color,
                )
              }}
              onExpand={() => {
                setTtsMinimized(false)
                setOpenPanel('tts')
                // 在书架展开完整播放器 = 想回到这本书。
                if (hidden) onRequestShow?.()
              }}
              onMinimize={() => setTtsMinimized(true)}
              onClose={() => {
                // 真正停止播放:TtsDrawer 的 stop() 会走 onPlayingChange(false),
                // 父层 ttsActive 同步置 false,TtsDrawer 因此卸载。会话标志一并
                // 熄灭 —— 只清 ttsActive 的话,「×」后 ttsSession 还开着,抽屉
                // 会以待机形态赖着不走(用户看到的就是「点 × 没反应」)。
                ttsDrawerRef.current?.stop()
                setTtsSession(false)
                setTtsMinimized(false)
                setOpenPanel((panel) => (panel === 'tts' ? null : panel))
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}

interface NoteEditorProps {
  readonly draft: NoteDraft
  readonly onChange: (draft: NoteDraft) => void
  readonly onSave: () => void
  readonly onCancel: () => void
}

/**
 * 划线笔记编辑器。两处复用:选区写笔记时坐在浮层里,批注列表里编辑时内联在行下。
 * 色板在这里也能改 —— 下笔那一刻决定颜色比事后补色板自然。
 */
function NoteEditor({ draft, onChange, onSave, onCancel }: NoteEditorProps) {
  return (
    <div className="note-editor">
      <p className="annotation-excerpt note-editor-quote">{draft.excerpt}</p>
      <div className="highlight-palette">
        {HIGHLIGHT_PALETTE.map((option) => (
          <button
            key={option.color}
            type="button"
            className={`highlight-swatch${draft.color === option.color ? ' is-active' : ''}`}
            style={{ background: option.color }}
            onClick={() => onChange({ ...draft, color: option.color })}
            aria-label={`${option.label}划线`}
            aria-pressed={draft.color === option.color}
            title={option.label}
          />
        ))}
      </div>
      <textarea
        className="note-input"
        rows={3}
        maxLength={NOTE_MAX_CHARS}
        value={draft.note}
        placeholder="写下你的想法…(留空保存 = 只要划线)"
        aria-label="笔记内容"
        onChange={(event) => onChange({ ...draft, note: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave()
        }}
      />
      <div className="note-editor-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave}>
          保存
        </button>
      </div>
    </div>
  )
}

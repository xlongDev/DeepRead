/**
 * FoliateAdapter — the only place in the product allowed to touch the
 * foliate-js kernel (spec §6). Implements the `ReaderEngine` contract from
 * `@deepread/reader-core`; the business layer depends solely on that contract.
 *
 * Format dispatch (see format.ts):
 * - native kernel parsers: EPUB, MOBI/AZW3, FB2, CBZ
 * - adapter-built kernel `book` objects: PDF (vendored foliate PDF adapter +
 *   PDF.js), TXT, MD
 * - CHM: rejected with BOOK_UNSUPPORTED_FORMAT (no kernel parser exists)
 */

import { AppError, ErrorCodes, toAppError } from '@deepread/shared'
import type { ChapterRule } from '@deepread/ai-core'
import {
  countChars,
  countCjkChars,
  type Annotation,
  type BookCharStats,
  type BookMetadata,
  type BookSource,
  type ReaderEngine,
  type ReaderLayout,
  type ReaderOpenInit,
  type ReaderTheme,
  type ReadingLocation,
  type SearchResult,
  type TextRange,
  type TocItem,
  type ZhConvertVariant,
} from '@deepread/reader-core'
import type {
  FoliateAnnotation,
  FoliateRenderer,
  FoliateTocItem,
  View,
  ViewLocation,
} from 'foliate-js/view.js'
import type { PDFPageColors } from './books/vendor/foliate-pdf.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { isSupported } from './format'
import { AnnotationRegistry } from './annotation-registry'
import { buildMobiBook } from './books/mobi-book'
import { buildMarkdownBook } from './books/markdown-book'
import { buildTextBook, decodeText } from './books/text-book'
import { convertSectionDocument, convertZhText, prepareZhConvert } from './zh-convert'

import 'foliate-js/view.js'

const MAX_SEARCH_RESULTS = 200
const MAX_SELECTION_TEXT = 2000
const DEFAULT_HIGHLIGHT_COLOR = '#f5d76e'
/** overlayer 的 key:TTS 洗色与用户批注共用 overlayer,但不能共用 key 空间。 */
const TTS_HIGHLIGHT_KEY = 'deepread-tts'

/**
 * 暗色主题下 PDF 重着色的膝点对比度。PDF 文字是位图抗锯齿渲染,小字号笔画
 * 的边缘像素占截面大半,线性映射下这些中灰落在 fg→bg 中段,字看着发虚;膝点
 * 把中灰推回两端让边缘归边。1.6 是「明显变实但不显脏」的中庸值;浅色主题
 * 不走这条(对比度本就富裕,膝点会让羊皮纸发脏)。
 */
const PDF_NIGHT_CONTRAST = 1.6

/**
 * 墨水样式 → 内核装饰函数。取值集合与 Rust `StoredAnnotation.style`、zod
 * `ANNOTATION_STYLES`、前端墨水行三处约定一致;任何其他值(含空串)按背景
 * 高亮收口,所以旧行和手写请求都能画出来。
 *
 * `strikethrough` / `outline` 内核也支持,但墨水行不提供 —— 删除线在阅读
 * 场景里没有语义,描边是开发期调试用的。
 */
export function overlayFuncForStyle(style: string | undefined): typeof Overlayer.highlight {
  switch (style) {
    case 'underline':
      return Overlayer.underline
    case 'squiggly':
      return Overlayer.squiggly
    default:
      return Overlayer.highlight
  }
}

/**
 * 块级元素集合 —— 与 foliate-js `tts.js` 的 `blockTags` 一致,另补 `ul`
 * (上游只列了 `ol`,是明显的不对称:`<ul><li>` 与 `<ol><li>` 应当同构)。
 *
 * 为什么需要它:`doc.body.textContent` 会把所有 text node 直接拼起来,
 * 块级元素之间**不插任何分隔符**。于是 `<h1>第三章</h1><p>正文。</p>`
 * 变成 "第三章正文。",断句器只能把它当一句 —— TTS 会连着念标题和正文,
 * 句级高亮也整个糊成一段。按块级元素边界补一个虚拟换行,标题、段落、
 * 列表项才各自成句。
 */
const BLOCK_TAGS = new Set([
  'article',
  'aside',
  'audio',
  'blockquote',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'math',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'tr',
  'ul',
])

/**
 * 遍历 section 文档,产出可朗读文本 + 文本节点到字符偏移的映射。
 *
 * 返回的 `nodes` 让 {@link findRangeByCharOffset} 能用**同一套偏移模型**
 * 把字符区间还原成 DOM Range —— 两边必须共用这个函数,否则 TTS 报的
 * 位置和正文高亮的位置会错位(多一个虚拟换行就整体偏一格)。
 *
 * @internal 导出仅为单测;产品代码请走 `getSectionText` / `setTTSHighlightByOffset`。
 */
export function walkSectionText(body: Element): {
  readonly text: string
  readonly nodes: readonly { readonly node: Text; readonly start: number }[]
} {
  const nodes: { node: Text; start: number }[] = []
  let text = ''
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text
      if (textNode.data.length === 0) return
      nodes.push({ node: textNode, start: text.length })
      text += textNode.data
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    // 脚本与样式不是正文;注音标注(ruby 的 rt)交给断句器按语言处理。
    if (tag === 'script' || tag === 'style') return
    for (const child of element.childNodes) visit(child)
    if (BLOCK_TAGS.has(tag)) text += '\n'
  }
  for (const child of body.childNodes) visit(child)
  return { text, nodes }
}

/**
 * 在 section body 内按字符 offset 找 Range。offset 必须来自
 * {@link walkSectionText} 的文本 —— 两者共用同一套块级换行规则。
 *
 * @internal 导出仅为单测。
 */
export function findRangeByCharOffset(
  body: Element,
  charStart: number,
  charEnd: number,
): Range | null {
  if (charEnd <= charStart) return null
  const doc = body.ownerDocument
  const { nodes } = walkSectionText(body)
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  for (const entry of nodes) {
    const nodeEnd = entry.start + entry.node.data.length
    if (startNode === null && nodeEnd > charStart) {
      startNode = entry.node
      startOffset = charStart - entry.start
    }
    if (nodeEnd >= charEnd) {
      endNode = entry.node
      endOffset = charEnd - entry.start
      break
    }
  }
  if (startNode === null || endNode === null) return null
  const range = doc.createRange()
  try {
    range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.data.length)))
    range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.data.length)))
  } catch {
    return null
  }
  return range
}

/**
 * Range 起点在 {@link walkSectionText} 文本里的字符偏移 —— 与
 * `getSectionText` / `SpeechUnit.start` 同一个坐标系,划词起播由此精确
 * 定位到选区所在的那一句。纯文本匹配做不到这一点:选区开头若是「了。天」
 * 这样的两字,更早的句子句尾同样包含它,会定位错到上一句;章内重复的句子
 * 更只能定位到第一次出现。
 *
 * 选区起点在文本节点里(拖选、双击选词的常见形态)才给得出;元素容器
 * (三击整段之类)与树外节点回 null,调用方还有文本匹配兜底。
 *
 * @internal 导出仅为单测;产品代码走选区回调。
 */
export function charOffsetOfRangeStart(body: Element, range: Range): number | null {
  const container = range.startContainer
  if (container.nodeType !== Node.TEXT_NODE) return null
  for (const entry of walkSectionText(body).nodes) {
    if (entry.node !== container) continue
    return entry.start + Math.min(range.startOffset, entry.node.data.length)
  }
  return null
}

export interface EngineLocation {
  readonly cfi: string | undefined
  readonly fraction: number | undefined
  readonly tocLabel: string | undefined
  readonly location: { readonly current: number; readonly total: number } | undefined
  /** Kernel spine index of the section now on screen (TTS/听书 navigation). */
  readonly sectionIndex: number | undefined
}

export interface EngineSelection {
  readonly cfi: string
  readonly text: string
  /** 选区起点在 section 文本里的字符偏移({@link walkSectionText} 坐标系,
   *  与 `SpeechUnit.start` 同一个空间);`null` = 解不出(选区从元素边界
   *  开始等),调用方退回文本匹配。TTS「从选区起播」用它精确定位。 */
  readonly start: number | null
  /** Selection bounding box in viewport coordinates, for the toolbar anchor. */
  readonly rect: { readonly top: number; readonly left: number; readonly height: number }
}

export interface EngineCallbacks {
  /** 书内 iframe 的键盘事件转发(iframe 获焦时父层 window 收不到)。 */
  onKeyDown?: (event: KeyboardEvent) => void
  /**
   * 书内 iframe 的指针活动转发(同样不跨界冒泡)。chrome auto-hide 的唤醒
   * 挂在父窗口 pointermove 上,不转的话 chrome 收起后鼠标在正文上怎么动
   * 都唤不回来 —— 设置面板/底栏全部点不到。
   */
  onPointerActivity?: () => void
  /**
   * 书内 iframe 的指针按下转发(同样不跨界冒泡)。并行阅读靠它认「这一栏被
   * 按了」:只转 pointermove 的话,在正文上点一下永远切不过去 —— 而点正文
   * 恰好是最自然的「我要读这一本」。
   */
  onPointerDown?: () => void

  onRelocate?: (location: EngineLocation) => void
  onSelection?: (selection: EngineSelection | null) => void
  onShowAnnotation?: (cfi: string) => void
}

/**
 * 在 book body 内按字符 offset 找 Range。offset 与 `getSectionText` 用的
 * 是同一个 {@link walkSectionText} 模型(块级元素后有一个虚拟换行),
 * 所以字符区间能精确落回 DOM。
 */
function titleFromName(name: string): string {
  return name.replace(
    /\.(epub|mobi|azw3?|kf8|prc|fb2|zip|cbz|pdf|txt|text|md|markdown|fbz|chm)$/i,
    '',
  )
}

/**
 * 复刻内核 `SectionProgress#getSection` 的切分:全书比例 → [section 序号,
 * 栏内比例]。内核那个类是私有字段,拿不到;但边界数组有公开的
 * `getSectionFractions()`(每项已 +EPSILON,与内核自用的一致)。
 */
function splitSectionFraction(view: View, frac: number): [number, number] {
  if (!(frac > 0)) return [0, 0]
  const bounds = view.getSectionFractions()
  if (frac >= 1) return [Math.max(0, bounds.length - 2), 1]
  let index = bounds.findIndex((x) => x > frac) - 1
  if (index < 0) return [0, 0]
  // 与内核一致:跳过零尺寸 section(边界重合 = 没有内容,除零会产出 NaN)。
  while (index + 1 < bounds.length - 1 && nextBound(bounds, index) - boundAt(bounds, index) <= 0) {
    index++
  }
  const start = boundAt(bounds, index)
  const width = nextBound(bounds, index) - start
  return [index, width > 0 ? (frac - start) / width : 0]
}

function boundAt(bounds: readonly number[], index: number): number {
  return bounds[index] ?? 0
}

function nextBound(bounds: readonly number[], index: number): number {
  return bounds[index + 1] ?? 1
}

/**
 * 把「汇报口径」的栏内比例换算成内核分数锚点期望的口径。
 *
 * 内核 relocate 汇报的 fraction **不是**当前列的列内比例,而是「页尾」位置:
 * paginator 的 detail.fraction = (page-1)/(pages-2) 只是列比例,View 的
 * #onRelocate 会把它交给 SectionProgress.getProgress(index, fraction, size),
 * 而那里 `nextSize = size + pageFraction * sizeInSection`(progress.js)——
 * 汇报值 = 当前页**结束处**的全书字符比例。于是文本页 p(1 起)汇报 p/textPages。
 *
 * 分数锚点的落页是 `round(a * (textPages-1)) + 1`。要让落点正好是「汇报
 * local 的那一页」,就需要 `round(a * (textPages-1)) = round(local * textPages) - 1`
 * —— 先按汇报口径反解出文本页序号,再减掉页尾那一页。textPages 取目标 section
 * 渲染后的真实值(paginator.pages - 2),所以锚点传**函数**:内核在 section 加载
 * 完之后才调它(paginator #display),那时 renderer.pages 已经有效。
 *
 * 连续滚动(scrolled)模式不校正:那儿 detail.size 不下发,汇报值就是精确的
 * 滚动比例,锚点即原始值。
 *
 * @internal 导出仅为单测;产品代码走 {@link FoliateAdapter.goTo}。
 */
export function alignedAnchorFor(local: number, pages: number | undefined): number {
  // textPages <= 1 时任何锚点都落在唯一一页,没有可校正的空间。
  if (pages === undefined || !(pages > 3)) return local
  const textPages = pages - 2
  const target = Math.min(textPages - 1, Math.max(0, Math.round(local * textPages) - 1))
  return target / (textPages - 1)
}

function alignedAnchor(view: View, local: number): number {
  return alignedAnchorFor(local, view.renderer.pages)
}

/** 排版字体栈:键为 ReaderLayout.fontFamily 的具名档位(跨平台系统字体)。 */
const FONT_STACKS: Readonly<Record<string, string>> = {
  // 系统默认:跟随 OS 界面字体(macOS 苹方 / Windows 雅黑)。
  system:
    '-apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", "NSimSun", "Noto Serif CJK SC", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", "BiauKai", "Noto Serif CJK SC", serif',
  heiti:
    '"Heiti SC", "STHeiti", "SimHei", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif',
  sans: '-apple-system, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
}

function resolveFontStack(fontFamily: string | undefined): string | undefined {
  if (fontFamily === undefined) return undefined
  const named = FONT_STACKS[fontFamily]
  if (named) return named
  if (fontFamily === 'wenkai') return '"LXGW WenKai", "Songti SC", serif'
  // 用户导入字体:fontFamily 即字体的 display name。
  return `"${fontFamily.replace(/["\\]/g, '')}", "PingFang SC", sans-serif`
}

function buildReaderCSS(
  theme: ReaderTheme,
  layout: {
    fontSize?: number
    lineHeight?: number
    fontFamily?: string
    paragraphMargin?: number
    fontWeight?: number
    writingMode?: 'horizontal-tb' | 'vertical-rl'
  },
  flow: 'paginated' | 'scrolled',
  fontFaces?: string,
): string {
  const fontStack = resolveFontStack(layout.fontFamily)
  return [
    ...(fontFaces ? [fontFaces] : []),
    `html { font-size: ${layout.fontSize ?? 16}px; --theme-bg-color: ${theme.background}; }`,
    // 书写方向:竖排(传统中文)或强制横排。undefined = 原书自己的方向。
    // ⚠️ html 与 body 必须同时写,不能只写 body:内核 paginator 的竖排模型是
    // 「multicol 列沿纵向堆叠」——只有 body 竖排而 html 保持 horizontal-tb
    // 时,列沿块轴(横向)延伸,被 overflow:hidden 裁掉且量不到,expand() 按
    // 内容高度永远只算出 1 页,多页章节只剩第一页(浏览器实测)。
    // html 也竖排后列沿纵向向下堆叠,expand() 量的 Range 高度跨列,pageCount
    // 正确;竖排的 direction 计算值仍是 ltr(rtl 保持 false),#scrollToPage
    // 取正 offset 走 scrollTop —— 与 readest fork 的
    // `this.#rtl && !this.#vertical` 守卫同语义(1.0.1 无此守卫,所以竖排
    // 绝不能把 rtl 翻成 true,负 offset 会被 clamp 回 0 = 白屏)。
    ...(layout.writingMode !== undefined
      ? [`html, body { writing-mode: ${layout.writingMode} !important; }`]
      : []),
    ...(layout.lineHeight !== undefined
      ? [`body { line-height: ${layout.lineHeight} !important; }`]
      : []),
    // 段间距:仅当用户显式选择时注入,undefined 保持原书段落排版。
    ...(layout.paragraphMargin !== undefined
      ? [
          `p { margin-block-start: ${layout.paragraphMargin}em !important; margin-block-end: ${layout.paragraphMargin}em !important; }`,
        ]
      : []),
    // 字重:覆盖正文级元素但不碰标题——标题保留书籍自己的层级。
    ...(layout.fontWeight !== undefined
      ? [`body, p, li, dd, blockquote, div { font-weight: ${layout.fontWeight} !important; }`]
      : []),
    ...(fontStack ? [`body { font-family: ${fontStack} !important; }`] : []),
    `html, body { background: ${theme.background} !important; color: ${theme.foreground} !important; }`,
    // 滚动模式内核把上下 padding 清零,这里由我们补回舒适的阅读留白
    ...(flow === 'scrolled' ? [`body { padding: 56px 0 120px !important; }`] : []),
  ].join('\n')
}

export class FoliateAdapter implements ReaderEngine {
  #view: View | null = null
  readonly #host: HTMLElement
  readonly #callbacks: EngineCallbacks
  /** 标注注册表:翻页会卸载/重建 section 的 overlayer,而内核只回放搜索
   *  结果、不回放标注 —— 每次 create-overlayer 都要按 index 把这一章的
   *  标的重画一遍,否则「翻页回来划线还在」只剩运气。 */
  readonly #annotations = new AnnotationRegistry()
  /** 已经挂上 create-overlayer 监听的 renderer:view.open 每次都换一个新的
   *  paginator,WeakSet 按实例去重,不会在同一个上挂两条。 */
  readonly #watchedRenderers = new WeakSet<object>()
  #theme: ReaderTheme | null = null
  #layout: {
    fontSize?: number
    lineHeight?: number
    fontFamily?: string
    paragraphMargin?: number
    fontWeight?: number
    writingMode?: 'horizontal-tb' | 'vertical-rl'
  } = {}
  #flow: 'paginated' | 'scrolled' = 'paginated'
  #fontFaces: string | undefined
  #pageMargin: number | undefined
  /** 简繁转换档位;在每次 section load 时应用(见 load 钩子)。 */
  #zhVariant: ZhConvertVariant = 'none'
  #bookCharStats: BookCharStats | null = null
  #bookCharStatsComputed = false
  /** 当前 TTS 洗色挂在哪个 overlayer 上;null = 没有洗色。overlayer 随
   *  section 的 content 一起创建/销毁,切章时旧的那个连文档一起没。 */
  #ttsOverlayer: Overlayer | null = null
  /** 最近一次 `getSectionText` 命中的 section index。TTS 高亮的 offset
   *  就来自那次文本,必须落在同一个 content 上,否则 Range 越界。 */
  #lastTextIndex: number | undefined
  /**
   * 宿主尺寸变了就重算栏宽。
   *
   * 观察对象是**宿主**而不是 window:单本全屏时两者等价,旧写法一直"碰巧
   * 对";但并行阅读把宿主压成半屏后,视口宽度会让栏宽比宿主还宽 → 内核按
   * 它排版,横向裁字。宿主尺寸同时覆盖窗口缩放、全屏切换、分隔条拖动三种
   * 变化,一个观察者管完,顺带少一个全局监听。
   */
  readonly #onHostResize = (): void => {
    if (this.#view && !this.#view.isFixedLayout && this.#pageMargin !== undefined) {
      this.#requireView().renderer.setAttribute(
        'max-inline-size',
        this.#maxInlineSize(this.#pageMargin, this.#layout.writingMode === 'vertical-rl'),
      )
    }
  }
  #hostObserver: ResizeObserver | null = null
  #destroyed = false
  #adapterBuiltText: { format: 'txt' | 'md'; title: string; text: string } | null = null
  /** 用户章节规则(空 = 只用内置规则);rebuildChapters 时整体替换。 */
  #chapterRules: readonly ChapterRule[] = []
  /** 已装 renderer 守卫的 view:按实例只装一次(双适配器共用时后者重装亦无害)。 */
  #guardedViews = new WeakSet<View>()
  /** 已挂过跨文档事件转发的 section doc(同一个 doc 会被 load 重复投递)。 */
  #wiredDocs = new WeakSet<Document>()
  /** 已下发给 vendored foliate-pdf.js 的页面重着色序列化键(去重用,见
   *  #applyPDFPageColors);null = 从未下发。 */
  #pdfColorsKey: string | null = null
  /** 固定排版当前 section index(最近一次 relocate;见 #applyPDFPageColors)。 */
  #fixedLayoutIndex: number | undefined

  constructor(host: HTMLElement, callbacks: EngineCallbacks = {}) {
    this.#host = host
    this.#callbacks = callbacks
    // jsdom / 早期运行环境没有 ResizeObserver:没有它就退回「只在 setLayout
    // 时算一次」,不挡开书。
    if (typeof ResizeObserver !== 'undefined') {
      this.#hostObserver = new ResizeObserver(this.#onHostResize)
      this.#hostObserver.observe(host)
    }
  }

  #applyStyles(): void {
    const view = this.#view
    if (!view || view.isFixedLayout || !this.#theme) return
    view.renderer.setStyles?.(
      buildReaderCSS(this.#theme, this.#layout, this.#flow, this.#fontFaces),
    )
  }

  /**
   * 把「当前 renderer 一定挂着 `animated`」变成不变量。
   *
   * foliate 的 view.open() 每次开书都新建 paginator 并赋给 view.renderer,
   * 后到的 open 会把先到者挂上的属性一起换掉。两个适配器共用一个 view
   * (StrictMode 双挂载的采用路径)时两次 open 并发,竞态胜出的那次开书
   * 会留下一个没有 animated 的 paginator:内核 `#turnPage` 的 wait(100)
   * debounce 复活,「翻页闪一下」跟着复活(Chromium 实测复现率约 1/3,
   * 只在 open() 里事后补挂补不及这个竞态)。在实例上拦 renderer 赋值,
   * 换谁给谁补挂。
   */
  #guardRendererAnimated(view: View): void {
    if (this.#guardedViews.has(view)) return
    this.#guardedViews.add(view)
    let current: FoliateRenderer | undefined = view.renderer
    Object.defineProperty(view, 'renderer', {
      configurable: true,
      get: () => current,
      set: (renderer: FoliateRenderer | undefined) => {
        current = renderer
        renderer?.setAttribute('animated', '')
      },
    })
    // 采用孤儿 view(它已经开过书)时,给手上的这个补挂。
    current?.setAttribute('animated', '')
  }

  #requireView(): View {
    if (this.#view) return this.#view
    // Adopt an orphaned view left in the host by a destroyed sibling adapter
    // (StrictMode's double-mount races) instead of stacking another one —
    // an unattached kernel view has no renderer and only pollutes the host.
    const existing = this.#host.querySelector('foliate-view') as View | null
    const view = existing ?? (document.createElement('foliate-view') as View)
    view.addEventListener('relocate', (event) => {
      const detail = (event as CustomEvent).detail as ViewLocation
      // Some custom-book sections report a non-finite fraction; the UI slider
      // and percent readout must never see NaN (spec §132: progress integrity).
      const fraction = Number.isFinite(detail.fraction) ? detail.fraction : undefined
      this.#callbacks.onRelocate?.({
        cfi: detail.cfi,
        fraction,
        tocLabel: detail.tocItem?.label,
        location: detail.location,
        sectionIndex: typeof detail.index === 'number' ? detail.index : undefined,
      })
      // 固定排版的当前 section index:PDF 主题重着色要靠它把「重渲染当前
      // spread」表达成 goTo({index})(内核自己解析 section → spread 与左右
      // 侧)。翻页/导航每次都会发 relocate,所以它始终是当前值。
      // 注意取 section.current 而不是顶层 index —— foliate-js 1.0.1 的
      // relocate detail 由 SectionProgress.getProgress 产出,只有
      // section:{current,total}(项目里的 ViewLocation 类型多声明了一个
      // 运行时并不存在的顶层 index)。
      const sectionIndex = detail.section?.current
      if (typeof sectionIndex === 'number') this.#fixedLayoutIndex = sectionIndex
    })
    view.addEventListener('load', (event) => {
      const { doc, index } = (event as CustomEvent).detail as { doc: Document; index: number }
      // 跨文档事件转发按 doc 只装一次:内核会把同一个 Document 重复投递给
      // load(重渲染/换栏宽都会触发),不设防的话 keydown 监听累积 —— 实测
      // 一次方向键翻出 3 页(3 份监听都转了同一次按键)。
      if (this.#wiredDocs.has(doc)) return
      this.#wiredDocs.add(doc)
      // 简繁转换:内核 load 钩子在量版/渲染之前触发(paginator 的 onLoad
      // 先于 getDirection/render),这里同步改写文本节点,分页量到的就是
      // 转换后的版面。固定排版(PDF 文本层)不转——那层是选区影子文本。
      if (this.#zhVariant !== 'none' && !view.isFixedLayout) {
        const variant = this.#zhVariant
        convertSectionDocument(doc, (text) => convertZhText(text, variant))
      }
      // 内核翻页后 iframe 会自行获焦,方向键从此落在 iframe 文档里,
      // 必须在这里转发,父层 window 才能持续收到切页按键。
      doc.addEventListener('keydown', (domEvent) => {
        this.#callbacks.onKeyDown?.(domEvent)
      })
      // 同理,指针活动也不跨界:chrome 收起后靠它唤醒(见 onPointerActivity)。
      doc.addEventListener('pointermove', () => {
        this.#callbacks.onPointerActivity?.()
      })
      doc.addEventListener('pointerdown', () => {
        this.#callbacks.onPointerDown?.()
      })
      doc.addEventListener('pointerup', () => {
        const selection = doc.getSelection()
        // 空选区的这一下只当作「点空白」:收起划词工具条/面板。翻页不走
        // 点击——只认翻页按钮、键盘与触控板滑动(点按翻页误触太多:关工具
        // 条、点已有划线,都会被 250ms 延迟的判定翻走页)。
        if (!selection || selection.isCollapsed) {
          this.#callbacks.onSelection?.(null)
          return
        }
        const range = selection.getRangeAt(0)
        const text = selection.toString().slice(0, MAX_SELECTION_TEXT)
        if (!text.trim()) {
          this.#callbacks.onSelection?.(null)
          return
        }
        const rect = range.getBoundingClientRect()
        // The range rect is relative to the section iframe; translate it into
        // window coordinates so the UI can anchor fixed-position toolbars.
        const frame = doc.defaultView?.frameElement?.getBoundingClientRect()
        const offsetX = frame?.x ?? 0
        const offsetY = frame?.y ?? 0
        this.#callbacks.onSelection?.({
          cfi: this.#requireView().getCFI(index, range),
          text,
          // 与 getSectionText 同一套偏移模型:起播定位用,解不出时调用方
          // 退回文本匹配。
          start: charOffsetOfRangeStart(doc.body, range),
          rect: {
            top: rect.top + offsetY,
            left: rect.left + offsetX,
            height: rect.height,
          },
        })
      })
    })
    view.addEventListener('draw-annotation', (event) => {
      const { draw, annotation } = (event as CustomEvent).detail as {
        draw: (func: typeof Overlayer.highlight, opts?: { color?: string }) => void
        annotation: FoliateAnnotation
      }
      // annotation 是内核回传的原始对象,style 走索引签名(unknown)——
      // 渲染层按字符串收口,非三态一律当背景高亮。
      const style = typeof annotation.style === 'string' ? annotation.style : undefined
      draw(overlayFuncForStyle(style), {
        color: annotation.color ?? DEFAULT_HIGHLIGHT_COLOR,
      })
    })
    view.addEventListener('show-annotation', (event) => {
      const { value } = (event as CustomEvent).detail as { value: string }
      this.#callbacks.onShowAnnotation?.(value)
    })
    this.#view = view
    this.#guardRendererAnimated(view)
    if (!existing) this.#host.append(view)
    return view
  }

  async open(source: BookSource, init?: ReaderOpenInit): Promise<void> {
    // Idempotent per adapter: a re-open (StrictMode double-effect, book
    // switch) tears down the previous renderer first, otherwise the kernel
    // appends a second paginator below the first and the live one renders
    // off-screen.
    await this.close()
    if (this.#destroyed) return
    // 上一本书的 relocate index 作废:留着的话,本次 open 里的 setTheme 会
    // 拿着旧 index 去 goTo,把新书跳到错误的页(见 #applyPDFPageColors)。
    this.#fixedLayoutIndex = undefined
    if (!isSupported(source.format)) {
      throw new AppError(
        ErrorCodes.bookUnsupportedFormat,
        `CHM 尚不支持:${source.name ?? '该文件'}。`,
      )
    }
    try {
      const response = await fetch(source.url)
      if (this.#destroyed) return
      if (!response.ok) {
        throw new AppError(ErrorCodes.bookOpenFailed, `无法读取书籍数据(${source.url})。`)
      }
      const blob = await response.blob()
      // The kernel dispatches zip-based formats by file extension/type, which a
      // bare blob URL cannot express — always hand it a properly named File.
      const file = new File([blob], source.name ?? 'book', { type: blob.type })

      switch (source.format) {
        case 'pdf': {
          const { buildPdfBook } = await import('./books/pdf-book')
          await this.#requireView().open(await buildPdfBook(file))
          break
        }
        case 'mobi':
        case 'azw3': {
          await this.#requireView().open(await buildMobiBook(file))
          break
        }
        case 'txt': {
          const text = decodeText(await file.arrayBuffer())
          this.#adapterBuiltText = { format: 'txt', title: titleFromName(file.name), text }
          await this.#requireView().open(
            buildTextBook(text, titleFromName(file.name), {
              chapterRules: this.#chapterRules,
            }),
          )
          break
        }
        case 'md': {
          const text = decodeText(await file.arrayBuffer())
          this.#adapterBuiltText = { format: 'md', title: titleFromName(file.name), text }
          await this.#requireView().open(buildMarkdownBook(text, titleFromName(file.name)))
          break
        }
        default:
          await this.#requireView().open(file)
      }
    } catch (error) {
      throw toAppError(error, ErrorCodes.bookParseFailed)
    }
    if (this.#destroyed) return
    const view = this.#requireView()
    this.#watchSectionReload(view)
    // 持久化排版必须先于首次导航落地(见 ReaderOpenInit):内核在每个 section
    // 挂载时读文档计算样式定 vertical/rtl,open() 之后才下发的 writing-mode
    // 只会把首节留在原书几何里。renderer 在 view.open() 时已建好,这里的
    // setTheme/setLayout 走的就是常规属性 + setStyles 通路。
    if (init?.theme !== undefined) await this.setTheme(init.theme)
    if (init?.layout !== undefined) await this.setLayout(init.layout)
    if (init?.fontFaces !== undefined) await this.setFontFaces(init.fontFaces)
    this.#applyStyles()
    // The paginator only renders on explicit navigation (kernel contract), so
    // land on the book's reading start; persisted-position restore then
    // navigates again from the UI layer. Adapter-built books (TXT/MD) must go
    // through their anchored href — an integer index lands one column into
    // the page strip (see sprint notes).
    if (source.format === 'txt' || source.format === 'md') {
      await view.goTo('s0')
    } else {
      await view.goToTextStart()
    }
  }

  /** Decoded source text, only for adapter-built books (TXT/MD). */
  getSourceText(): string | null {
    return this.#adapterBuiltText?.text ?? null
  }

  getAdapterBuiltFormat(): 'txt' | 'md' | null {
    return this.#adapterBuiltText?.format ?? null
  }

  /** Rebuild the book from repaired text and redisplay at its first section. */
  async replaceSource(text: string): Promise<void> {
    const built = this.#adapterBuiltText
    if (!built) {
      throw new AppError(ErrorCodes.systemValidation, '当前书籍不支持文内替换。')
    }
    const view = this.#requireView()
    const book =
      built.format === 'md'
        ? buildMarkdownBook(text, built.title)
        : buildTextBook(text, built.title)
    await view.open(book)
    this.#watchSectionReload(view)
    this.#adapterBuiltText = { ...built, text }
    this.#bookCharStatsComputed = false
    this.#applyStyles()
    await view.goTo('s0')
  }

  /**
   * Chapter reconstruction (spec §15): rebuild a TXT book's sections with the
   * user's chapter rules (merged with the built-in rule inside ai-core). Pass
   * null to return to the built-in rule only. Returns the section count.
   */
  async rebuildChapters(rules: readonly ChapterRule[] | null): Promise<number> {
    const built = this.#adapterBuiltText
    if (!built || built.format !== 'txt') {
      throw new AppError(ErrorCodes.systemValidation, '章节重建目前仅支持 TXT 书籍。')
    }
    this.#chapterRules = rules ?? []
    const view = this.#requireView()
    await view.open(
      buildTextBook(built.text, built.title, {
        chapterRules: this.#chapterRules,
      }),
    )
    this.#watchSectionReload(view)
    this.#applyStyles()
    this.#bookCharStatsComputed = false
    await view.goTo('s0')
    return view.book.sections.length
  }

  async close(): Promise<void> {
    this.#view?.close()
    // overlayer 随 view 一起销毁,登记不摘的话下次开书会试图重放上一本书
    // 的标注(CFI 在新书里解析不出来,一条条 catch 里空转)。
    this.#annotations.clear()
    // overlayer 随 view 一起销毁,引用不摘的话下次 #clearTtsWash 会
    // 在已卸载的 SVG group 上 remove。
    this.#ttsOverlayer = null
  }

  async destroy(): Promise<void> {
    this.#destroyed = true
    this.#hostObserver?.disconnect()
    this.#hostObserver = null
    await this.close()
    this.#view?.remove()
    this.#view = null
  }

  async getMetadata(): Promise<BookMetadata> {
    const view = this.#requireView()
    const metadata = view.book.metadata ?? {}
    const author = metadata.author
    return {
      title: metadata.title ?? '',
      authors: typeof author === 'string' ? [author] : (author ?? []),
      language:
        typeof metadata.language === 'string'
          ? metadata.language
          : (metadata.language?.[0] ?? undefined),
      publisher: metadata.publisher ?? undefined,
      description: metadata.description ?? undefined,
    }
  }

  async getTableOfContents(): Promise<readonly TocItem[]> {
    const view = this.#requireView()
    const toc = ((await view.book.toc) ?? []) as FoliateTocItem[]
    // 目录标题与正文同档位转换,侧栏不出现"正文繁、目录简"的错位。
    const convertLabel = (label: string): string =>
      this.#zhVariant === 'none' ? label : convertZhText(label, this.#zhVariant)
    const mapItems = (items: readonly FoliateTocItem[]): TocItem[] =>
      items
        .filter((item) => typeof item.label === 'string' && item.label.length > 0)
        .map((item) => ({
          id: item.href ?? item.label ?? '',
          title: convertLabel(item.label ?? ''),
          ...(item.href !== undefined ? { href: item.href } : {}),
          children: item.subitems ? mapItems(item.subitems) : [],
        }))
    return mapItems(toc)
  }

  async getCurrentLocation(): Promise<ReadingLocation> {
    const view = this.#requireView()
    const last = view.lastLocation
    if (!last) return { progress: 0 }
    return {
      ...(last.cfi !== undefined ? { cfi: last.cfi } : {}),
      progress: last.fraction ?? 0,
    }
  }

  async goTo(location: ReadingLocation): Promise<void> {
    const view = this.#requireView()
    if (location.cfi !== undefined) {
      await view.goTo(location.cfi)
    } else if (location.href !== undefined) {
      const resolved = await view.goTo(location.href)
      // The kernel's page-1 anchor convention lands one column into the strip
      // for adapter-built books, leaving the viewport on a blank column.
      // Re-anchor on the target section's first element so the content is
      // actually on screen (CFI locations already anchor precisely).
      const index = resolved?.index
      const content =
        index !== undefined ? view.renderer.getContents().find((x) => x.index === index) : undefined
      if (content) {
        const range = content.doc.createRange()
        range.selectNodeContents(content.doc.body)
        view.renderer.scrollToAnchor?.(range)
      }
    } else if (view.isFixedLayout) {
      // 固定排版(PDF)没有 foliate-paginator 那套页栅,fraction 导航沿用内核
      // 原路径(它的 renderer 连 goTo 都没有,见 #applyPDFPageColors 的可选调用)。
      await view.goToFraction(location.progress)
    } else {
      await this.#goToFractionAligned(view, location.progress)
    }
  }

  /**
   * 按全书比例跳转,落点与内核的进度汇报口径对齐。
   *
   * foliate-js 1.0.1 的 relocate 汇报的是「页尾」比例(SectionProgress 的
   * nextSize 多算一页,见 {@link alignedAnchor}),而分数锚点按「页首」落页
   * `round(a * (textPages-1)) + 1`。直接把汇报比例喂给 goToFraction,落点会
   * 比汇报位置多翻一页 —— 实测四处受害:刮擦拖到 20% 落在 28.6%、Home 落在
   * 16.7%(而不是 0)、恢复进度永远多翻一页;并行阅读的联动继承这个偏差,
   * 两栏永远差一页(对面报 0.429,本栏落 0.571)。
   *
   * 修法:自己切 section(内核的 SectionProgress 是私有字段,但
   * `getSectionFractions()` 是公开的),再把锚点换算成内核期望的口径。换算要
   * 用目标 section 渲染后的真实页数,所以锚点传**函数** —— 内核在 section
   * 加载完之后才调它(paginator #display),那时 renderer.pages 已经有效。
   *
   * 连续滚动(scrolled)模式不校正:那儿汇报值就是精确的滚动比例。
   */
  async #goToFractionAligned(view: View, frac: number): Promise<void> {
    const [index, local] = splitSectionFraction(view, frac)
    await view.renderer.goTo?.({
      index,
      anchor: () => (view.renderer.scrolled ? local : alignedAnchor(view, local)),
    })
  }

  async nextPage(options?: { animate?: boolean }): Promise<void> {
    const view = this.#requireView()
    await this.#turnPage(view, () => view.next(), options)
  }
  async previousPage(options?: { animate?: boolean }): Promise<void> {
    const view = this.#requireView()
    await this.#turnPage(view, () => view.prev(), options)
  }

  /**
   * 翻页的动画开关。foliate-paginator 的 `animated` 布尔属性控制两件事:
   * ① `#turnPage` 末尾的 `wait(100)` debounce —— 不挂属性时每次翻页都
   *    强制空等 100ms,宿主动画(WAAPI 两段式)夹着这 100ms 空窗,用户看到
   *    的就是「翻页闪一下」;② `#scrollTo` 的 smooth 分支 —— 挂上后内核
   *    自己播 300ms easeOutQuad 滑动,是 iframe 内的真实内容运动。
   * 调用方传 `animate: false`(宿主自己包动画)时临时摘下属性、翻完恢复,
   * 不影响之后的触摸滑动 snap。
   */
  async #turnPage(
    view: View,
    turn: () => Promise<void>,
    options?: { animate?: boolean },
  ): Promise<void> {
    const animate = options?.animate ?? true
    view.renderer?.toggleAttribute('animated', animate)
    try {
      await turn()
    } finally {
      // 恢复默认态(挂上),不恢复进场时捕获的旧值:翻页期间 renderer 可能被
      // 并发开书换掉,拿旧值恢复会把已经丢失的属性永久留在 false。默认态
      // 就是 animated,见 #guardRendererAnimated。
      view.renderer?.toggleAttribute('animated', true)
    }
  }

  /** Total kernel spine sections (TTS 听书 uses this to detect book end). */
  async getSectionCount(): Promise<number> {
    return this.#requireView().book.sections.length
  }

  /**
   * Jump to a spine section by index and wait until its document is actually
   * mounted, so a follow-up `getSectionText(index)` reads the right content.
   */
  async goToSection(index: number): Promise<void> {
    const view = this.#requireView()
    await view.goTo(index)
    for (let attempt = 0; attempt < 20; attempt++) {
      if (view.renderer.getContents().some((content) => content.index === index)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * 可朗读纯文本(供 TTS 断句)。**不是** `body.textContent` —— 块级元素
   * 之间补了虚拟换行,标题/段落/列表项各自成句(见 {@link walkSectionText})。
   *
   * 指定 index 时会等目标 section 挂载(最多 2s):内核翻页/切章与 TTS 推进
   * 并不同步,若此时回退到 `contents[0]` 会读到**别的章**的文本,让语音
   * 与正文彻底错位 —— 宁可等,也不要错。
   */
  async getSectionText(index?: number): Promise<string> {
    const view = this.#requireView()
    if (index !== undefined) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const content = view.renderer.getContents().find((item) => item.index === index)
        if (content) {
          this.#lastTextIndex = index
          return walkSectionText(content.doc.body).text
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      // 等不到目标 section(内核未挂载它) —— 退回当前挂载的第一个,保证
      // 「读到的文本」和「高亮的 Range」至少落在同一个 doc 上。
      const fallback = view.renderer.getContents()[0]
      this.#lastTextIndex = fallback?.index
      return fallback ? walkSectionText(fallback.doc.body).text : ''
    }
    const content = view.renderer.getContents()[0]
    this.#lastTextIndex = content?.index
    return content ? walkSectionText(content.doc.body).text : ''
  }

  /**
   * 已有划线的选区框(宿主窗口坐标系)—— 编辑模式划词工具的锚点。
   *
   * 点中的划线没有伴随文本选区(内核只报 `show-annotation` 的 CFI),工具条
   * 因此没有 rect 可贴;这里把 CFI 解回 Range 现测一个。解不出、或所在
   * section 没挂载(翻去别的章)时回 null,调用方自行回退。
   *
   * 与 {@link EngineSelection.rect} 同一套坐标系:Range 测自 section iframe,
   * 加 iframe 边框偏移换算到宿主窗口。
   */
  rectOfAnnotation(cfi: string): EngineSelection['rect'] | null {
    try {
      const view = this.#requireView()
      const resolved = view.resolveCFI(cfi)
      const content = view.renderer.getContents().find((item) => item.index === resolved.index)
      if (!content) return null
      const anchor = resolved.anchor(content.doc)
      if (typeof anchor.getBoundingClientRect !== 'function') return null
      const rect = anchor.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      const frame = content.doc.defaultView?.frameElement?.getBoundingClientRect()
      return {
        top: rect.top + (frame?.y ?? 0),
        left: rect.left + (frame?.x ?? 0),
        height: rect.height,
      }
    } catch {
      // CFI 解不动(锚点失效、书被外部改动):不是错误,只是这一条没有锚点。
      return null
    }
  }

  /**
   * 解析 TTS 该作用在哪个已挂载 content 上:优先最近一次取文本的
   * section,退化到第一个挂载项。返回 undefined 表示一个都没挂载。
   */
  #resolveTtsContent():
    { readonly doc: Document; readonly index: number; readonly overlayer?: Overlayer } | undefined {
    const contents = this.#requireView().renderer.getContents()
    if (this.#lastTextIndex !== undefined) {
      const matched = contents.find((item) => item.index === this.#lastTextIndex)
      if (matched) return matched
    }
    return contents[0]
  }

  /**
   * 全书正文统计:逐节 createDocument(不解码图片,不挂载渲染)在后台
   * 计数,TXT/MD 直接取源文本;固定排版返回 null。结果缓存到本实例,
   * replaceSource / rebuildChapters 后作废重算。
   */
  async getBookCharStats(): Promise<BookCharStats | null> {
    if (this.#bookCharStatsComputed) return this.#bookCharStats
    const countText = (text: string): BookCharStats => ({
      total: countChars(text),
      cjk: countCjkChars(text),
    })
    if (this.#adapterBuiltText) {
      this.#bookCharStats = countText(this.#adapterBuiltText.text)
      this.#bookCharStatsComputed = true
      return this.#bookCharStats
    }
    const view = this.#requireView()
    if (view.isFixedLayout) return null
    let total = 0
    let cjk = 0
    for (const section of view.book.sections) {
      if (section.linear === 'no' || typeof section.createDocument !== 'function') continue
      try {
        const doc = await section.createDocument()
        const text = doc.body?.textContent ?? ''
        total += countChars(text)
        cjk += countCjkChars(text)
      } catch {
        // 单节解析失败不拖垮整体统计(受损章节按 0 字计)。
      }
    }
    this.#bookCharStats = { total, cjk }
    this.#bookCharStatsComputed = true
    return this.#bookCharStats
  }

  async search(query: string): Promise<readonly SearchResult[]> {
    const view = this.#requireView()
    const trimmed = query.trim()
    if (!trimmed) return []
    const results: SearchResult[] = []
    for await (const item of view.search({ query: trimmed })) {
      if (item === 'done') break
      if ('cfi' in item && item.cfi && item.excerpt) {
        results.push({ location: { cfi: item.cfi, progress: 0 }, excerpt: item.excerpt })
        if (results.length >= MAX_SEARCH_RESULTS) break
      }
    }
    return results
  }

  async getText(range?: TextRange): Promise<string> {
    const view = this.#requireView()
    const cfi = range?.start.cfi
    if (cfi !== undefined) {
      const resolved = view.resolveCFI(cfi)
      const content = view.renderer.getContents().find((x) => x.index === resolved.index)
      if (!content) return ''
      return resolved.anchor(content.doc).toString()
    }
    const content = view.renderer.getContents()[0]
    return content?.doc.body.textContent ?? ''
  }

  async createAnnotation(annotation: Annotation): Promise<void> {
    const cfi = annotation.range.start.cfi
    if (cfi === undefined) {
      throw new AppError(ErrorCodes.systemValidation, '批注缺少 CFI 锚点,无法由内核定位。')
    }
    const view = this.#requireView()
    // style 随 annotation 进内核:翻页时 draw-annotation 凭它选装饰函数,
    // 所以这里少带一个字段,划线在下一页就变回纯高亮。
    const placed = await view.addAnnotation({
      value: cfi,
      color: annotation.color,
      style: annotation.style,
    })
    // 内核回执的 section index 是重放的钥匙:create-overlayer 响时只有
    // 这一章的标注需要重画。内核总给回执(见 view.js addAnnotation 的
    // return),万一带不上 index,这条就只画在当前章、不参与重放。
    this.#annotations.set(annotation.id, {
      cfi,
      color: annotation.color,
      style: annotation.style,
      ...(typeof placed?.index === 'number' ? { index: placed.index } : {}),
    })
  }

  async removeAnnotation(annotationId: string): Promise<void> {
    const cfi = this.#annotations.cfiOf(annotationId)
    if (cfi === undefined) return
    await this.#requireView().deleteAnnotation({ value: cfi })
    this.#annotations.delete(annotationId)
  }

  /**
   * 把属于 `index` 这一章的标注重画一遍(内核新建 overlayer 之后调用)。
   *
   * 单个 CFI 定位失败(书被外部改动、锚点失效)只跳过那一条 —— 其余划线
   * 照常重放,一条坏锚点不该抹掉整章的画。
   */
  async #replayAnnotations(index: number): Promise<void> {
    const view = this.#view
    if (!view) return
    for (const entry of this.#annotations.forSection(index)) {
      try {
        await view.addAnnotation({ value: entry.cfi, color: entry.color, style: entry.style })
      } catch {
        // 锚点失效:内核 resolveNavigation 已经自己 log 过,这里安静跳过。
      }
    }
  }

  /**
   * 盯住 section 的重建:renderer 每建一个新 overlayer(翻页走远又回来、
   *  首次加载),就把那一章的标的重放上去。
   *
   * 挂在 `view.renderer` 而不是 view 元素上:`create-overlayer` 由 paginator
   *  派发且不冒泡,view 自己的监听是内核内部用的(只负责 attach),挂错了
   *  地方永远等不到事件。view.open 每次换新 paginator,所以按实例去重。
   */
  #watchSectionReload(view: View): void {
    const renderer = view.renderer as unknown as {
      addEventListener?: (type: string, listener: (event: Event) => void) => void
    } | null
    if (!renderer?.addEventListener || this.#watchedRenderers.has(renderer)) return
    this.#watchedRenderers.add(renderer)
    renderer.addEventListener('create-overlayer', (event) => {
      const detail = (event as CustomEvent).detail as { index?: number } | null
      if (typeof detail?.index === 'number') void this.#replayAnnotations(detail.index)
    })
  }

  /**
   * TTS 洗色:把 [charStart, charEnd) 区间画成高亮,并把对应 Range 滚入视口
   * 中央。foliate-js 在 paginated 模式下会按需跨页,scrolled 模式下走原生
   * 滚动。
   *
   * offset 必须来自最近一次 `getSectionText` 的文本(同一个
   * {@link walkSectionText} 模型),且洗色落在**同一个 section doc** 上 ——
   * 之前这里写死 `getContents()[0]`,而文本可能取自别的 section,Range
   * 于是越界、高亮整段消失,表现为「读了几句才开始高亮」。传入空色 = 关闭。
   *
   * 画在 overlayer 上而不是 annotation:annotation 要走
   * `getCFI → addAnnotation → 下一次 deleteAnnotation` 的异步往返,一句一次
   * 还行、一词一次就是每词两次跨帧往返,洗色永远追不上声音。`Overlayer.add`
   * 按 key 覆盖,词级更新只换一个 SVG group。传入空色 = 关闭。
   */
  async setTTSHighlightByOffset(charStart: number, charEnd: number, color: string): Promise<void> {
    const view = this.#requireView()
    // 内核在切章/翻页的瞬时态里可能一个 content 都没挂载 —— 等一拍再试,
    // 否则开头几句的高亮会被整个丢掉(用户看到「读了几句才亮」)。
    let content = this.#resolveTtsContent()
    if (!content) {
      await new Promise((resolve) => setTimeout(resolve, 80))
      content = this.#resolveTtsContent()
    }
    if (!content) return
    if (color === '' || charEnd <= charStart) {
      this.#clearTtsWash()
      return
    }
    const range = findRangeByCharOffset(content.doc.body, charStart, charEnd)
    if (range === null) return
    const overlayer = content.overlayer
    if (!overlayer) return
    // 换 section overlayer 也换:先把上一个上的洗色摘掉,否则旧章文档在被
    // 卸载前会一直留着一块高亮。
    if (this.#ttsOverlayer !== null && this.#ttsOverlayer !== overlayer) {
      this.#ttsOverlayer.remove(TTS_HIGHLIGHT_KEY)
    }
    this.#ttsOverlayer = overlayer
    // 按 key 覆盖:词级更新只换一个 SVG group,不叠条。
    overlayer.add(TTS_HIGHLIGHT_KEY, range, Overlayer.highlight, { color })
    // 自动翻页 / 滚动:让 Range 落到视口中央(paginated 走分页;scrolled
    // 走原生滚动,foliate-js 内部按 flow 分发)。
    try {
      view.renderer.scrollToAnchor?.(range)
    } catch {
      // range 为空或文档正在切换 — 静默,内核 onRelocate 仍会落位。
    }
  }

  /** 清除当前 TTS 洗色(切章 / 暂停 / 关闭时用)。 */
  async clearTTSHighlight(): Promise<void> {
    this.#clearTtsWash()
  }

  #clearTtsWash(): void {
    this.#ttsOverlayer?.remove(TTS_HIGHLIGHT_KEY)
    this.#ttsOverlayer = null
  }

  /** 注入书籍文档的 @font-face 规则(内置 + 用户导入)。 */
  async setFontFaces(css: string): Promise<void> {
    this.#fontFaces = css
    this.#applyStyles()
  }

  async setTheme(theme: ReaderTheme): Promise<void> {
    this.#theme = theme
    this.#applyStyles()
    await this.#applyPDFPageColors(theme)
  }

  /**
   * PDF 页面重着色:让固定排版的画布跟上阅读主题 —— 羊皮的纸、夜间的暗底,
   * 文字与内嵌图片的处理见 vendored foliate-pdf.js 的 applyPageColors。
   *
   * 为什么不走 CSS filter:invert(1) 会把内嵌图片一并反色(照片/插图在
   * 夜间模式下变色),而重着色矩阵只改文字与纸面、图片按原色贴回。
   *
   * 每个主题都下发(不只是暗色):矩阵内部对「白纸黑字」返回 null 天然跳过,
   * 而羊皮 #f4e8cf/#3a3226 这类浅色主题正是用户要 PDF 跟上的观感;纸白主题
   * (#ffffff/#1d1b17)会得到一条近乎恒等的映射 —— PDF 文字统一成主题深灰黑,
   * 和 EPUB 一个色,代价是每页一次 getImageData/putImageData。
   *
   * 暗色主题额外开膝点对比度(PDF_NIGHT_CONTRAST):位图文字的抗锯齿边缘在
   * 线性映射下落在 fg→bg 中段,小字号看着发虚;膝点把中灰推回两端。浅色主题
   * 不加(白纸黑字对比度本就富裕,加了羊皮纸会发脏)。
   *
   * 开书时 open(init) 与 UI 随后的显式 setTheme 会带着同一主题来两遍,
   * 按序列化键去重:没变过就连 setPageColors 都不调,省掉一次整页重渲染。
   */
  async #applyPDFPageColors(theme: ReaderTheme): Promise<void> {
    const view = this.#view
    if (!view?.isFixedLayout) return
    const colors: PDFPageColors = {
      foreground: theme.foreground,
      background: theme.background,
      keepImages: true,
      contrast: theme.colorScheme === 'dark' ? PDF_NIGHT_CONTRAST : 1,
    }
    const key = `${colors.foreground}|${colors.background}|${colors.keepImages}|${colors.contrast}`
    if (key === this.#pdfColorsKey) return
    this.#pdfColorsKey = key
    const { setPageColors } = await import('./books/vendor/foliate-pdf.js')
    setPageColors(colors)
    // 没有 relocate 过 = 还没有可见的 spread(开书流程正走到这),跳过:
    // 随后首次导航渲染时读到的就是新颜色。goTo 而不是 goToSpread ——
    // 后者要调用方自己猜 spread index,而 `renderer.index` 这个 getter 在
    // 内核还没展示过 spread 时自己就会抛(内部读 undefined.right)。
    const index = this.#fixedLayoutIndex
    if (index !== undefined) {
      await (
        view.renderer as unknown as {
          goTo?: (target: { index: number }) => Promise<void>
        }
      ).goTo?.({ index })
    }
  }

  async setChineseVariant(variant: ZhConvertVariant): Promise<void> {
    this.#zhVariant = variant
    // 先把 wasm 备好:load 钩子里的转换是同步的,不能等首次 section
    // 挂载时才异步装载(那时文本已经量版,改写会错位)。
    if (variant !== 'none') await prepareZhConvert()
  }

  /**
   * 栏宽上限:随页边距联动。内核的横向留白由居中 + max-inline-size 推导
   * (margin 属性只作用于上下),所以"页边距"要可见必须同时缩栏宽——
   * 边距越大栏越窄,宽窗口下也能感知到边距变化。
   * 竖排时 inline 轴是纵向,"栏宽"即列高:按可视高度给满,不做行长收窄。
   */
  #maxInlineSize(margin: number | undefined, vertical = false): string {
    // 宿主还没布局(开书第一帧、jsdom)时 clientWidth 是 0,退回视口 ——
    // 0 不是真实尺寸,拿它算会得到一个比纸还窄的栏。
    const width = this.#host.clientWidth || window.innerWidth
    const height = this.#host.clientHeight || window.innerHeight
    if (vertical) {
      const base = margin ?? 72
      return `${this.#availableColumn(height, base * 2)}px`
    }
    if (margin === undefined) return '700px'
    const columnCap = margin <= 56 ? 820 : margin <= 80 ? 700 : margin <= 104 ? 600 : 520
    return `${Math.min(columnCap, this.#availableColumn(width, margin * 2))}px`
  }

  /**
   * 可用栏宽 = 宿主宽 - 左右边距。
   *
   * 旧写法在可用宽度不足时硬撑到 480px(「别给太窄的行长」),但那会让栏比
   * 宿主还宽 —— 内核按栏宽排版,多出来的部分直接裁掉。并行阅读的半屏宿主
   * 一定会踩到。低于舒适行长时退回宿主的 92%(边距让位给内容,字还得看全)。
   */
  #availableColumn(host: number, insets: number): number {
    const available = host - insets
    return Math.round(available < 240 ? host * 0.92 : available)
  }

  async setLayout(layout: ReaderLayout): Promise<void> {
    const view = this.#requireView()
    if (view.isFixedLayout) return
    this.#flow = layout.flow === 'scrolled' ? 'scrolled' : 'paginated'
    view.renderer.setAttribute('flow', this.#flow)
    // 内核 CSS 变量参与 calc() 长度运算,必须带 px 单位——无单位会让整条
    // grid 声明失效,列宽与上下边距全部失控(单页满宽、双页裁字)。
    // 栏宽对齐印刷排版的舒适行长,并随页边距联动(见 #maxInlineSize)。
    this.#pageMargin = layout.margin
    view.renderer.setAttribute('margin', `${layout.margin ?? 72}px`)
    view.renderer.setAttribute(
      'max-inline-size',
      this.#maxInlineSize(layout.margin, layout.writingMode === 'vertical-rl'),
    )
    view.renderer.setAttribute('gap', layout.pageMode === 'dual' ? '4%' : '7%')

    // Dual page only makes sense on wide paginated surfaces; the kernel picks
    // its column count from these two attributes.
    view.renderer.setAttribute('max-column-count', layout.pageMode === 'dual' ? '2' : '1')
    // Whole-layout replace: omitting a field means "back to the book's own
    // typography" — merging here would make 原书 unreachable after any change.
    this.#layout = {
      ...(layout.fontSize !== undefined ? { fontSize: layout.fontSize } : {}),
      lineHeight: layout.lineHeight,
      fontFamily: layout.fontFamily,
      paragraphMargin: layout.paragraphMargin,
      fontWeight: layout.fontWeight,
      writingMode: layout.writingMode,
    }
    this.#applyStyles()
  }
}

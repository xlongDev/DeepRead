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
  type ReaderTheme,
  type ReadingLocation,
  type SearchResult,
  type TextRange,
  type TocItem,
} from '@deepread/reader-core'
import type { FoliateAnnotation, FoliateTocItem, View, ViewLocation } from 'foliate-js/view.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { isSupported } from './format'
import { AnnotationRegistry } from './annotation-registry'
import { buildMobiBook } from './books/mobi-book'
import { buildMarkdownBook } from './books/markdown-book'
import { buildTextBook, decodeText } from './books/text-book'

import 'foliate-js/view.js'

const MAX_SEARCH_RESULTS = 200
const MAX_SELECTION_TEXT = 2000
const DEFAULT_HIGHLIGHT_COLOR = '#f5d76e'
/** overlayer 的 key:TTS 洗色与用户批注共用 overlayer,但不能共用 key 空间。 */
const TTS_HIGHLIGHT_KEY = 'deepread-tts'

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
  },
  flow: 'paginated' | 'scrolled',
  fontFaces?: string,
): string {
  const fontStack = resolveFontStack(layout.fontFamily)
  return [
    ...(fontFaces ? [fontFaces] : []),
    `html { font-size: ${layout.fontSize ?? 16}px; --theme-bg-color: ${theme.background}; }`,
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
  } = {}
  #flow: 'paginated' | 'scrolled' = 'paginated'
  #fontFaces: string | undefined
  #pageMargin: number | undefined
  #bookCharStats: BookCharStats | null = null
  #bookCharStatsComputed = false
  /** 当前 TTS 洗色挂在哪个 overlayer 上;null = 没有洗色。overlayer 随
   *  section 的 content 一起创建/销毁,切章时旧的那个连文档一起没。 */
  #ttsOverlayer: Overlayer | null = null
  /** 最近一次 `getSectionText` 命中的 section index。TTS 高亮的 offset
   *  就来自那次文本,必须落在同一个 content 上,否则 Range 越界。 */
  #lastTextIndex: number | undefined
  readonly #onWindowResize = (): void => {
    // 页边距改变时栏宽随之联动(max-inline-size 由视口与边距推导),
    // 窗口缩放后必须重算,否则栏宽停留在旧尺寸上。
    if (this.#view && !this.#view.isFixedLayout && this.#pageMargin !== undefined) {
      this.#requireView().renderer.setAttribute(
        'max-inline-size',
        this.#maxInlineSize(this.#pageMargin),
      )
    }
  }
  #destroyed = false
  #adapterBuiltText: { format: 'txt' | 'md'; title: string; text: string } | null = null
  /** 用户章节规则(空 = 只用内置规则);rebuildChapters 时整体替换。 */
  #chapterRules: readonly ChapterRule[] = []

  constructor(host: HTMLElement, callbacks: EngineCallbacks = {}) {
    this.#host = host
    this.#callbacks = callbacks
    window.addEventListener('resize', this.#onWindowResize)
  }

  #applyStyles(): void {
    const view = this.#view
    if (!view || view.isFixedLayout || !this.#theme) return
    view.renderer.setStyles?.(
      buildReaderCSS(this.#theme, this.#layout, this.#flow, this.#fontFaces),
    )
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
    })
    view.addEventListener('load', (event) => {
      const { doc, index } = (event as CustomEvent).detail as { doc: Document; index: number }
      // 内核翻页后 iframe 会自行获焦,方向键从此落在 iframe 文档里,
      // 必须在这里转发,父层 window 才能持续收到切页按键。
      doc.addEventListener('keydown', (domEvent) => {
        this.#callbacks.onKeyDown?.(domEvent)
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
    if (!existing) this.#host.append(view)
    return view
  }

  async open(source: BookSource): Promise<void> {
    // Idempotent per adapter: a re-open (StrictMode double-effect, book
    // switch) tears down the previous renderer first, otherwise the kernel
    // appends a second paginator below the first and the live one renders
    // off-screen.
    await this.close()
    if (this.#destroyed) return
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
    window.removeEventListener('resize', this.#onWindowResize)
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
    const mapItems = (items: readonly FoliateTocItem[]): TocItem[] =>
      items
        .filter((item) => typeof item.label === 'string' && item.label.length > 0)
        .map((item) => ({
          id: item.href ?? item.label ?? '',
          title: item.label ?? '',
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
    } else {
      await view.goToFraction(location.progress)
    }
  }

  async nextPage(): Promise<void> {
    await this.#requireView().next()
  }

  async previousPage(): Promise<void> {
    await this.#requireView().prev()
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
  }

  /**
   * 栏宽上限:随页边距联动。内核的横向留白由居中 + max-inline-size 推导
   * (margin 属性只作用于上下),所以"页边距"要可见必须同时缩栏宽——
   * 边距越大栏越窄,宽窗口下也能感知到边距变化。
   */
  #maxInlineSize(margin: number | undefined): string {
    if (margin === undefined) return '700px'
    const columnCap = margin <= 56 ? 820 : margin <= 80 ? 700 : margin <= 104 ? 600 : 520
    const available = window.innerWidth - margin * 2
    return `${Math.max(480, Math.min(columnCap, available))}px`
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
    view.renderer.setAttribute('max-inline-size', this.#maxInlineSize(layout.margin))
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
    }
    this.#applyStyles()
  }
}

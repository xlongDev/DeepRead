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
import type {
  Annotation,
  BookMetadata,
  BookSource,
  ReaderEngine,
  ReaderLayout,
  ReaderTheme,
  ReadingLocation,
  SearchResult,
  TextRange,
  TocItem,
} from '@deepread/reader-core'
import type { FoliateAnnotation, FoliateTocItem, View, ViewLocation } from 'foliate-js/view.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { isSupported } from './format'
import { buildMobiBook } from './books/mobi-book'
import { buildMarkdownBook } from './books/markdown-book'
import { buildTextBook, decodeText } from './books/text-book'

import 'foliate-js/view.js'

const MAX_SEARCH_RESULTS = 200
const MAX_SELECTION_TEXT = 2000
const DEFAULT_HIGHLIGHT_COLOR = '#f5d76e'

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
  /** Selection bounding box in viewport coordinates, for the toolbar anchor. */
  readonly rect: { readonly top: number; readonly left: number; readonly height: number }
}

export type TapZone = 'left' | 'right' | 'center'

export interface EngineCallbacks {
  /** 书内 iframe 的键盘事件转发(iframe 获焦时父层 window 收不到)。 */
  onKeyDown?: (event: KeyboardEvent) => void

  onRelocate?: (location: EngineLocation) => void
  onSelection?: (selection: EngineSelection | null) => void
  onShowAnnotation?: (cfi: string) => void
  onTapZone?: (zone: TapZone) => void
}

function titleFromName(name: string): string {
  return name.replace(
    /\.(epub|mobi|azw3?|kf8|prc|fb2|zip|cbz|pdf|txt|text|md|markdown|fbz|chm)$/i,
    '',
  )
}

function buildReaderCSS(
  theme: ReaderTheme,
  layout: { fontSize?: number; lineHeight?: number; fontFamily?: string },
  flow: 'paginated' | 'scrolled',
  fontFaces?: string,
): string {
  const fontStack =
    layout.fontFamily === 'serif'
      ? 'var(--font-serif, Georgia, "Songti SC", serif)'
      : layout.fontFamily === 'sans'
        ? 'var(--font-sans, -apple-system, "PingFang SC", sans-serif)'
        : layout.fontFamily === 'wenkai'
          ? '"LXGW WenKai", "Songti SC", serif'
          : layout.fontFamily !== undefined
            ? // 用户导入字体:fontFamily 即字体的 display name。
              `"${layout.fontFamily.replace(/["\\]/g, '')}", "PingFang SC", sans-serif`
            : undefined
  return [
    ...(fontFaces ? [fontFaces] : []),
    `html { font-size: ${layout.fontSize ?? 16}px; --theme-bg-color: ${theme.background}; }`,
    ...(layout.lineHeight !== undefined
      ? [`body { line-height: ${layout.lineHeight} !important; }`]
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
  readonly #annotationCfis = new Map<string, string>()
  #theme: ReaderTheme | null = null
  #layout: { fontSize?: number; lineHeight?: number; fontFamily?: string } = {}
  #flow: 'paginated' | 'scrolled' = 'paginated'
  #fontFaces: string | undefined
  #tapTimer: ReturnType<typeof setTimeout> | undefined
  #destroyed = false
  #adapterBuiltText: { format: 'txt' | 'md'; title: string; text: string } | null = null
  #chapterPattern: string | undefined

  constructor(host: HTMLElement, callbacks: EngineCallbacks = {}) {
    this.#host = host
    this.#callbacks = callbacks
  }

  #applyStyles(): void {
    const view = this.#view
    if (!view || view.isFixedLayout || !this.#theme) return
    view.renderer.setStyles?.(buildReaderCSS(this.#theme, this.#layout, this.#flow, this.#fontFaces))
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
      doc.addEventListener('pointerup', (domEvent) => {
        const selection = doc.getSelection()
        if (!selection || selection.isCollapsed) {
          this.#callbacks.onSelection?.(null)
          // Page-turn zones: taps in the outer thirds of reflowable pages turn
          // the page, a tap in the middle toggles the reading chrome. The zone
          // action is deferred so a double-click word selection cancels it.
          const target = domEvent.target
          const interactive =
            target instanceof Element && target.closest('a, button, input, [role="button"]')
          if (!interactive && doc.defaultView) {
            const ratio = domEvent.clientX / Math.max(1, doc.defaultView.innerWidth)
            const zone = ratio < 0.3 ? 'left' : ratio > 0.7 ? 'right' : 'center'
            clearTimeout(this.#tapTimer)
            this.#tapTimer = setTimeout(() => this.#callbacks.onTapZone?.(zone), 250)
          }
          return
        }
        clearTimeout(this.#tapTimer)
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
      draw(Overlayer.highlight, { color: annotation.color ?? DEFAULT_HIGHLIGHT_COLOR })
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
              chapterPattern: this.#chapterPattern,
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
    this.#adapterBuiltText = { ...built, text }
    this.#applyStyles()
    await view.goTo('s0')
  }

  /**
   * Chapter reconstruction (spec §15): rebuild a TXT book's sections with a
   * user-supplied chapter-title regex. Pass null to return to the built-in
   * rule. Returns the resulting section count.
   */
  async rebuildChapters(pattern: string | null): Promise<number> {
    const built = this.#adapterBuiltText
    if (!built || built.format !== 'txt') {
      throw new AppError(ErrorCodes.systemValidation, '章节重建目前仅支持 TXT 书籍。')
    }
    if (pattern !== null && pattern.trim() !== '') {
      try {
        new RegExp(pattern) // eslint-disable-line no-new -- validation only
      } catch {
        throw new AppError(ErrorCodes.systemValidation, `无效的正则表达式:${pattern}`)
      }
    }
    this.#chapterPattern = pattern === null ? undefined : pattern.trim()
    const view = this.#requireView()
    await view.open(
      buildTextBook(built.text, built.title, {
        chapterPattern: this.#chapterPattern,
      }),
    )
    this.#applyStyles()
    await view.goTo('s0')
    return view.book.sections.length
  }

  async close(): Promise<void> {
    this.#view?.close()
    this.#annotationCfis.clear()
  }

  async destroy(): Promise<void> {
    this.#destroyed = true
    clearTimeout(this.#tapTimer)
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
   * Plain text of one mounted section (current section when index omitted).
   * Returns '' when the section document is not mounted yet.
   */
  async getSectionText(index?: number): Promise<string> {
    const view = this.#requireView()
    const contents = view.renderer.getContents()
    const content =
      (index !== undefined ? contents.find((item) => item.index === index) : undefined) ??
      contents[0]
    return content?.doc.body.textContent ?? ''
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
    await view.addAnnotation({ value: cfi, color: annotation.color })
    this.#annotationCfis.set(annotation.id, cfi)
  }

  async removeAnnotation(annotationId: string): Promise<void> {
    const cfi = this.#annotationCfis.get(annotationId)
    if (cfi === undefined) return
    await this.#requireView().deleteAnnotation({ value: cfi })
    this.#annotationCfis.delete(annotationId)
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

  async setLayout(layout: ReaderLayout): Promise<void> {
    const view = this.#requireView()
    if (view.isFixedLayout) return
    this.#flow = layout.flow === 'scrolled' ? 'scrolled' : 'paginated'
    view.renderer.setAttribute('flow', this.#flow)
    // 内核 CSS 变量参与 calc() 长度运算,必须带 px 单位——无单位会让整条
    // grid 声明失效,列宽与上下边距全部失控(单页满宽、双页裁字)。
    // 栏宽对齐印刷排版的舒适行长:单/滚 ~40 字,双页每栏 ~34 字。
    view.renderer.setAttribute('margin', `${layout.margin ?? 72}px`)
    view.renderer.setAttribute(
      'max-inline-size',
      `${layout.pageMode === 'dual' ? 620 : 700}px`,
    )

    // Dual page only makes sense on wide paginated surfaces; the kernel picks
    // its column count from these two attributes.
    view.renderer.setAttribute('max-column-count', layout.pageMode === 'dual' ? '2' : '1')
    // Whole-layout replace: omitting a field means "back to the book's own
    // typography" — merging here would make 原书 unreachable after any change.
    this.#layout = {
      ...(layout.fontSize !== undefined ? { fontSize: layout.fontSize } : {}),
      lineHeight: layout.lineHeight,
      fontFamily: layout.fontFamily,
    }
    this.#applyStyles()
  }
}

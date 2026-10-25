/**
 * Ambient type declarations for foliate-js (an untyped JS package).
 *
 * The surface below is grounded in the vendored kernel sources
 * (node_modules/foliate-js/view.js, overlayer.js, progress.js) and the
 * project README; only what this adapter uses is declared. Keep in sync
 * when bumping the kernel version.
 */

declare module 'foliate-js/view.js' {
  import type { Overlayer } from 'foliate-js/overlayer.js'

  export interface FoliateTocItem {
    label?: string
    href?: string
    subitems?: FoliateTocItem[] | null
  }

  /**
   * A fixed-layout section as loaded by the vendored PDF adapter: a blob URL
   * for the page document plus the zoom hook the renderer calls with the
   * computed scale (`width`/`height` are the page's natural CSS size).
   */
  export interface FixedLayoutPage {
    src: string
    onZoom?: (state: { doc: Document; scale: number }) => void
    width?: number
    height?: number
  }

  export interface FoliateSection {
    id?: unknown
    cfi?: string
    linear?: string
    /** Estimated content size in bytes; drives reading-progress fractions. */
    size: number
    load(): Promise<string | FixedLayoutPage>
    unload?(url: string): void
    createDocument?(): Promise<Document>
  }

  export interface FoliateMetadata {
    title?: string
    author?: string | readonly string[]
    translator?: string | readonly string[]
    language?: string | readonly string[]
    publisher?: string
    description?: string
    subject?: string | readonly string[]
    identifier?: string
    [key: string]: unknown
  }

  export interface FoliateBook {
    metadata?: FoliateMetadata
    dir?: 'ltr' | 'rtl'
    toc?: Promise<FoliateTocItem[] | null> | FoliateTocItem[] | null
    pageList?: Promise<FoliateTocItem[] | null> | FoliateTocItem[] | null
    sections: FoliateSection[]
    rendition?: {
      layout?: 'pre-paginated' | 'reflowable'
      /** Fixed-layout spread pairing, read by the kernel at `open()` time:
       *  `none` = one section per spread (单页), `auto`/absent = pair into
       *  two-page spreads on wide surfaces (双页). */
      spread?: 'auto' | 'none' | 'both' | 'portrait'
    }
    splitTOCHref?(href: string): Promise<[number, string | null]> | [number, string | null]
    getTOCFragment?(doc: Document, fragment: string | null): Element | null
    resolveHref?(href: string): Promise<{ index: number; anchor?: unknown }>
    resolveCFI?(cfi: string): { index: number; anchor: (doc: Document) => Range | Element }
    getCover?(): Promise<Blob>
    isExternal?(uri: string): boolean
    destroy?(): void
  }

  export interface ViewLocation {
    reason?: string
    range?: Range
    index: number
    fraction?: number
    cfi?: string
    tocItem?: FoliateTocItem | null
    pageItem?: FoliateTocItem | null
    location?: { current: number; next: number; total: number }
    section?: { current: number; total: number }
  }

  export type FoliateDrawFunc = (...args: unknown[]) => unknown

  export interface FoliateAnnotation {
    value: string
    color?: string
    [key: string]: unknown
  }

  export interface FoliateRenderer {
    setAttribute(name: string, value: string): void
    getAttribute(name: string): string | null
    hasAttribute(name: string): boolean
    toggleAttribute(name: string, force?: boolean): boolean
    setStyles?(css: string): void
    scrollToAnchor?(anchor: unknown, select?: boolean): Promise<void>
    /** Low-level navigation used by the adapter's aligned fraction jump (see
     *  FoliateAdapter#goToFractionAligned). A function anchor is resolved by
     *  the kernel AFTER the target section renders, when the live page count
     *  is known. Absent on the fixed-layout renderer.
     *
     *  分页档下 Range 锚点比数字比例鲁棒:内核对数字锚点按 `anchor *
     *  (textPages - 1)` 反算页号,短章(textPages = 1)恒落第 1 页;Range 走
     *  getClientRects 几何,同章 / 跨章都落得准(见 anchorRangeFor)。 */
    goTo?(target: {
      index: number
      anchor?: number | Range | ((doc: Document) => number | Range)
    }): Promise<void>
    /** Total columns of the rendered section (paginator only). */
    readonly pages?: number
    /** Column width in CSS px (paginator only):联动动画算目标滚动偏移用。 */
    readonly size?: number
    /** True while flow = scrolled (paginator only). */
    readonly scrolled?: boolean
    /** 容器滚动位置(分页 = scrollLeft,滚动 = scrollTop)。阅读尺把它当
     *  「把某一行滚到视口中间」的唯一入口 —— 内核的 scrollBy 在滚动模式下
     *  取的是 dx(见 paginator.js `#vertical ? dy : dx`),横向滚动时是空操作。 */
    containerPosition?: number
    next(distance?: number): Promise<void>
    prev(distance?: number): Promise<void>
    getContents(): { doc: Document; index: number; overlayer?: Overlayer }[]
    /** The paginator is an HTMLElement: `create-overlayer` is dispatched on
     *  it (not on the view — the event does not bubble), which is how section
     *  reloads are observed for annotation replay. The boolean `animated`
     *  attribute also lives here: it switches the kernel's own page-turn
     *  slide on/off (see FoliateAdapter.#turnPage). The fixed-layout renderer
     *  is an HTMLElement too: the adapter mounts PDF scroll pages by
     *  dispatching synthetic `load`/`relocate` events on it, which view.js
     *  re-emits on the view (see pdf-scroll.ts). */
    addEventListener(type: string, listener: (event: Event) => void): void
    dispatchEvent(event: Event): boolean
    destroy(): void
    /** HTMLElement 出身:view.open() 从不摘旧 renderer,换书/重开必须自己
     * 从影子根里摘掉(见 FoliateAdapter.#retireRenderer)。 */
    remove(): void
    /** ---- fixed-layout renderer (foliate-fxl) only ---- */
    /** Re-reads `book.rendition.spread` and rebuilds the spread grouping.
     *  The kernel computes spreads once inside its own `open()` (private
     *  field), so switching 单页/双页 at runtime means calling it again. */
    open?(book: FoliateBook): void
    getSpreadOf?(
      section: FoliateSection,
    ): { index: number; side: 'left' | 'right' | 'center' } | undefined
    goToSpread?(index: number, side?: string, reason?: string): Promise<void>
  }

  export class View extends HTMLElement {
    book: FoliateBook
    renderer: FoliateRenderer
    isFixedLayout: boolean
    lastLocation: ViewLocation | null
    open(source: FoliateBook | File | Blob | string): Promise<void>
    close(): void
    goToTextStart(): Promise<void>
    goTo(
      target: string | number | { fraction: number; [key: string]: unknown },
    ): Promise<{ index: number; anchor: (doc: Document) => Range | Element } | undefined>
    goToFraction(fraction: number): Promise<void>
    /** Resolve a navigation target (CFI / href / index / fraction) to a
     *  section index without touching the renderer. Returns undefined (after
     *  logging) when the target cannot be resolved. */
    resolveNavigation(
      target: string | number | { fraction: number; [key: string]: unknown },
    ): { index: number; anchor: (doc: Document) => Range | Element } | undefined
    /** Cumulative section boundaries (0..1) driving progress fractions.
     *  Public stand-in for the kernel's private SectionProgress. */
    getSectionFractions(): number[]
    goLeft(): Promise<void>
    goRight(): Promise<void>
    prev(distance?: number): Promise<void>
    next(distance?: number): Promise<void>
    addAnnotation(annotation: FoliateAnnotation): Promise<{ index: number; label?: string } | void>
    deleteAnnotation(
      annotation: FoliateAnnotation,
    ): Promise<{ index: number; label?: string } | void>
    getCFI(index: number, range?: Range): string
    resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range | Element }
    search(opts: { query: string; index?: number }): AsyncGenerator<
      | {
          cfi?: string
          excerpt?: string
          progress?: number
          label?: string
          subitems?: { cfi: string; excerpt: string }[]
        }
      | 'done'
    >
    clearSearch(): void
    deselect(): void
    // addEventListener is intentionally NOT redeclared: shadowing it would make
    // View incompatible with Node. Handlers cast the base Event to CustomEvent.
  }
}

declare module 'foliate-js/overlayer.js' {
  export class Overlayer {
    static highlight: (...args: unknown[]) => unknown
    static outline: (...args: unknown[]) => unknown
    static underline: (...args: unknown[]) => unknown
    static strikethrough: (...args: unknown[]) => unknown
    static squiggly: (...args: unknown[]) => unknown
    /** Paints `range` under `key`, replacing whatever that key held: a word-level
     *  update costs one SVG group, not one per word. */
    add(
      key: string,
      range: Range,
      draw: (...args: unknown[]) => unknown,
      options?: { color?: string; width?: number; radius?: number },
    ): void
    remove(key: string): void
    redraw(): void
    hitTest(event: MouseEvent): [string | null, Range | null] | null
  }
}

declare module 'foliate-js/mobi.js' {
  import type { FoliateBook } from 'foliate-js/view.js'

  export function isMOBI(file: Blob): Promise<boolean>

  export class MOBI {
    constructor(options: { unzlib: (data: Uint8Array) => Uint8Array })
    open(file: Blob): Promise<FoliateBook>
  }
}

declare module 'foliate-js/fb2.js' {
  import type { FoliateBook } from 'foliate-js/view.js'

  export function makeFB2(file: Blob): Promise<FoliateBook>
}

declare module 'foliate-js/vendor/fflate.js' {
  export function unzlibSync(data: Uint8Array): Uint8Array
}

declare module 'foliate-js/epub.js' {
  import type { FoliateBook } from 'foliate-js/view.js'

  export class EPUB {
    constructor(loader: unknown)
    init(): Promise<FoliateBook>
  }
}

declare module 'foliate-js/vendor/zip.js' {
  export function configure(options: { useWebWorkers: boolean }): void

  export interface ZipEntry {
    filename: string
    uncompressedSize: number
    getData<T>(writer: T): Promise<unknown> | undefined
  }

  export class ZipReader {
    constructor(reader: unknown)
    getEntries(): Promise<ZipEntry[]>
  }

  export class BlobReader {
    constructor(blob: Blob)
  }

  export class BlobWriter {
    constructor(type?: string)
  }

  export class TextWriter {
    constructor(encoding?: string)
  }
}

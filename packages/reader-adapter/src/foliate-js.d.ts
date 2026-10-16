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

  export interface FoliateSection {
    id?: unknown
    cfi?: string
    linear?: string
    /** Estimated content size in bytes; drives reading-progress fractions. */
    size: number
    load(): Promise<string>
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
    rendition?: { layout?: 'pre-paginated' | 'reflowable' }
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
    setStyles?(css: string): void
    scrollToAnchor?(anchor: unknown, select?: boolean): Promise<void>
    next(distance?: number): Promise<void>
    prev(distance?: number): Promise<void>
    getContents(): { doc: Document; index: number; overlayer?: Overlayer }[]
    /** The paginator is an HTMLElement: `create-overlayer` is dispatched on
     *  it (not on the view — the event does not bubble), which is how section
     *  reloads are observed for annotation replay. */
    addEventListener(type: string, listener: (event: Event) => void): void
    destroy(): void
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

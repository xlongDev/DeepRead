import type { EntityBase } from '@deepread/shared'

/**
 * Formats the foliate-js kernel really renders (spec §7: only formats that
 * are genuinely verified may be listed). `chm` is intentionally present but
 * flagged unsupported by the adapter — no kernel parser exists for it.
 */
export type BookFormat = 'epub' | 'mobi' | 'azw3' | 'fb2' | 'cbz' | 'pdf' | 'txt' | 'md' | 'chm'

/**
 * What a reader engine needs to open a book.
 * `url` is an engine-readable URL (blob URL); the engine never touches the
 * filesystem itself — file access stays in the infrastructure layer.
 * `name` carries the original file name: zip-based kernels dispatch formats
 * by extension/type, which a bare blob URL cannot express.
 */
export interface BookSource {
  readonly bookId: string
  readonly format: BookFormat
  readonly url: string
  readonly name?: string
}

export interface BookMetadata {
  readonly title: string
  readonly authors: readonly string[]
  readonly language?: string
  readonly publisher?: string
  readonly description?: string
  readonly coverUrl?: string
}

export interface TocItem {
  readonly id: string
  readonly title: string
  readonly href?: string
  readonly children: readonly TocItem[]
}

/**
 * Unified location across formats and modes (pagination vs scroll).
 * `cfi` is the canonical locator when the format supports one (EPUB);
 * `href` + `progress` keep the location meaningful for formats that do not.
 */
export interface ReadingLocation {
  readonly cfi?: string
  readonly href?: string
  /** 0..1 progress through the whole book. */
  readonly progress: number
  readonly page?: number
}

export interface TextRange {
  readonly start: ReadingLocation
  readonly end: ReadingLocation
}

export interface SearchResult {
  readonly location: ReadingLocation
  readonly excerpt: string
}

export interface Annotation extends EntityBase {
  readonly bookId: string
  readonly range: TextRange
  readonly selectedText: string
  /** Highlight color token; palette owned by the design system. */
  readonly color: string
  readonly note?: string
}

export interface ReaderTheme {
  readonly name: string
  readonly background: string
  readonly foreground: string
  readonly colorScheme: 'light' | 'dark'
}

export interface ReaderLayout {
  readonly flow: 'paginated' | 'scrolled'
  readonly pageMode: 'single' | 'dual' | 'responsive'
  /** Page margin in px, when the flow is paginated. */
  readonly margin?: number
  /** Base font size in px for reflowable content (books keep their own fonts). */
  readonly fontSize?: number
  /**
   * Line-height override for reflowable content. Omit to keep the book's own
   * leading (原版排版优先).
   */
  readonly lineHeight?: number
  /**
   * Font-family override for reflowable content (`serif` | `sans` | `heitı`).
   * Omit to keep the book's own fonts (原版排版优先).
   */
  /**
   * 排版字体:'serif' / 'sans' 是系统栈;其他字符串是具名字体
   * (内置霞鹜文楷 'LXGW WenKai' 或用户导入字体的 id)。
   */
  readonly fontFamily?: string
}

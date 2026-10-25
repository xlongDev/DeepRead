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

/** 墨水样式:与 Rust `StoredAnnotation.style` / zod `ANNOTATION_STYLES` 同集合。 */
export type AnnotationStyle = 'highlight' | 'underline' | 'squiggly'

export interface Annotation extends EntityBase {
  readonly bookId: string
  readonly range: TextRange
  readonly selectedText: string
  /** Highlight color token; palette owned by the design system. */
  readonly color: string
  /** 装饰样式;缺省 = 背景高亮(与协议层默认值同一个约定)。 */
  readonly style?: AnnotationStyle
  readonly note?: string
}

export interface ReaderTheme {
  readonly name: string
  readonly background: string
  readonly foreground: string
  readonly colorScheme: 'light' | 'dark'
}

/**
 * 简繁转换档位(与 readest 的 simplecc 变体一致):
 * s2t/t2s 基础互转;tw/hk 后缀按地区习惯;s2twp/tw2sp 额外做词汇转换。
 */
export type ZhConvertVariant =
  'none' | 's2t' | 't2s' | 's2tw' | 's2hk' | 's2twp' | 'tw2s' | 'hk2s' | 'tw2sp'

export interface ReaderLayout {
  readonly flow: 'paginated' | 'scrolled'
  readonly pageMode: 'single' | 'dual' | 'responsive'
  /**
   * 书写方向:'vertical-rl' = 竖排(传统中文从上到下、从右到左)。
   * Omit to keep the book's own writing mode (原书排版优先).
   */
  readonly writingMode?: 'horizontal-tb' | 'vertical-rl'
  /**
   * 页边距 · 上下(px),分页时生效。落到 paginator 的 `margin` 属性 ——
   * 内核的该属性只作用于上下(横向留白由居中 + 栏宽上限推导,见 marginInline)。
   */
  readonly margin?: number
  /**
   * 页边距 · 左右(px)。内核没有直接的横向边距属性,由栏宽上限
   * (max-inline-size)模拟:边距越大栏越窄,宽窗口下也能感知变化。
   * Omit = 内核默认栏宽。
   */
  readonly marginInline?: number
  /** Base font size in px for reflowable content (books keep their own fonts). */
  readonly fontSize?: number
  /**
   * Line-height override for reflowable content. Omit to keep the book's own
   * leading (原版排版优先).
   */
  readonly lineHeight?: number
  /**
   * 段间距(p 段前后外边距,单位 em)。Omit to keep the book's own
   * paragraph spacing (原书排版优先).
   */
  readonly paragraphMargin?: number
  /**
   * 段首缩进(p 的 text-indent,单位 em;0 = 不缩进)。
   * Omit to keep the book's own indentation (原书排版优先).
   */
  readonly textIndent?: number
  /**
   * 正文字重(400 常规 / 500 中等 / 700 加粗;标题不受影响)。
   * Omit to keep the book's own font weights (原书排版优先).
   */
  readonly fontWeight?: number
  /**
   * 正文字体:'serif' / 'sans' 是系统栈;其他字符串是具名字体
   * (内置霞鹜文楷 'LXGW WenKai' 或用户导入字体的 id)。
   * Omit to keep the book's own fonts (原版排版优先).
   */
  readonly fontFamily?: string
}

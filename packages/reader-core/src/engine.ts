/**
 * ReaderEngine — the single contract between the business layer and any
 * reading kernel (spec §6 / §7).
 *
 * The business layer depends ONLY on this interface. foliate-js specifics are
 * isolated inside the FoliateAdapter (Phase 1), so the kernel can be replaced
 * without touching the product.
 */

import type {
  Annotation,
  BookMetadata,
  BookSource,
  ReaderLayout,
  ReaderTheme,
  ReadingLocation,
  SearchResult,
  TextRange,
  TocItem,
} from './types'

export interface BookCharStats {
  /** 全书字数(CJK 字数 + 西文词数)。 */
  readonly total: number
  /** 其中中日韩字符数,用于混排阅读速度的加权。 */
  readonly cjk: number
}

export interface ReaderEngine {
  open(source: BookSource): Promise<void>
  close(): Promise<void>

  getMetadata(): Promise<BookMetadata>
  getTableOfContents(): Promise<readonly TocItem[]>

  getCurrentLocation(): Promise<ReadingLocation>
  goTo(location: ReadingLocation): Promise<void>
  nextPage(): Promise<void>
  previousPage(): Promise<void>

  search(query: string): Promise<readonly SearchResult[]>
  getText(range?: TextRange): Promise<string>
  /**
   * 全书正文统计(CJK 按字、西文按词计),`cjk` 是其中中日韩字数,
   * 供"全书字数"与按字数的剩余时间估算。固定排版(PDF/CBZ)无正文,
   * 返回 null。逐节在后台解析,结果随 adapter 实例缓存。
   */
  getBookCharStats(): Promise<BookCharStats | null>

  createAnnotation(annotation: Annotation): Promise<void>
  removeAnnotation(annotationId: string): Promise<void>

  setTheme(theme: ReaderTheme): Promise<void>
  setLayout(layout: ReaderLayout): Promise<void>

  destroy(): Promise<void>
}

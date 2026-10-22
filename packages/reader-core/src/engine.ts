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
  ZhConvertVariant,
} from './types'

export interface BookCharStats {
  /** 全书字数(CJK 字数 + 西文词数)。 */
  readonly total: number
  /** 其中中日韩字符数,用于混排阅读速度的加权。 */
  readonly cjk: number
}

/**
 * open() 的第二参数:开书前就要生效的排版初值。
 *
 * 为什么需要它:folio 内核在**每个 section 挂载时**读文档的计算样式来定
 * 竖排/横排(getDirection 跑在首帧绘制前),而 open() 内部紧接着就会导航到
 * 书的起始位置。若调用方在 open() 之后才下发 setTheme/setLayout,首节已经
 * 按原书自己的(通常横向)几何量版完成 —— 竖排书开篇那一页会停留在错误几何,
 * 直到该节被重新加载。把持久化排版随 open 一起下发,首节加载时就是对的。
 */
export interface ReaderOpenInit {
  readonly theme?: ReaderTheme
  readonly layout?: ReaderLayout
  /** 注入书籍文档的 @font-face 规则(内置 + 用户导入)。 */
  readonly fontFaces?: string
}

export interface ReaderEngine {
  open(source: BookSource, init?: ReaderOpenInit): Promise<void>
  close(): Promise<void>

  getMetadata(): Promise<BookMetadata>
  getTableOfContents(): Promise<readonly TocItem[]>

  getCurrentLocation(): Promise<ReadingLocation>
  goTo(location: ReadingLocation): Promise<void>
  /**
   * 翻页。`animate: false` 时内核必须瞬间完成翻页(调用方自己包了动画) —
   * foliate 的翻页默认带 100ms debounce,那段空窗露在动画中间就是用户
   * 看到的「翻页闪一下」。默认 true(内核自带的 animated 滑动)。
   */
  nextPage(options?: { animate?: boolean }): Promise<void>
  previousPage(options?: { animate?: boolean }): Promise<void>

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
  /**
   * 简繁转换档位。设置后由适配层在每次 section 挂载时应用(EPUB/TXT/MD
   * 等重排格式);固定排版(PDF)不支持。切换档位后调用方需要重开书,
   * 让已挂载的章节按新档位重新生成。
   */
  setChineseVariant(variant: ZhConvertVariant): Promise<void>

  destroy(): Promise<void>
}

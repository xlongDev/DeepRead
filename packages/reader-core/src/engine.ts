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

/**
 * search() 的可选参数。全部可省 —— 省略时行为与旧签名完全一致(整书搜完
 * 一次性返回,无进度无中止)。
 */
export interface SearchRequest {
  /** 大小写敏感(内核 searchMatcher 直通;默认不敏感)。 */
  readonly matchCase?: boolean
  /** 逐节产出已搜比例 0..1(内核 #searchBook 每搜完一节 yield 一次)。 */
  readonly onProgress?: (fraction: number) => void
  /**
   * 中止。收到中止后停止向内核拉取、立刻返回**已收集的部分结果** ——
   * 调用方自行用 signal.aborted 区分「搜完」与「停在了半路」。
   */
  readonly signal?: AbortSignal
}

export interface ReaderEngine {
  open(source: BookSource, init?: ReaderOpenInit): Promise<void>
  close(): Promise<void>

  getMetadata(): Promise<BookMetadata>
  getTableOfContents(): Promise<readonly TocItem[]>

  getCurrentLocation(): Promise<ReadingLocation>
  /**
   * 跳转。`animate: true` 时同章内的位移带滑动(并行阅读的联动用 —— 主动
   * 翻页的那一栏有内核翻页动画,被拽的这一栏不该是瞬跳)。
   */
  goTo(location: ReadingLocation, options?: { animate?: boolean }): Promise<void>
  /**
   * 翻页。`animate: false` 时内核必须瞬间完成翻页(调用方自己包了动画) —
   * foliate 的翻页默认带 100ms debounce,那段空窗露在动画中间就是用户
   * 看到的「翻页闪一下」。默认 true(内核自带的 animated 滑动)。
   */
  nextPage(options?: { animate?: boolean }): Promise<void>
  previousPage(options?: { animate?: boolean }): Promise<void>

  search(query: string, request?: SearchRequest): Promise<readonly SearchResult[]>
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

  /**
   * 阅读尺(可选能力:引擎不支持时调用方隐藏入口)。
   *
   * `null` = 关闭。打开后焦点带跟随阅读行,其余内容按 `dimOpacity` 淡化;
   * 移动走 {@link moveReadingRuler} / {@link wheelReadingRuler},走到版心末尾
   * 由引擎自己翻页,文首文末停住。固定排版与竖排暂不支持。
   */
  /**
   * 搜索命中高亮(可选能力):把目录搜索的命中处画成淡蓝高亮。翻页离开
   * 再回来要能重放(走标注注册表),新搜索/关面板时用 {@link clearSearchHits}
   * 摘除。引擎不支持时调用方静默跳过。
   */
  showSearchHits?(cfis: readonly string[]): Promise<void>
  /** 摘除全部搜索命中高亮。 */
  clearSearchHits?(): Promise<void>

  setReadingRuler?(options: ReadingRulerOptions | null): void
  /** 阅读尺上下移一行;没有尺时是空操作。 */
  moveReadingRuler?(direction: -1 | 1): Promise<void>
  /** 滚轮事件转给阅读尺:引擎内部按像素累积成行。 */
  wheelReadingRuler?(deltaY: number, deltaMode: number): void
  /** 排版/尺寸变化后重画一次(锚点会跟着重排走)。 */
  refreshReadingRuler?(): void

  /**
   * 仿真翻页(可选能力):纸叶要克隆的层 —— 正文载体(内核关闭影子根里的
   * `<iframe>`)在前,批注层(同一影子根里的 overlayer SVG)在后,按绘制
   * 顺序给出。调用方把每一层整棵克隆、按原位置铺好,就是一张和真身逐像素
   * 一致的纸叶:内核在纸叶底下瞬间翻页,纸叶再绕书脊转走露出新的一页。
   *
   * 返回空数组 = 不支持(固定排版 / 内核未就绪),调用方退回宿主层动画。
   */
  flipLeafLayers?(): readonly Element[]

  destroy(): Promise<void>
}

export interface ReadingRulerOptions {
  /** 焦点带覆盖的行数(1..10)。 */
  readonly focusLines: number
  /** 非焦点内容的不透明度(0..1)。 */
  readonly dimOpacity: number
}

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
  type BookFormat,
  type BookMetadata,
  type BookSource,
  type ReaderEngine,
  type ReaderLayout,
  type ReaderOpenInit,
  type ReaderTheme,
  type ReadingLocation,
  type ReadingRulerOptions,
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
import { PdfScrollStrip } from './pdf-scroll'
import { ReadingRuler } from './reading-ruler'
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
 * 联动对位的滑行时长:一栏(≈556px)≈ 下限,跨小半本书 ≈ 上限。与阅读尺移尺
 * 同一量级,两处手感才一致。
 */
const RELAY_ANIM_MIN_MS = 160
const RELAY_ANIM_MAX_MS = 320

/**
 * 暗色主题下 PDF 重着色的膝点对比度。PDF 文字是位图抗锯齿渲染,小字号笔画
 * 的边缘像素占截面大半,线性映射下这些中灰落在 fg→bg 中段,字看着发虚;膝点
 * 把中灰推回两端让边缘归边。1.6 是「明显变实但不显脏」的中庸值;浅色主题
 * 不走这条(对比度本就富裕,膝点会让羊皮纸发脏)。
 */
const PDF_NIGHT_CONTRAST = 1.6

/**
 * 同一个宿主上的开书串行化。
 *
 * 两个适配器可能同时盯着同一个 foliate-view:StrictMode 的双挂载、开书
 * effect 依赖(book / zhConvert)变化,都会在上一次开书还没落地时再调一次
 * open()。并发 open 的后果不是「多开一本」那么温和 —— view.open() 自己
 * 从不摘旧 renderer,每次新建一个 paginator 追加进影子根,而 view 的影子根
 * 没有任何 CSS,两个 paginator 垂直堆叠:后来者整体落在屏幕外。实测宿主
 * 820px 高时,活着的那个 iframe 落在 y≈892(820 + 默认页边距 72),读者看到
 * 一片空白,而 open() 早已 resolve(phase 照常进 reading)。
 *
 * 按宿主串起来:前一次开书没落地,后一次不许开始。并行阅读的两栏是不同
 * 宿主,互不阻塞;换书(同一宿主重开)也天然排成先后。
 */
const hostOpenChains = new WeakMap<HTMLElement, Promise<void>>()

const NOOP = (): void => {}

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
/**
 * 封面页防压扁:calibre 等工具生成的封面页常是
 * `<svg viewBox="…" preserveAspectRatio="none" width/height="100%">`,
 * 在内核的分栏 iframe 里栏框比图片矮胖,"none" 会把封面拉伸成栏框形状
 * (内核 setImageSize 的 object-fit 对内联 <svg> 无效,拦不住)。有
 * viewBox 的 SVG 统一改成 meet:保持比例居中,多出的留白交给纸色。
 * 返回改写的个数(测试用)。
 */
export function fixSvgStretch(doc: Document): number {
  let count = 0
  for (const svg of (doc.body ?? doc).querySelectorAll('svg[viewBox]')) {
    if (svg.getAttribute('preserveAspectRatio') === 'none') {
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      count++
    }
  }
  return count
}

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
/**
 * Range 的第一个可见矩形 → 它所在的**栏**的滚动偏移(分页档页对齐)。
 * 复刻内核 `#scrollToRect` 的换算(`floor(offset / size) + 1`,页号 1 起),
 * 只是自己算目标位置,好让动画有终点。少那个 +1 会整整差一栏 —— 表现为
 * 「算出来的目标就是当前位置」,动画永远不触发。
 */
function columnOffsetFor(renderer: FoliateRenderer, range: Range): number | null {
  const size = renderer.size
  if (size === undefined || !(size > 0)) return null
  let rects: DOMRectList
  try {
    rects = range.getClientRects()
  } catch {
    return null
  }
  const rect = Array.from(rects).find((r) => r.width > 0 && r.height > 0) ?? rects[0]
  if (rect === undefined) return null
  return (Math.floor(rect.left / size) + 1) * size
}

/** 把内核容器从 from 滑到 target(分页 = scrollLeft,滚动 = scrollTop)。 */
function animateContainerTo(
  renderer: FoliateRenderer,
  from: number,
  target: number,
): Promise<void> {
  const distance = Math.abs(target - from)
  const duration = Math.min(RELAY_ANIM_MAX_MS, Math.max(RELAY_ANIM_MIN_MS, distance * 0.5))
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = (now: number): void => {
      const t = Math.min(1, (now - started) / duration)
      const eased = 1 - (1 - t) ** 2
      renderer.containerPosition = Math.round(from + (target - from) * eased)
      if (t < 1) {
        requestAnimationFrame(tick)
        return
      }
      renderer.containerPosition = target
      resolve()
    }
    requestAnimationFrame(tick)
  })
}

export function alignedAnchorFor(local: number, pages: number | undefined): number {
  // textPages <= 1 时任何锚点都落在唯一一页,没有可校正的空间。
  if (pages === undefined || !(pages > 3)) return local
  const textPages = pages - 2
  const target = Math.min(textPages - 1, Math.max(0, Math.round(local * textPages) - 1))
  return target / (textPages - 1)
}

/**
 * 按节内比例在正文里找一个 Range(分页档的 goTo 锚点)。
 *
 * 段落下标 ≈ 字符比例(段长参差,但对位阅读差一两段无感),比页栅比例鲁棒:
 * 后者在 `textPages = 1` 的短章里恒落第 1 页。拿不到正文(文档正在换)返回
 * null,调用方退回比例锚点。
 */
function anchorRangeFor(view: View, local: number): Range | null {
  const doc = view.renderer.getContents()[0]?.doc
  const body = doc?.body
  if (doc === undefined || body === undefined) return null
  const blocks = [...body.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6')]
  // local 夹到 [0, length-1]:local 恰好是 1(全书最后一页)时
  // `floor(length * 1)` 会越界成 undefined,退回 body —— 而 body 的 rect 从
  // 栏首开始,目标就被算成第 1 栏,整栏往回跳(实测:联动把对面拽回书头)。
  const index = Math.min(blocks.length - 1, Math.max(0, Math.floor(blocks.length * local)))
  const node = blocks.length > 0 ? (blocks[index] ?? body) : body
  try {
    const range = doc.createRange()
    range.selectNodeContents(node)
    return range
  } catch {
    return null
  }
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

/** 等宽类元素:读者选的字体管不到它们(代码本来就该等宽)。 */
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
/** 搜索命中高亮的淡蓝:三个阅读主题上都读得到、又压得住正文。 */
const SEARCH_HIT_COLOR = 'rgba(61, 109, 235, 0.28)'

/**
 * 继承属性的覆盖总线:纯继承属性(line-height / font-family…)要压过书自己的
 * 后代类声明(calibre 的 <span class="calibreN"> 病灶),选择器必须打到后代。
 * 这条串过去在 buildReaderCSS 里逐属性复制,每修一次就是一次打地鼠 —— 现在
 * 集中成常量,下一个继承属性(font-style、letter-spacing)照抄一行,选择器
 * 口径不会再漂;测试按这条常量做不变式断言。
 */
export const INHERITANCE_BUS = 'body, body *'

function resolveFontStack(fontFamily: string | undefined): string | undefined {
  if (fontFamily === undefined) return undefined
  const named = FONT_STACKS[fontFamily]
  if (named) return named
  if (fontFamily === 'wenkai') return '"LXGW WenKai", "Songti SC", serif'
  // 用户导入字体:fontFamily 即字体的 display name。
  return `"${fontFamily.replace(/["\\]/g, '')}", "PingFang SC", sans-serif`
}

export function buildReaderCSS(
  theme: ReaderTheme,
  layout: {
    fontSize?: number
    lineHeight?: number
    fontFamily?: string
    paragraphMargin?: number
    textIndent?: number
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
    // 行高:与 font-family 同病 —— 纯继承属性,书若把 line-height 写在后代类上
    // (calibre 标题类常见),只压 body 会被继承规则甩掉,读者调行距等于没调。
    // 压到 body * 上,读者行距控制全局统一生效。
    ...(layout.lineHeight !== undefined
      ? [`${INHERITANCE_BUS} { line-height: ${layout.lineHeight} !important; }`]
      : []),
    // 段间距:仅当用户显式选择时注入,undefined 保持原书段落排版。
    ...(layout.paragraphMargin !== undefined
      ? [
          `p { margin-block-start: ${layout.paragraphMargin}em !important; margin-block-end: ${layout.paragraphMargin}em !important; }`,
        ]
      : []),
    // 段首缩进:自定义排版才注入(原书排版不下发,书自己的缩进赢)。
    // 0 = 显式关掉原书缩进 —— 必须写 0 而不是省略,否则选了「不缩进」无效。
    ...(layout.textIndent !== undefined
      ? [`p { text-indent: ${layout.textIndent}em !important; }`]
      : []),
    // 字重:与 font-family 同源 —— 要盖住 calibre 的 <span class="calibreN">
    // 行内载体(只列块级元素会漏掉它们),同时排除 h1–h6:`:not(h*)` 让标题
    // 不被这条规则匹配,书的标题 font-weight 声明(无论是否 !important)原样保留,
    // 维持书籍层级。body 本体也在内,保证 body 自己的声明被覆盖。
    ...(layout.fontWeight !== undefined
      ? [
          `body, body *:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6) { font-weight: ${layout.fontWeight} !important; }`,
        ]
      : []),
    // 字体只压 body 是错的:calibre 导出的中文书几乎每段都套一层
    // `<span class="calibreN">`,书自己的 CSS 里就写着 font-family(PingFang SC
    // / FZFangSong …),后代元素上的声明永远赢过继承下来的 body 值,body 上的
    // !important 也救不了(它只跟 body 自己的声明比)。所以压到 body * 上;
    // !important 对书里那些普通类选择器有效。等宽元素留一手,不能被读者口味换掉。
    ...(fontStack
      ? [
          `${INHERITANCE_BUS} { font-family: ${fontStack} !important; }`,
          `code, pre, kbd, samp, code *, pre *, kbd *, samp * { font-family: ${MONO_STACK} !important; }`,
        ]
      : []),
    `html, body { background: ${theme.background} !important; color: ${theme.foreground} !important; }`,
    // 夜间:书自己的配色一律作废 —— 与 font-family 同一个病,只是更致命:书的
    // CSS 把 color 打在**后代**上(calibre 导出的中文书几乎每个标题/正文都套
    // 一层 `<span class="calibreN">`,类里写死 `color: rgb(0,0,0)`),后代声明
    // 永远赢过从 body 继承下来的墨色 → 黑字留在黑纸上,完全隐形;白底块同理,
    // 底不掀掉,换了墨色照样是浅底浅字。所以两条一起压到 body * 上。
    // 浅色纸不这么干:书的颜色本来就是为白纸画的,照原样着墨才是「原书排版」。
    ...(theme.colorScheme === 'dark'
      ? [
          `body * { color: ${theme.foreground} !important; background-color: transparent !important; }`,
        ]
      : []),
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
  /** 当前在屏的搜索命中高亮 id(`search:` 命名空间)。 */
  readonly #searchHitIds = new Set<string>()
  #theme: ReaderTheme | null = null
  #layout: {
    fontSize?: number
    lineHeight?: number
    fontFamily?: string
    paragraphMargin?: number
    textIndent?: number
    fontWeight?: number
    writingMode?: 'horizontal-tb' | 'vertical-rl'
  } = {}
  #flow: 'paginated' | 'scrolled' = 'paginated'
  #fontFaces: string | undefined
  /** 页边距 · 上下(px):paginator 的 `margin` 属性(只作用于上下)。 */
  #pageMargin: number | undefined
  /** 页边距 · 左右(px):只进栏宽上限(见 #maxInlineSize)。 */
  #pageMarginInline: number | undefined
  /** 单/双页档位;与 #flow 一起构成 paginator 的版式属性(见 #applyPaginatorAttributes)。 */
  #pageMode: 'single' | 'dual' | 'responsive' = 'single'
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
   *
   * 只在档位真的变了时才落 attribute:attributeChangedCallback 对每次
   * setAttribute 都无条件 render(),而 render() 在「换章的 iframe 重载
   * 窗口」里会踩 foliate 的离窗文档(旧 view 的 iframe 刚被 #createView
   * 摘掉,#view 字段还没更新,documentElement 在、body 是 null)—— 那次
   * TypeError 会沿 RO 回调逃逸成 uncaught。尺寸变化本身由 paginator 自己
   * 的容器 RO 负责重排,这里只补「值变了但容器尺寸没变」的那一枪。
   */
  readonly #onHostResize = (): void => {
    // 边距还没下发过(开书第一帧之前):那之前 renderer 也还不存在,什么都
    // 落不了,直接收声(与旧写法一致)。
    if (this.#pageMargin === undefined && this.#pageMarginInline === undefined) return
    this.#syncMaxInlineSize()
  }
  /** 最近一次落到 renderer 上的 max-inline-size(没变就不碰,见 #onHostResize)。 */
  #lastMaxInlineSize: string | null = null
  #syncMaxInlineSize(): void {
    const view = this.#view
    const renderer = view?.renderer
    // 渲染器还没建(开书前的首帧 RO 就落在 fetch 窗口里)—— 没有它什么都
    // 落不了,别碰。固定排版不吃这组属性。
    if (!view || !renderer || view.isFixedLayout) return
    const value = this.#maxInlineSize(
      this.#pageMarginInline,
      this.#layout.writingMode === 'vertical-rl',
    )
    if (value === this.#lastMaxInlineSize) return
    this.#lastMaxInlineSize = value
    renderer.setAttribute('max-inline-size', value)
  }
  #hostObserver: ResizeObserver | null = null
  #destroyed = false
  #adapterBuiltText: { format: 'txt' | 'md'; title: string; text: string } | null = null
  /** 用户章节规则(空 = 只用内置规则);rebuildChapters 时整体替换。 */
  #chapterRules: readonly ChapterRule[] = []
  /** 已装 renderer 守卫的 view:按实例只装一次(双适配器共用时后者重装亦无害)。 */
  #guardedViews = new WeakSet<View>()
  /** 已挂滚动跟尺的 renderer:同一个 paginator 不重复挂监听。 */
  #wiredRenderers = new WeakSet<FoliateRenderer>()
  /** 已挂过跨文档事件转发的 section doc(同一个 doc 会被 load 重复投递)。 */
  #wiredDocs = new WeakSet<Document>()
  /** 已下发给 vendored foliate-pdf.js 的页面重着色序列化键(去重用,见
   *  #applyPDFPageColors);null = 从未下发。 */
  #pdfColorsKey: string | null = null
  /** 固定排版当前 section index(最近一次 relocate;见 #applyPDFPageColors)。 */
  #fixedLayoutIndex: number | undefined
  /** 可重排书籍的当前 section index(联动动画要判「同章内才能滑过去」)。 */
  #sectionIndex: number | undefined
  /** 固定排版的滚动形态(PDF 滚动模式):非空时翻页/跳转都走它,folio-fxl
   *  的 spread 渲染整个藏起(见 #setFixedLayout)。 */
  #pdfScroll: PdfScrollStrip | null = null
  /** 当前开着的书的格式:滚动条只对 PDF 挂(其余固定排版如 CBZ 的 section
   *  load() 不返回 {src,onZoom,width,height},没有可预排的自然尺寸)。 */
  #sourceFormat: BookFormat | null = null
  /** 阅读尺:焦点带 + 蒙版层,挂在宿主里、正文之外(不碰书页 DOM)。 */
  readonly #ruler: ReadingRuler
  /** 阅读尺的用户选项;null = 关着。换书/换主题后据此重挂。 */
  #rulerOptions: ReadingRulerOptions | null = null

  constructor(host: HTMLElement, callbacks: EngineCallbacks = {}) {
    this.#host = host
    this.#callbacks = callbacks
    this.#ruler = new ReadingRuler(host, () => this.#view)
    // 滚轮:关尺时不拦(滚动模式仍用原生滚动);开着尺才接管,滚轮改成移尺。
    host.addEventListener(
      'wheel',
      (event) => {
        if (this.#ruler.enabled) this.#onRulerWheel(event)
      },
      { passive: false },
    )
    // jsdom / 早期运行环境没有 ResizeObserver:没有它就退回「只在 setLayout
    // 时算一次」,不挡开书。
    if (typeof ResizeObserver !== 'undefined') {
      this.#hostObserver = new ResizeObserver(this.#onHostResize)
      this.#hostObserver.observe(host)
    }
  }

  #onRulerWheel(event: WheelEvent): void {
    event.preventDefault()
    this.#ruler.wheel(event.deltaY, event.deltaMode)
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
        this.#hardenRenderer(renderer)
      },
    })
    // 采用孤儿 view(它已经开过书)时,给手上的这个补挂。
    this.#hardenRenderer(current)
  }

  /**
   * 每个新 renderer 都要补的不变量:
   * - `animated`:内核 `#turnPage` 的 wait(100) debounce(见 #guardRendererAnimated);
   * - 滚动跟尺:尺开着时容器仍可能被**原生**滚动(进度条 / 目录跳转的动画、
   *   PageDown、滚动条拖动、触摸),带子在宿主层,不跟滚就停在旧位置。
   *   内核自带的 scroll 转发是 250ms 防抖的,等它带子早脱走了;paginator
   *   每次滚动都会 dispatch 一个不防抖的 'scroll' 事件,挂它正合适。
   */
  #hardenRenderer(renderer: FoliateRenderer | undefined): void {
    if (renderer === undefined) return
    renderer.setAttribute('animated', '')
    if (this.#wiredRenderers.has(renderer)) return
    this.#wiredRenderers.add(renderer)
    renderer.addEventListener('scroll', () => {
      this.#ruler.refresh()
    })
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
      if (typeof sectionIndex === 'number') {
        this.#fixedLayoutIndex = sectionIndex
        this.#sectionIndex = sectionIndex
      }
      // 阅读尺:翻页/滚动都由 relocate 告知。换章时锚点所在的文档被卸载,
      // 尺按新页重新播种(见 ReadingRuler#onRelocate)。
      this.#ruler.onRelocate()
    })
    view.addEventListener('load', (event) => {
      const { doc, index } = (event as CustomEvent).detail as { doc: Document; index: number }
      // 跨文档事件转发按 doc 只装一次:内核会把同一个 Document 重复投递给
      // load(重渲染/换栏宽都会触发),不设防的话 keydown 监听累积 —— 实测
      // 一次方向键翻出 3 页(3 份监听都转了同一次按键)。
      if (this.#wiredDocs.has(doc)) return
      this.#wiredDocs.add(doc)
      // 下面的接线是「这一节能不能用」的命根子(翻页转发、划选、滚轮),
      // 一条都不能少;简繁转换与阅读尺刷新是装饰,却都要读文档几何 ——
      // 文档正在换页/卸载的窗口里量版面可能抛。装饰失败不能带走接线,
      // 所以顺序是「先接线、后装饰」,装饰整段包在 try 里。
      // 内核翻页后 iframe 会自行获焦,方向键从此落在 iframe 文档里,
      // 必须在这里转发,父层 window 才能持续收到切页按键。
      doc.addEventListener('keydown', (domEvent) => {
        this.#callbacks.onKeyDown?.(domEvent)
      })
      // 同理,指针活动也不跨界:chrome 收起后靠它唤醒(见 onPointerActivity)。
      doc.addEventListener('pointermove', () => {
        this.#callbacks.onPointerActivity?.()
      })
      // 滚轮同样不跨界,而且这里必须显式 passive:false —— Document 上的
      // wheel 监听默认被动,preventDefault 会被忽略,尺和正文会一起动。
      doc.addEventListener(
        'wheel',
        (wheelEvent) => {
          if (this.#ruler.enabled) this.#onRulerWheel(wheelEvent)
        },
        { passive: false },
      )
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
      try {
        // 简繁转换:内核 load 钩子在量版/渲染之前触发(paginator 的 onLoad
        // 先于 getDirection/render),这里同步改写文本节点,分页量到的就是
        // 转换后的版面。固定排版(PDF 文本层)不转——那层是选区影子文本。
        if (this.#zhVariant !== 'none' && !view.isFixedLayout) {
          const variant = this.#zhVariant
          convertSectionDocument(doc, (text) => convertZhText(text, variant))
        }
        // 封面页防压扁(见 fixSvgStretch):同在量版之前改写,分页量到的
        // 就是修正后的版面。
        fixSvgStretch(doc)
        // 阅读尺:新章节的正文挂上了。开书时尺比正文先就位(播种扫不到行),
        // 这是「第一次能扫到行」的信号,顺手重画/补播种。
        this.#ruler.refresh()
      } catch (error) {
        // 降级而不是扩散:尺等下一次 relocate / 滚动还会再画,简繁没转成
        // 也只是本节显示原文 —— 都不能让这里变成 uncaught。
        console.error('reader section decoration failed', error)
      }
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

  /**
   * 在 view 上开一本书。view.open() 自己从不摘旧 renderer —— 每次新建一个
   * paginator 追加进影子根,而 view 的影子根没有任何 CSS,两个 paginator 会
   * 垂直堆叠,后来者整体落在屏幕外(宿主只有一屏高)。所以每次 open 之前必须
   * 显式 close:同一适配器换书、采用兄弟适配器留下的 view、replaceSource /
   * rebuildChapters 重建章节,走的都是这一条。
   *
   * close 之后还要把版式属性补回新 renderer:属性是落在 paginator 元素上
   * 的,新建的那个一套都没有(flow / margin / gap / 栏宽 / 栏数),不补的话
   * 重建章节后的正文会回落内核默认值。
   */
  async #openOnView(view: View, book: Parameters<View['open']>[0]): Promise<void> {
    this.#retireRenderer(view)
    // 新 renderer 一套属性都没有:栏宽跟踪值作废,逼 #syncMaxInlineSize
    // 重新落一次(否则「值没变」会让新 paginator 永远收不到栏宽)。
    this.#lastMaxInlineSize = null
    await view.open(book)
    if (!view.isFixedLayout) this.#applyPaginatorAttributes(view)
  }

  /**
   * 收掉 view 上当前的 renderer,容忍内核的一个坑。
   *
   * foliate-js 1.0.1 的 `Paginator#destroy` 第 1158 行是裸的
   * `this.#view.destroy()`:renderer 建好了但还没显示过任何一节(#display
   * 没跑过,内部 #view 还是 undefined)、或者已经 destroy 过(#view 被置
   * null)时,这一行抛 `Cannot read properties of undefined (reading
   * 'destroy')`。这两种 renderer 都没有加载中的文档,回收只剩「从影子根
   * 里摘掉」这一步 —— 摘不掉才会真的出问题(view.open 不摘旧 renderer,
   * 两个 paginator 会在无 CSS 的影子根里垂直堆叠,后来者整体落在屏幕外)。
   * 所以:先走内核正路,炸了就手动摘,别让异常顺着开书链往外爬。
   */
  #retireRenderer(view: View): void {
    const renderer = view.renderer
    if (!renderer) return
    try {
      view.close()
    } catch (error) {
      console.error('reader renderer retire failed; detaching it directly', error)
      renderer.remove()
    }
  }

  async open(source: BookSource, init?: ReaderOpenInit): Promise<void> {
    // 串行化(见 hostOpenChains):这一次要等同一宿主上前一次开书落地。
    const previous = hostOpenChains.get(this.#host) ?? Promise.resolve()
    const run = previous.then(() => this.#openBook(source, init))
    // 链上存不 reject 的版本:一次开书失败不能把后续所有开书都堵死。
    hostOpenChains.set(this.#host, run.then(NOOP, NOOP))
    return run
  }

  async #openBook(source: BookSource, init?: ReaderOpenInit): Promise<void> {
    // Idempotent per adapter: a re-open (StrictMode double-effect, book
    // switch) tears down the previous renderer first, otherwise the kernel
    // appends a second paginator below the first and the live one renders
    // off-screen.
    await this.close()
    if (this.#destroyed) return
    // 上一本书的 relocate index 作废:留着的话,本次 open 里的 setTheme 会
    // 拿着旧 index 去 goTo,把新书跳到错误的页(见 #applyPDFPageColors)。
    this.#fixedLayoutIndex = undefined
    this.#sectionIndex = undefined
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
        // 桌面端最常见原因是书文件被移动/删除(asset 协议 404)。给用户能读的
        // 书名和下一步,别把百分号编码的 asset URL 整串甩到报错页;URL 与
        // 状态码进 context,排查走日志。
        throw new AppError(
          ErrorCodes.bookOpenFailed,
          `无法读取「${source.name ?? '该书'}」的文件,它可能已被移动或删除,请重新导入。`,
          { context: { url: source.url, status: response.status } },
        )
      }
      const blob = await response.blob()
      // The kernel dispatches zip-based formats by file extension/type, which a
      // bare blob URL cannot express — always hand it a properly named File.
      const file = new File([blob], source.name ?? 'book', { type: blob.type })

      // 造书与开书分开:开关都要走 #openOnView(它负责先收旧 renderer)。
      let book: Parameters<View['open']>[0]
      switch (source.format) {
        case 'pdf': {
          const { buildPdfBook } = await import('./books/pdf-book')
          book = await buildPdfBook(file)
          break
        }
        case 'mobi':
        case 'azw3': {
          book = await buildMobiBook(file)
          break
        }
        case 'txt': {
          const text = decodeText(await file.arrayBuffer())
          this.#adapterBuiltText = { format: 'txt', title: titleFromName(file.name), text }
          book = buildTextBook(text, titleFromName(file.name), {
            chapterRules: this.#chapterRules,
          })
          break
        }
        case 'md': {
          const text = decodeText(await file.arrayBuffer())
          this.#adapterBuiltText = { format: 'md', title: titleFromName(file.name), text }
          book = buildMarkdownBook(text, titleFromName(file.name))
          break
        }
        default:
          book = file
      }
      // fetch / 解码 / 造书都是异步的:这段窗口里被销毁(StrictMode 换挂载、
      // 依赖变化)不能只是放行 —— 现造的书开上去也没人认领,半个 paginator
      // 会留在宿主机里被下一个适配器采用(见 #retireRenderer 的内核坑)。
      if (this.#destroyed) return
      await this.#openOnView(this.#requireView(), book)
    } catch (error) {
      throw toAppError(error, ErrorCodes.bookParseFailed)
    }
    if (this.#destroyed) {
      // 开书过半被销毁:renderer 已经建好甚至正在加载,但 goTo / 主题 /
      // 排版都还没下发,没人会再用它。就地收掉再摘 view —— 宿主机回到
      // 「没有 foliate-view」的干净状态,下一个适配器重新开一本,而不是
      // 采用这个半成品去踩内核的空 #view。
      this.#retireRenderer(this.#requireView())
      this.#view?.remove()
      this.#view = null
      return
    }
    const view = this.#requireView()
    this.#watchSectionReload(view)
    this.#sourceFormat = source.format
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
    } else if (this.#pdfScroll) {
      // PDF 滚动模式:初始位置由滚动条自己落在第 0 页(#setFixedLayout 的
      // goToIndex),再让内核翻一次会把 spread 渲染器重新拽出来。
    } else {
      await view.goToTextStart()
    }
    // 尺是跨书偏好:换了一本还要在(close 时被摘掉),首屏落位之后再播种,
    // 否则播种扫描量的是上一本书的版面。
    this.#applyRuler()
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
    await this.#openOnView(view, book)
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
    await this.#openOnView(
      view,
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
    this.#pdfScroll?.destroy()
    this.#pdfScroll = null
    this.#sourceFormat = null
    // 换书 = 新 renderer(属性全套重来):跟踪值作废,否则新 paginator 会
    // 因为「值没变」而永远收不到 max-inline-size(回落内核默认 720px)。
    this.#lastMaxInlineSize = null
    // 蒙版层挂在宿主上、不是书的一部分:换书必须摘掉,否则新书的正文上会
    // 留着一块按旧锚点算出来的暗区。
    this.#ruler.setOptions(null)
    // 滚动模式把 spread 渲染器藏起来了(display:none),不在这里恢复的话,
    // 下一本书按分页档位打开会是一片空白。
    if (this.#view) this.#view.style.display = ''
    if (this.#view) this.#retireRenderer(this.#view)
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

  async goTo(location: ReadingLocation, options?: { readonly animate?: boolean }): Promise<void> {
    const view = this.#requireView()
    // PDF 滚动模式:内核的 renderer 整个藏起了,导航改走滚动条。比例口径与
    // 滚动上报同源(页 + 页内),不经 SectionProgress 的页尾口径。
    if (this.#pdfScroll) {
      if (location.cfi !== undefined) {
        this.#pdfScroll.goToIndex(view.resolveCFI(location.cfi).index)
      } else if (location.href !== undefined) {
        // resolveNavigation 失败时内核只 console.error 并返回 undefined。
        const resolved = await view.resolveNavigation(location.href)
        if (resolved) this.#pdfScroll.goToIndex(resolved.index)
      } else {
        this.#pdfScroll.scrollToFraction(location.progress)
      }
      return
    }
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
    } else if (options?.animate === true) {
      await this.#goToFractionAnimated(view, location.progress)
    } else {
      await this.#goToFractionAligned(view, location.progress)
    }
  }

  /**
   * 带滑动的比例跳转(并行阅读的联动专用)。
   *
   * 内核对 `scrollToAnchor` 这条路径固定用 reason='navigation',而
   * `#scrollTo` 的动画分支只认 'snap'/smooth —— 所以 goTo 永远是瞬跳,
   * 联动那一栏就「没有翻页动画」。这里自己插值 containerPosition 补上。
   *
   * 只补**同章内**的位移:跨章要换 section,内核那一下是内容替换,没有
   * 「滑过去」的语义,让它照旧瞬移(和主动翻页跨章时一样)。
   */
  async #goToFractionAnimated(view: View, frac: number): Promise<void> {
    const renderer = view.renderer
    const [index, local] = splitSectionFraction(view, frac)
    if (index !== this.#sectionIndex) {
      await this.#goToFractionAligned(view, frac)
      return
    }
    const range = anchorRangeFor(view, local)
    const target = range === null ? null : columnOffsetFor(renderer, range)
    const from = renderer.containerPosition ?? 0
    if (target === null || Math.abs(target - from) <= 1) {
      await this.#goToFractionAligned(view, frac)
      return
    }
    await animateContainerTo(renderer, from, target)
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
   *
   * 分页档的锚点是 **Range** 而不是页栅比例:内核 `#scrollToAnchor` 的 paginated
   * 分支按 `anchor * (textPages - 1)` 反算页号,章短时 `textPages = 1`,乘出来恒
   * 为 0 —— 章内定位整个退化成「永远翻到第 1 页」。实测后果:并行阅读联动时
   * 对面那一栏怎么都拽不动(目标页就是当前页)。Range 走 getClientRects 几何,
   * 不经过页栅,同章 / 跨章都落得准。
   */
  async #goToFractionAligned(view: View, frac: number): Promise<void> {
    const [index, local] = splitSectionFraction(view, frac)
    await view.renderer.goTo?.({
      index,
      anchor: () => (view.renderer.scrolled ? local : (anchorRangeFor(view, local) ?? local)),
    })
  }

  async nextPage(options?: { animate?: boolean }): Promise<void> {
    const view = this.#requireView()
    // PDF 滚动模式:翻页钮/方向键 = 滚一屏(与 EPUB 滚动模式同语义)。
    if (this.#pdfScroll) {
      this.#pdfScroll.scrollByViewport(1)
      return
    }
    await this.#turnPage(view, () => view.next(), options)
  }

  async previousPage(options?: { animate?: boolean }): Promise<void> {
    const view = this.#requireView()
    if (this.#pdfScroll) {
      this.#pdfScroll.scrollByViewport(-1)
      return
    }
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
    if (this.#pdfScroll) {
      this.#pdfScroll.goToIndex(index)
      return
    }
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
    let batch = 0
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
      // 每 20 节让出主线程一拍:createDocument 是整节 DOM 解析,大书几百节
      // 一口气跑完会卡死开书后的第一屏(滚动/翻页输入全被占住)。yield 到
      // 宏任务队列,输入事件得以插队处理。
      if (++batch % 20 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve))
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
    // 滚动模式里 spread 渲染器整个是空的,正文在滚动条已挂载的页里。
    const contents: { doc: Document; index: number }[] = this.#pdfScroll
      ? this.#pdfScroll.mountedDocs()
      : view.renderer.getContents()
    const cfi = range?.start.cfi
    if (cfi !== undefined) {
      const resolved = view.resolveCFI(cfi)
      const content = contents.find((x) => x.index === resolved.index)
      if (!content) return ''
      return resolved.anchor(content.doc).toString()
    }
    const content = contents[0]
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

  /**
   * 目录搜索的命中高亮:命中处画淡蓝高亮,翻页走远再回来经注册表重放。
   * 与用户划线同一条 addAnnotation 通路,但 id 挂在 `search:` 命名空间下,
   * 清除时只摘自己的,不碰划线。
   */
  async showSearchHits(cfis: readonly string[]): Promise<void> {
    await this.clearSearchHits()
    const view = this.#requireView()
    let n = 0
    for (const cfi of cfis) {
      if (!cfi) continue
      try {
        const placed = await view.addAnnotation({
          value: cfi,
          color: SEARCH_HIT_COLOR,
          style: 'highlight',
        })
        const id = `search:${n++}`
        this.#searchHitIds.add(id)
        this.#annotations.set(id, {
          cfi,
          color: SEARCH_HIT_COLOR,
          style: 'highlight',
          ...(typeof placed?.index === 'number' ? { index: placed.index } : {}),
        })
      } catch {
        // 单条锚点失效跳过:搜索高亮是辅助视觉,不该因为一条坏 CFI 整体失败。
      }
    }
  }

  async clearSearchHits(): Promise<void> {
    const view = this.#view
    if (!view) return
    for (const id of this.#searchHitIds) {
      const cfi = this.#annotations.cfiOf(id)
      if (cfi === undefined) continue
      try {
        await view.deleteAnnotation({ value: cfi })
      } catch {
        // 内核里已经不在了(翻页销毁等):摘登记即可。
      }
      this.#annotations.delete(id)
    }
    this.#searchHitIds.clear()
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
    // 蒙版是「纸色 + 不透明度」算死的:换主题必须重算,否则夜间留着白纱。
    this.#applyRuler()
    await this.#applyPDFPageColors(theme)
  }

  /* ---------------- 阅读尺 ---------------- */

  setReadingRuler(options: ReadingRulerOptions | null): void {
    this.#rulerOptions = options
    this.#applyRuler()
  }

  async moveReadingRuler(direction: -1 | 1): Promise<void> {
    await this.#ruler.move(direction)
  }

  wheelReadingRuler(deltaY: number, deltaMode: number): void {
    this.#ruler.wheel(deltaY, deltaMode)
  }

  refreshReadingRuler(): void {
    this.#ruler.refresh()
  }

  /**
   * 仿真翻页的纸叶素材(契约见 `ReaderEngine.flipLeafLayers`)。
   *
   * 只服务重排排版:固定排版(PDF/CBZ)的页是画布,克隆 `<canvas>` 只拿到
   * 一个空壳 —— 位图不随节点走,纸叶会是一张白纸。而且 foliate-fxl 的
   * `getContents()` 把没在显示的 spread 一起交出来,那里直接返回空更省心。
   */
  flipLeafLayers(): readonly Element[] {
    const view = this.#view
    if (!view || view.isFixedLayout) return []
    const layers: Element[] = []
    for (const content of view.renderer.getContents()) {
      const frame = content.doc?.defaultView?.frameElement
      // 影子根里的载体是另一个文档的 Element,`instanceof` 不认,看标签名。
      if (frame?.tagName !== 'IFRAME') continue
      const rect = frame.getBoundingClientRect()
      // 藏起来的那一页(display:none)量出来是 0,别拿它当纸叶。
      if (rect.width <= 0 || rect.height <= 0) continue
      layers.push(frame)
      // 批注层不在书页文档里 —— 它是同一影子根里叠在 iframe 上的一张 SVG,
      // 不一起克隆的话,翻页那半秒里划过的线会整片消失。
      const overlay = content.overlayer?.element
      if (overlay) layers.push(overlay)
    }
    return layers
  }

  /**
   * 把用户选项 + 当前主题纸色一起下发给尺。固定排版(PDF/CBZ)与竖排不挂:
   * 前者的正文是画布 + 影子文本层,命中测试量不出「行」;后者「行」是竖列,
   * 蒙版得整块换轴,留待需要时再做。
   */
  #applyRuler(): void {
    const options = this.#rulerOptions
    const vertical = this.#layout.writingMode === 'vertical-rl'
    if (options === null || this.#view?.isFixedLayout === true || vertical) {
      this.#ruler.setOptions(null)
      return
    }
    this.#ruler.setOptions({
      focusLines: options.focusLines,
      dimOpacity: options.dimOpacity,
      background: this.#theme?.background ?? '#ffffff',
    })
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
    // 滚动模式:重渲染已挂载的页(setPageColors 是模块级状态,onZoom 重跑
    // 一次就会读到新色),不碰藏起的 spread 渲染器。
    if (this.#pdfScroll) {
      this.#pdfScroll.rerenderMounted()
      return
    }
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
   * 栏宽上限:随左右页边距联动。内核的横向留白由居中 + max-inline-size 推导
   * (margin 属性只作用于上下),所以"左右边距"要可见必须同时缩栏宽——
   * 边距越大栏越窄,宽窗口下也能感知到边距变化。
   * 竖排时 inline 轴是纵向,"栏宽"即列高:竖排没有左右边距的对应物
   * (横向是列间距),按上下边距推导列高上限,与拆分前的单值行为一致。
   */
  #maxInlineSize(marginInline: number | undefined, vertical = false): string {
    // 宿主还没布局(开书第一帧、jsdom)时 clientWidth 是 0,退回视口 ——
    // 0 不是真实尺寸,拿它算会得到一个比纸还窄的栏。
    const width = this.#host.clientWidth || window.innerWidth
    const height = this.#host.clientHeight || window.innerHeight
    if (vertical) {
      const base = this.#pageMargin ?? 72
      return `${this.#availableColumn(height, base * 2)}px`
    }
    if (marginInline === undefined) return '700px'
    // 档位表(UI 侧 PAGE_MARGIN_INLINE_OPTIONS:24/48/72/96),阈值取档位
    // 中点。标准档(48)= 旧「特窄」的栏宽;特窄(24)再放宽一档。
    const columnCap =
      marginInline <= 36 ? 880 : marginInline <= 60 ? 820 : marginInline <= 84 ? 700 : 600
    return `${Math.min(columnCap, this.#availableColumn(width, marginInline * 2))}px`
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

  /**
   * 版式属性落到 renderer 上(flow / margin / gap / 栏宽 / 栏数)。
   *
   * 这些属性挂在 paginator 元素上,而 view.open() 每次都换一个新的 ——
   * 开书(含重建章节)之后必须补一遍,否则新 renderer 回落内核默认值。
   * 读取的全部是实例上持久化的当前档位,不随调用时机变化。
   */
  #applyPaginatorAttributes(view: View): void {
    const renderer = view.renderer
    renderer.setAttribute('flow', this.#flow)
    // margin 属性 = 上下边距(左右走 #syncMaxInlineSize 的栏宽上限)。
    renderer.setAttribute('margin', `${this.#pageMargin ?? 72}px`)
    // 与 #onHostResize 共用同一条落点:值没变就不碰 attribute,省掉一次
    // 无条件 render()。
    this.#syncMaxInlineSize()
    renderer.setAttribute('gap', this.#pageMode === 'dual' ? '4%' : '7%')
    renderer.setAttribute('max-column-count', this.#pageMode === 'dual' ? '2' : '1')
  }

  async setLayout(layout: ReaderLayout): Promise<void> {
    const view = this.#requireView()
    if (view.isFixedLayout) {
      await this.#setFixedLayout(view, layout)
      return
    }
    this.#flow = layout.flow === 'scrolled' ? 'scrolled' : 'paginated'
    this.#pageMargin = layout.margin
    this.#pageMarginInline = layout.marginInline
    this.#pageMode = layout.pageMode
    // Whole-layout replace: omitting a field means "back to the book's own
    // typography" — merging here would make 原书 unreachable after any change.
    // ⚠️ 必须先于 #applyPaginatorAttributes:#syncMaxInlineSize 读
    // #layout.writingMode 定竖排的列高上限,反序会让切竖排后的第一帧用
    // 上一档方向的算式(要等下一次 setLayout / 宿主 resize 才纠正)。
    this.#layout = {
      ...(layout.fontSize !== undefined ? { fontSize: layout.fontSize } : {}),
      lineHeight: layout.lineHeight,
      fontFamily: layout.fontFamily,
      paragraphMargin: layout.paragraphMargin,
      textIndent: layout.textIndent,
      fontWeight: layout.fontWeight,
      writingMode: layout.writingMode,
    }
    this.#applyPaginatorAttributes(view)
    this.#applyStyles()
    // 阅读尺:双页要在栏底先走右栏再翻页;重排之后锚点行换位置了,重画。
    this.#ruler.setDualPage(layout.pageMode === 'dual' && this.#flow === 'paginated')
    this.#ruler.refresh()
  }

  /**
   * 固定排版(PDF/CBZ)的「方式」切换。
   *
   * foliate-fxl 的 spread 分组在 renderer.open() 时一次算定(#spreads 是私有
   * 字段,没有 setter),所以改单页/双页只能重跑 open() 让它按新的
   * `rendition.spread` 重算,再把当前页恢复回去 —— 这就是旧代码直接 return
   * 导致「排版修改无效」的根因:单页/双页从未下达到过内核。
   *
   * 滚动形态只有 PDF 有(页文档带自然尺寸与 onZoom,见 pdf-scroll.ts):CBZ 的
   * section load() 只给一个 URL,没有可预排的尺寸,继续走 spread。
   */
  async #setFixedLayout(view: View, layout: ReaderLayout): Promise<void> {
    // 滚动形态只有 PDF 有:页文档带自然尺寸与 onZoom(见 pdf-scroll.ts)。其余
    // 固定排版(CBZ 等)的 section load() 只给一个 URL,没有可预排的尺寸,
    // 滚动请求按分页处理 —— 退化成单页(滚动档下 pageMode 本就是 single),
    // 与 UI 侧对 CBZ 隐藏「滚动」档的口径一致。
    if (layout.flow === 'scrolled' && this.#sourceFormat === 'pdf') {
      if (this.#pdfScroll) return
      this.#pdfScroll = new PdfScrollStrip(this.#host, view.book, {
        onPageMounted: (doc, index) => this.#dispatchSectionLoad(view, doc, index),
        onScroll: (index, fraction) => this.#reportFixedScroll(view, index, fraction),
      })
      // spread 渲染整个藏起:滚动条铺满宿主,两边同时可见会重影。
      view.style.display = 'none'
      await this.#pdfScroll.mount()
      this.#pdfScroll.goToIndex(this.#fixedLayoutIndex ?? 0)
      return
    }
    if (this.#pdfScroll) {
      this.#pdfScroll.destroy()
      this.#pdfScroll = null
      view.style.display = ''
    }
    // 'none' = 每页一个 spread(单页);'auto' = 宽面左右配对(双页,竖窗自动单页)
    // —— 与 foliate-paginator 的 max-column-count 同语义。
    const spread = layout.pageMode === 'dual' ? 'auto' : 'none'
    const rendition = (view.book.rendition ??= {})
    if (rendition.spread === spread) return
    rendition.spread = spread
    view.renderer.open?.(view.book)
    // open() 把 #index 重置为 -1,当前页要靠 getSpreadOf 自己找回来(内核
    // getter 在未展示过 spread 时会抛,不能读 renderer.index)。
    const index = Math.min(Math.max(this.#fixedLayoutIndex ?? 0, 0), view.book.sections.length - 1)
    const section = view.book.sections[index]
    const at = section ? view.renderer.getSpreadOf?.(section) : undefined
    await view.renderer.goToSpread?.(at?.index ?? 0, at?.side)
  }

  /** 把页文档挂载搬进内核的 load 通道:folio-fxl 收下 → view.js #onLoad →
   *  #emit('load') 到 view 上,引擎挂的划词/按键转发/简繁监听原样生效。 */
  #dispatchSectionLoad(view: View, doc: Document, index: number): void {
    view.renderer.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
  }

  /**
   * 滚动位置 → relocate。detail 与 foliate-fxl #reportLocation 同形,但
   * `size: 0`(pageFraction):SectionProgress 的 nextSize 会按页内比例精确
   * 插值(fraction = (sizeBefore + f·sizeInSection) / sizeTotal),而不是
   * spread 模式那个「页尾」口径(见 #goToFractionAligned 的坑)。
   */
  #reportFixedScroll(view: View, index: number, fraction: number): void {
    view.renderer.dispatchEvent(
      new CustomEvent('relocate', {
        detail: { reason: 'scroll', range: null, index, fraction, size: 0 },
      }),
    )
  }
}

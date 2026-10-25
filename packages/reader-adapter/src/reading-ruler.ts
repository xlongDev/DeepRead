/**
 * 阅读尺(Reading Ruler)—— 聚焦当前阅读行、淡化其余内容。
 *
 * 语义照搬 ColorTxt 的「阅读尺」(适合注意力不容易集中的人):焦点带跟着阅读
 * 行往下走,别的行淡下去;滚轮/方向键移尺,尺走到栏底再翻页,文首文末停住。
 *
 * 实现换成适合我们内核的几何模型 —— 正文在 foliate 的 iframe 里、行盒是
 * multicol 排出来的,没有可以打 class 的「行元素」:
 * - 淡化用**蒙版**表达:蒙版色 = 纸色 + (1 - 不透明度)。这与「其余行压到
 *   20% 不透明」视觉等价,但图片/表格/代码块一视同仁,也不碰正文 DOM。
 * - 锚点 = 正文文档里的一个 Range:重排(字号/行距/窗口)与翻页之后依然
 *   指向同一行,不需要重新找位置。
 * - 「下一行」靠 iframe 内的 caret 命中测试拿:host 坐标扣掉 iframe 偏移即可,
 *   于是滚动 / 单页 / 双页三种版式共用同一套步进逻辑。
 * - 走到版心末尾 = 翻页(双页先走右栏);文首文末判定靠「滚不动 / 翻不动」。
 * - 滚动排版下当前行钉在视口中间(内容走、眼睛不动),与 ColorTxt 一致;
 *   分页排版内核只按栏横滚,钉不了位置 —— 所以 UI 层尺一开就锁滚动排版。
 * - 滚轮按**手势**计:触控板拨一下 = 一行(带动量的一整串事件算一次手势),
 *   两指按住长拖才恢复按像素连续走;鼠标滚轮一格 = 一行,不吃手势合并。
 * - 焦点带高度 = 实测行距(相邻行行顶差),不是字盒 —— 字盒只跟字体度量
 *   有关,行距收紧时会咬到下一行顶部。
 * - 移尺是**滑动**不是瞬跳(见 #animateTo):带子与当前行一起滑向视口中间。
 *   滑动期间每帧自己重画带子,不能指望内核的 scroll 事件 —— 那个事件虽然
 *   不防抖,但带子在宿主层、内容在 iframe,靠事件回调永远慢半帧,滑起来
 *   带子就和内容脱节。后一步直接接管前一步的动画(不排队),连按方向键
 *   才是「一直往下走」而不是「走一步顿一下」。
 */

import type { View } from 'foliate-js/view.js'

/**
 * 静默超过这个间隔 = 一次新的滚动静语(鼠标连滚很快,不会被并成一行)。
 */
const WHEEL_GESTURE_QUIET_MS = 150

/** 触控板的细碎增量攒够这么多像素走一行。 */
const WHEEL_PIXELS_PER_LINE = 110

/**
 * 单次事件超过这个像素 = 鼠标滚轮的一格,不是触控板的细碎增量。
 * 取 100:macOS 鼠标一格 ≈ 100~120px,触控板一次事件通常 ≤ 60px。
 */
const WHEEL_DISCRETE_PIXELS = 100

/**
 * 手势持续超过这个时长,才允许按像素连续走(两手指按住慢慢滚)。
 * 短手势(一下一下地拨)始终只推一行 —— 这是 ColorTxt 的「跟手」感:
 * 滚一下 = 一行,再滚 = 再一行;一次大拨不再哗啦一下跳好几行。
 */
const WHEEL_SUSTAIN_MS = 400

/** 找页首/页尾第一行时的纵向扫描步长(px)。行高远大于它,不会漏行。 */
const SCAN_STEP = 6

/**
 * 移尺动画时长:按距离插值并夹在 [min, max]。
 * 一行(≈22px)落在下限 150ms —— 连按方向键时每一步都是这个量级,再长就
 * 拖沓;半屏(≈400px)接近上限 300ms,不至于一眼扫不完。
 */
const REVEAL_MIN_MS = 160
const REVEAL_MAX_MS = 320
const REVEAL_MS_PER_PX = 0.5

/** 播种失败后的重试次数(150ms 一档 = 6s 窗口)。 */
const SEED_RETRY_LIMIT = 40

/** 「段落块」选择器:同段相邻行的行顶差才是行距,跨段隔着段距。 */
const BLOCK_SELECTOR = 'p, li, blockquote, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, td, th'

export interface ReadingRulerOptions {
  /** 焦点带覆盖的行数(1..10)。 */
  readonly focusLines: number
  /** 非焦点内容的不透明度(0..1);蒙版 alpha = 1 - 该值。 */
  readonly dimOpacity: number
  /** 主题纸色 —— 蒙版颜色,与阅读主题同步才不会切主题后留下一块脏色。 */
  readonly background: string
}

interface Box {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

interface LineBox {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly height: number
}

/** 焦点带的框:视口坐标(写进样式前由 relativeBand 换成宿主相对坐标)。 */
interface BandBox {
  readonly top: number
  readonly height: number
  readonly left: number
  readonly width: number
}

interface Content {
  readonly doc: Document
  /** iframe 在宿主窗口里的位置(分页模式下左边可能为负 = 容器已滚过)。 */
  readonly frame: DOMRect
}

interface Hit {
  readonly doc: Document
  readonly range: Range
  readonly line: LineBox
}

/** 视口坐标的焦点带 → 宿主相对坐标(写进 style 的形态)。 */
function relativeBand(box: BandBox, host: Box): BandBox {
  return { ...box, top: box.top - host.top, left: box.left - host.left }
}

function lerpBand(from: BandBox, to: BandBox, t: number): BandBox {
  const mix = (a: number, b: number): number => a + (b - a) * t
  return {
    top: mix(from.top, to.top),
    height: mix(from.height, to.height),
    left: mix(from.left, to.left),
    width: mix(from.width, to.width),
  }
}

/** 滑行时长:一行 ≈ 下限,跨栏(600px 级)≈ 上限;位移不足 1px 返回 0(直接落位)。 */
function revealDuration(distance: number): number {
  if (!(Math.abs(distance) > 1)) return 0
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, Math.abs(distance) * REVEAL_MS_PER_PX))
}

function clampLines(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(10, Math.max(1, Math.round(value)))
}

/**
 * 滚轮手势状态(跨事件保留)。
 *
 * 一次「手势」= 一串间隔 < WHEEL_GESTURE_QUIET_MS、方向不变的滚轮事件:
 * 触控板的一拨(连带动量)算一次,鼠标连滚的每一格各自算一次。
 */
export interface WheelGestureState {
  /** 上一次事件的时间戳(performance.now)。 */
  readonly at: number
  readonly direction: -1 | 1
  /** 本手势已累积、还没凑够一行的像素。 */
  readonly pixels: number
  /** 本手势是否已经推过一行。 */
  readonly moved: boolean
  /** 本手势开始的时间戳。 */
  readonly since: number
}

export const INITIAL_WHEEL_STATE: WheelGestureState = {
  at: 0,
  direction: 1,
  pixels: 0,
  moved: false,
  since: 0,
}

/**
 * 一次滚轮事件 → 推几行 + 新的手势状态。
 *
 * - 鼠标滚轮格(`deltaMode` 1/2,或单次 ≥ WHEEL_DISCRETE_PIXELS):一次一格,
 *   直接取整,不吃手势合并 —— 快速连滚不该被并成一行。
 * - 触控板细碎增量:攒着,一次手势只推一行;手势持续超过
 *   WHEEL_SUSTAIN_MS(两指按住慢慢滚)才恢复按像素走,不然长距离拖动
 *   全程只动一行。
 * - 反向滚:手势作废重开,不让上一段的余量把方向带歪。
 */
export function wheelStep(
  deltaY: number,
  deltaMode: number,
  state: WheelGestureState,
  now: number,
): {
  readonly direction: -1 | 1
  readonly lines: number
  readonly state: WheelGestureState
} {
  const direction: -1 | 1 = deltaY > 0 ? 1 : -1
  const fresh = now - state.at > WHEEL_GESTURE_QUIET_MS || direction !== state.direction
  const base: WheelGestureState = fresh
    ? { at: now, direction, pixels: 0, moved: false, since: now }
    : { ...state, at: now }
  if (deltaY === 0) return { direction: state.direction, lines: 0, state: base }
  const discrete = deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_DISCRETE_PIXELS
  if (discrete) {
    const magnitude = deltaMode === 0 ? Math.abs(deltaY) / WHEEL_PIXELS_PER_LINE : Math.abs(deltaY)
    return {
      direction,
      lines: Math.max(1, Math.round(magnitude)),
      state: { ...base, pixels: 0 },
    }
  }
  const pixels = base.pixels + deltaY
  // 静默期内不记账:攒着等放行时一次性泄掉几百像素,会突然跳好几行 —— 那
  // 正是「拨一下哗啦滚好几行」的怨气来源。放行后按新鲜行程走。
  if (base.moved && now - base.since < WHEEL_SUSTAIN_MS) {
    return { direction, lines: 0, state: base }
  }
  if (Math.abs(pixels) < WHEEL_PIXELS_PER_LINE) {
    return { direction, lines: 0, state: { ...base, pixels } }
  }
  return { direction, lines: 1, state: { ...base, pixels: 0, moved: true } }
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.2
  return Math.min(1, Math.max(0, value))
}

/**
 * 蒙版色 = 主题纸色 + (1 - 非聚焦行不透明度)。
 * 「其余行 20% 不透明」与「铺一层 80% 的纸色」是同一件事 —— 后者才画得动
 * iframe 里的图片与表格,也不必改正文 DOM。
 */
export function rulerScrim(background: string, dimOpacity: number): string {
  return withAlpha(background, 1 - clampOpacity(dimOpacity))
}

function makeRange(doc: Document, node: Node, start: number, end: number): Range {
  const range = doc.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return range
}

function firstText(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length > 0 ? (node as Text) : null
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const tag = (node as Element).tagName.toLowerCase()
  if (tag === 'script' || tag === 'style') return null
  for (const child of node.childNodes) {
    const found = firstText(child)
    if (found !== null) return found
  }
  return null
}

function lastText(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length > 0 ? (node as Text) : null
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const tag = (node as Element).tagName.toLowerCase()
  if (tag === 'script' || tag === 'style') return null
  const children = node.childNodes
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child === undefined) continue
    const found = lastText(child)
    if (found !== null) return found
  }
  return null
}

/**
 * 命中点 → 覆盖**一个字符**的 Range。
 *
 * 折叠 Range 没有 client rect(caret 高度是 0),量不出行盒;而点在段尾/图片
 * 这类元素容器上时,该容器自己的 rect 又是整段 —— 所以统一退到「容器里离
 * 该点最近的那个文本节点」再取一个字符。
 */
function charRangeAt(range: Range): Range | null {
  const doc = range.startContainer.ownerDocument
  if (doc === null) return null
  const container = range.startContainer
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container as Text
    const length = text.data.length
    if (length === 0) return null
    const offset = Math.min(Math.max(0, range.startOffset), length - 1)
    return makeRange(doc, text, offset, offset + 1)
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null
  const element = container as Element
  const offset = range.startOffset
  const after = element.childNodes[offset]
  const next = after !== undefined ? firstText(after) : null
  if (next !== null) return makeRange(doc, next, 0, 1)
  const before = element.childNodes[offset - 1]
  const prev = before !== undefined ? lastText(before) : null
  if (prev !== null) {
    const start = Math.max(0, prev.data.length - 1)
    return makeRange(doc, prev, start, start + 1)
  }
  const own = firstText(element)
  return own !== null ? makeRange(doc, own, 0, 1) : null
}

export class ReadingRuler {
  readonly #host: HTMLElement
  readonly #view: () => View | null
  #options: ReadingRulerOptions | null = null
  /** 双页版式:栏底之后先走右栏,再翻页。 */
  #dual = false
  #layer: HTMLDivElement | null = null
  #band: HTMLDivElement | null = null
  #anchor: Range | null = null
  #anchorDoc: Document | null = null
  /** 串行化:连按方向键时后一步要等前一步翻页落地,否则两步都按旧锚点算。 */
  #queue: Promise<void> = Promise.resolve()
  /** 滚轮手势状态(见 wheelStep):一次手势一行,长拖动才恢复按像素走。 */
  #wheel: WheelGestureState = INITIAL_WHEEL_STATE
  /** 播种重试:开书瞬间正文还没挂上,尺不能就此隐形(见 #seed)。 */
  #seedRetry = 0
  #retryTimer: number | null = null
  /** 正在播种(paint 与 seed 会互相调用,靠它断掉重入)。 */
  #seeding = false
  /** 移尺动画的进行中的 rAF;新的移动会取消它(见 #animateTo)。 */
  #anim: number | null = null
  /** 动画正跑着:paint/refresh 要给它让路,别在滑动中重新播种。 */
  #animating = false
  /** 动画结束(或被接管)时的兑现回调 —— 打断也要兑现,否则 await 方挂死。 */
  #animDone: (() => void) | null = null
  /** 带子当前画在哪个框上(宿主相对坐标):分页档滑行的起点,也是「刚播种
   *  / 刚翻页 → 直接落位」的判据(null = 没有可插值的上一帧)。 */
  #applied: BandBox | null = null

  constructor(host: HTMLElement, view: () => View | null) {
    this.#host = host
    this.#view = view
  }

  get enabled(): boolean {
    return this.#options !== null
  }

  /** 版式(单/双页)变化 —— 只影响「栏底之后往哪走」。 */
  setDualPage(dual: boolean): void {
    this.#dual = dual
  }

  /**
   * 开/关阅读尺。传 null = 关闭。
   *
   * 重新打开时按视口播种(分页 → 页首第一行;滚动 → 视口中间那行),与
   * ColorTxt 一致:开尺这件事本身不该把读者甩到别处。
   */
  setOptions(options: ReadingRulerOptions | null): void {
    const wasEnabled = this.enabled
    this.#options =
      options === null
        ? null
        : {
            focusLines: clampLines(options.focusLines),
            dimOpacity: clampOpacity(options.dimOpacity),
            background: options.background,
          }
    if (this.#options === null) {
      this.#teardown()
      return
    }
    this.#ensureLayer()
    this.#applyDim()
    if (wasEnabled && this.#anchor !== null) this.#paint()
    else this.#seed()
  }

  /** 排版 / 主题 / 尺寸变化后重画(锚点 Range 会跟着重排走)。 */
  refresh(): void {
    if (!this.enabled) return
    // 滑行中由动画逐帧重画:这里再画一次是重复劳动,且锚点此时可能正被
    // 带出视口(半屏跳),会误判成「该重新播种了」。
    if (this.#animating) return
    // 正文刚挂上 = 一次新的播种机会:把重试额度还给它。
    this.#seedRetry = 0
    this.#paint()
  }

  /** 内核 relocate:换章了锚点就作废,否则只是位置变了。 */
  onRelocate(): void {
    if (!this.enabled) return
    // 位置被外部改了(进度条跳转 / 换章):滑到一半的动画目标已经失效,
    // 让它继续跑只会把读者拽回去 —— 直接交出方向盘。
    this.#cancelAnim()
    if (this.#anchorDoc !== null && !this.#isMounted(this.#anchorDoc)) {
      this.#anchor = null
      this.#anchorDoc = null
      this.#seed()
      return
    }
    this.#paint()
  }

  move(direction: -1 | 1): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    // catch 留在链上:一步抛错(内核切章竞态)不能让后续所有移动都跟着失败。
    this.#queue = this.#queue.then(() => this.#step(direction)).catch(() => {})
    return this.#queue
  }

  /** 滚轮:按手势推尺 —— 拨一下一行,长拖动才按像素连续走(见 wheelStep)。 */
  wheel(deltaY: number, deltaMode: number): void {
    if (!this.enabled || deltaY === 0) return
    const step = wheelStep(deltaY, deltaMode, this.#wheel, performance.now())
    this.#wheel = step.state
    for (let index = 0; index < step.lines; index += 1) {
      void this.move(step.direction)
    }
  }

  destroy(): void {
    this.#options = null
    this.#anchor = null
    this.#anchorDoc = null
    this.#cancelAnim()
    this.#teardown()
  }

  /* ---------------- 步进 ---------------- */

  async #step(direction: -1 | 1): Promise<void> {
    const line = this.#anchorLine()
    if (line === null) {
      this.#seed()
      return
    }
    const next = this.#probe(line, direction)
    if (next !== null) {
      this.#setAnchor(next.doc, next.range)
      this.#place()
      return
    }
    await this.#advance(direction)
  }

  /**
   * 视口里没有下一行了:
   * - 滚动模式:先朝该方向滚半屏再试;滚不动 = 本节到头,往下走该换节;
   * - 分页模式:双页先走另一栏,否则翻页,然后从新页的页首/页尾播种。
   */
  async #advance(direction: -1 | 1): Promise<void> {
    const host = this.#hostBox()
    if (this.#scrolled()) {
      const renderer = this.#view()?.renderer
      if (renderer === undefined) return
      const before = renderer.containerPosition ?? 0
      // 半屏跳也要滑:这里是「走到栏底没有下一行了」的续读动作,瞬跳半屏
      // 读者会丢失视线锚点。await 是因为要不要继续找下一行,取决于它到底
      // 滚没滚动(文首/文末判定)—— 必须等落位。
      await this.#animateTo(before + direction * host.height * 0.5)
      if (Math.abs((renderer.containerPosition ?? 0) - before) >= 1) {
        const line = this.#anchorLine()
        const next = line !== null ? this.#probe(line, direction) : null
        if (next !== null) {
          this.#setAnchor(next.doc, next.range)
          this.#place()
          return
        }
      }
      // 滚不动 = 这一节到头了。不能就这么 return:锚点会被留在视口外,下一次
      // paint 判定「锚点不在视口」→ 重新播种 → 带子弹回本页顶部第一行。
      if (Math.abs((renderer.containerPosition ?? 0) - before) < 1) {
        await this.#turn(direction, true)
        return
      }
      return
    }

    const anchorLine = this.#anchorLine()
    if (this.#dual && anchorLine !== null) {
      // 双页的阅读顺序是「左栏读到底 → 右栏页首」,不是两栏同一高度并读。
      // 所以栏底再往下 = 先跨到右栏页首(不翻页);右栏到顶同理回左栏页尾。
      const inLeftColumn = anchorLine.left < host.left + host.width / 2
      const crossColumn = direction > 0 ? inLeftColumn : !inLeftColumn
      if (crossColumn) {
        const target = this.#scanColumn(direction > 0 ? [0.75, 0.68] : [0.25, 0.32], direction)
        if (target !== null) {
          this.#setAnchor(target.doc, target.range)
          this.#place()
          return
        }
      }
    }

    await this.#turn(direction, false)
  }

  /**
   * 翻到下一节 / 下一屏,然后在新版面里播种。
   *
   * `requireDocChange`(滚动档专属):滚动档的 next/prev 是**换章**,已经是
   * 最后一章时内核什么都不做 —— 那时再播种会把带子拽回当前视口顶部(读者
   * 以为往后读了,其实原地弹了一下),所以先看正文文档换没换,没换就保持不动。
   * 分页档不能这么判:它翻的是**屏**,同一节内换屏时文档根本不变。
   */
  async #turn(direction: -1 | 1, requireDocChange: boolean): Promise<void> {
    const view = this.#view()
    if (view === null) return
    const docBefore = this.#contents()[0]?.doc ?? null
    const require = requireDocChange && docBefore !== null
    if (direction > 0) await view.next()
    else await view.prev()
    await nextFrame()
    if (require && this.#contents()[0]?.doc === docBefore) return
    // 翻页/换节是整屏瞬变:带子跟着瞬移,不要从上一条位置慢悠悠滑过来。
    this.#applied = null
    const seeded = this.#scanColumn(this.#seedColumnXs(direction), direction)
    if (seeded === null) return
    this.#setAnchor(seeded.doc, seeded.range)
    this.#place()
  }

  /* ---------------- 播种 / 命中 ---------------- */

  #seed(): void {
    if (!this.enabled) return
    this.#seeding = true
    try {
      const hit = this.#scanForSeed()
      if (hit === null) {
        // 正文还没挂上(开书瞬间、刚翻到新章节):尺不能就这么隐形。按 150ms
        // 一档退让,最多撑 6s —— 冷启动连字体带排版确实能过 1s;真扫不到行
        // (比如整页都是图)就安静收着,等下一次 relocate / 章节挂载再试。
        if (this.#band !== null) this.#band.style.opacity = '0'
        if (this.#seedRetry >= SEED_RETRY_LIMIT || this.#retryTimer !== null) return
        this.#seedRetry += 1
        this.#retryTimer = window.setTimeout(() => {
          this.#retryTimer = null
          this.#seed()
        }, 150)
        return
      }
      this.#seedRetry = 0
      this.#setAnchor(hit.doc, hit.range)
    } finally {
      this.#seeding = false
    }
    this.#paint()
  }

  #scanForSeed(): Hit | null {
    const host = this.#hostBox()
    const xs = this.#seedColumnXs()
    const from = this.#scrolled() ? host.top + host.height / 2 : host.top + 2
    const to = host.top + host.height - 2
    const down = this.#scanColumn(xs, 1, from, to)
    return down ?? this.#scanColumn(xs, -1, to, host.top + 2)
  }

  /** 纵向扫描一列候选 x,返回第一个命中的行(方向 = 从哪头开始找)。 */
  #scanColumn(xs: readonly number[], direction: -1 | 1, from?: number, to?: number): Hit | null {
    const host = this.#hostBox()
    const start = from ?? (direction > 0 ? host.top + 2 : host.top + host.height - 2)
    const end = to ?? (direction > 0 ? host.top + host.height - 2 : host.top + 2)
    const step = direction > 0 ? SCAN_STEP : -SCAN_STEP
    for (let y = start; direction > 0 ? y <= end : y >= end; y += step) {
      for (const fraction of xs) {
        const hit = this.#hit(host.left + host.width * fraction, y)
        if (hit !== null) return hit
      }
    }
    return null
  }

  /**
   * 播种时的栏位横坐标(宿主宽度的比例)。双页要先认「这一页的第一栏」:
   * 往后翻落在左栏页首,往前翻落在右栏页尾。
   */
  #seedColumnXs(direction: -1 | 1 = 1): readonly number[] {
    if (!this.#dual) return [0.5, 0.35, 0.65]
    return direction > 0 ? [0.25, 0.32, 0.5] : [0.75, 0.68, 0.5]
  }

  /**
   * 朝 direction 找**下一行**。
   *
   * y 探针从当前行盒外半步起跳:行距 (pitch) 未知,先在 0.6 个行高外试,
   * 命中行顶没变就再往外挪 —— 段间距、空行、标题都比一行高,一步到位会漏。
   */
  #probe(line: LineBox, direction: -1 | 1): Hit | null {
    const pitch = Math.max(6, line.height)
    const x = line.left + 2
    for (const factor of [0.6, 1.1, 1.7, 2.4]) {
      const y = direction > 0 ? line.bottom + pitch * factor : line.top - pitch * factor
      const hit = this.#hit(x, y)
      if (hit === null) continue
      const moved = direction > 0 ? hit.line.top > line.top + 0.5 : hit.line.top < line.top - 0.5
      if (moved) return hit
    }
    return null
  }

  /**
   * 宿主坐标 → 正文文档里的 caret,再量出所在行盒(同样换回宿主坐标)。
   *
   * 命中的行必须**落在视口里**:点在留白/栏缝上时 caret 会贴到 body 级别的
   * 位置,退化成「本章第一个字」—— 那在分页模式下可能是第 1 页,量出来是
   * 一块屏幕外的行盒。不挡掉的话播种会「成功」在一个看不见的位置上。
   */
  #hit(hostX: number, hostY: number): Hit | null {
    const host = this.#hostBox()
    for (const content of this.#contents()) {
      const { frame } = content
      const x = hostX - frame.left
      const y = hostY - frame.top
      if (x < 0 || y < 0 || x > frame.width || y > frame.height) continue
      let caret: Range | null
      try {
        caret = caretRangeAt(content.doc, x, y)
      } catch {
        // 文档正在被卸载(iframe 离窗):命中测试抛就当作没命中,尺安静
        // 收着,等下一次 relocate / 章节重挂再画。
        continue
      }
      if (caret === null) continue
      const line = lineBoxOf(caret, frame)
      if (line === null) continue
      if (line.bottom < host.top + 1 || line.top > host.top + host.height - 1) continue
      if (line.left > host.left + host.width || line.left + 1 < host.left) continue
      return { doc: content.doc, range: caret, line }
    }
    return null
  }

  #anchorLine(): LineBox | null {
    const anchor = this.#anchor
    if (anchor === null) return null
    const doc = this.#anchorDoc
    const content = this.#contents().find((item) => item.doc === doc)
    if (content === undefined) return null
    return lineBoxOf(anchor, content.frame)
  }

  #setAnchor(doc: Document, range: Range): void {
    this.#anchor = range.cloneRange()
    this.#anchorDoc = doc
  }

  /* ---------------- 绘制 ---------------- */

  #paint(): void {
    const options = this.#options
    const band = this.#band
    if (options === null || band === null) return
    const host = this.#hostBox()
    const line = this.#anchorLine()
    // 锚点跑到视口外(拖了滚动条 / 键盘翻页 / 换书):按当前视口重新播种。
    // 不这么做的话翻页后尺就停在上一页的位置,蒙版被 overflow 裁掉 = 悄悄失效。
    if (line === null || line.bottom < host.top || line.top > host.top + host.height) {
      // 播种里又会回来调 #paint:重入时直接收声,别把这两个方法拧成死循环。
      if (this.#seeding) {
        band.style.opacity = '0'
        return
      }
      // 滑行中:锚点只是暂时被带出视口(半屏跳的头几帧),带子留在这一帧的
      // 位置上就行 —— 此时重新播种会把尺甩回视口,等于取消这次移动。
      if (this.#animating) return
      this.#seed()
      return
    }
    const box = this.#focusBox(line, options.focusLines)
    band.style.opacity = '1'
    const painted = relativeBand(box, host)
    // 滚动排版:带子必须和内容严格同帧(滑行时差半帧就看出「各走各的」),
    // 所以直接落位,位置由容器动画逐帧带着走。
    // 分页排版:内容不动,带子自己滑过去 —— 这是这一档唯一的「动画」。
    if (this.#scrolled()) this.#applyBand(painted)
    else this.#animateBand(painted)
  }

  /** 把带子画到目标框(宿主相对坐标)。 */
  #applyBand(painted: BandBox): void {
    const band = this.#band
    if (band === null) return
    const next: BandBox = {
      top: painted.top,
      height: Math.max(4, painted.height),
      left: painted.left,
      width: painted.width,
    }
    band.style.top = `${Math.round(next.top)}px`
    band.style.height = `${Math.round(next.height)}px`
    band.style.left = `${Math.round(next.left)}px`
    band.style.width = `${Math.round(next.width)}px`
    this.#applied = next
  }

  /**
   * 分页排版下把带子**滑**到目标框。
   *
   * 与滚动档的容器动画同一套时长/曲线,观感才一致:按一次键 = 一次 ~160ms
   * 的滑动;跨栏(Δ 可能有 600px)取上限 320ms,看着像「飞到下一栏」。
   * 新目标到达时重启动画(从当前渲染位置接着走),连按才是连续滑行。
   * `#applied === null`(刚播种 / 刚翻页)直接落位:那时内容是瞬变的,
   * 带子慢悠悠滑过去反而像卡住。
   */
  #animateBand(painted: BandBox): void {
    const from = this.#applied
    if (from === null || this.#reducedMotion()) {
      this.#applyBand(painted)
      return
    }
    const duration = revealDuration(Math.abs(painted.top - from.top))
    const sameWidth =
      Math.abs(painted.left - from.left) <= 1 && Math.abs(painted.width - from.width) <= 1
    if ((duration <= 0 && sameWidth) || Math.abs(painted.height - from.height) > 400) {
      this.#applyBand(painted)
      return
    }
    this.#cancelAnim()
    const started = performance.now()
    const tick = (now: number): void => {
      const t = Math.min(1, (now - started) / duration)
      this.#applyBand(lerpBand(from, painted, 1 - (1 - t) ** 2))
      if (t < 1) {
        this.#anim = requestAnimationFrame(tick)
        return
      }
      this.#cancelAnim()
    }
    this.#animating = true
    this.#anim = requestAnimationFrame(tick)
  }

  /**
   * 焦点带 = 首行到第 N 行的并集,上下各带半行行距的留白(蒙版边缘落在
   * 行间空隙里,不切字)。第 N 行拿不到(栏底/章末)就按已有行数收窄。
   *
   * 半 leading 是**带符号**的:行距宽于字盒时往外扩(蒙版边落在行间空隙),
   * 窄于字盒时往里收(行距 1.2 时行盒 21.6px 比字盒 25px 还矮,夹成 0 就
   * 等于按字盒画带,咬到下一行顶部 —— 用户报的正是这个)。
   *
   * 横向取**锚点所在的那一栏**(块的 rect),不是整屏宽:双页排版下一栏只
   * 占半屏,带子横跨两栏会把左右两页一起点亮,看不出在读哪一栏。单页 /
   * 滚动排版下块宽就是整栏,同一个表达式天然正确。
   */
  #focusBox(line: LineBox, focusLines: number): BandBox {
    const lines: LineBox[] = [line]
    let current = line
    for (let index = 1; index < focusLines; index += 1) {
      const next = this.#probe(current, 1)
      if (next === null) break
      lines.push(next.line)
      current = next.line
    }
    const first = lines[0] ?? line
    const last = lines[lines.length - 1] ?? line
    const pitch = this.#pitchOf(first)
    const leadTop = (pitch - first.height) / 2
    const leadBottom = (pitch - last.height) / 2
    const top = first.top - leadTop
    return {
      top,
      height: last.bottom + leadBottom - top,
      ...this.#columnBox(line),
    }
  }

  /**
   * 锚点所在栏的横向范围(宿主坐标)。
   *
   * 单页 / 滚动排版:整屏就是一栏,直接用宿主宽。不去问块 rect —— 分页是
   * multicol,块跨屏时碎片会落在别的屏上(纵向坐标还一模一样),挑错就画出
   * 一条跑到屏幕外的带子。
   *
   * 双页排版才需要按锚点选出那一栏:取 `getClientRects()` 里**横向框住当前
   * 行**的那个碎片。不能用 `getBoundingClientRect()` —— 跨栏段落它返回的是
   * 两个碎片的并集(横跨两栏),带子就又变成整条了。
   */
  #columnBox(line: LineBox): { left: number; width: number } {
    const host = this.#hostBox()
    if (!this.#dual) return { left: host.left, width: host.width }
    const fallback = { left: host.left, width: host.width }
    const anchor = this.#anchor
    const content = this.#contents().find((item) => item.doc === this.#anchorDoc)
    if (anchor === null || content === undefined) return fallback
    const block = blockOf(anchor)
    if (block === null) return fallback
    let best: DOMRect | null = null
    let bestOverlap = 0
    try {
      for (const rect of block.getClientRects()) {
        if (!(rect.width > 0)) continue
        const left = rect.left + content.frame.left
        const right = rect.right + content.frame.left
        const top = rect.top + content.frame.top
        const bottom = rect.bottom + content.frame.top
        // 跨屏的碎片纵向坐标是一样的(都在各自屏的同一高度),只比纵向会
        // 选中上一屏那个 —— 所以横向必须真的把锚点行框住。
        if (line.left < left - 1 || line.left > right + 1) continue
        const overlap = Math.min(bottom, line.bottom) - Math.max(top, line.top)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          best = rect
        }
      }
    } catch {
      return fallback
    }
    if (best === null) return fallback
    return { left: best.left + content.frame.left, width: Math.min(best.width, host.width) }
  }

  /**
   * 焦点行的行距:计算行高优先,实测相邻行兜底。
   *
   * 计算行高(`<p>` 上 getComputedStyle 的 line-height)就是这一行所在块的行
   * 距,段末行也量得到 —— 实测相邻行则会跨段:段末行向下探到的是下一段首行,
   * 隔着 18px 段距,带子会被撑大咬到下一行顶部。
   * 只有老书 `line-height: normal`(算出来是 NaN)才实测,且必须同段。
   */
  #pitchOf(line: LineBox): number {
    const computed = this.#computedLineHeight()
    if (computed !== null) return computed
    for (const direction of [1, -1] as const) {
      const hit = this.#probe(line, direction)
      if (hit === null || !this.#sameBlock(hit.range)) continue
      const pitch = direction > 0 ? hit.line.top - line.top : line.top - hit.line.top
      if (pitch > line.height * 0.5 && pitch < line.height * 6) return pitch
    }
    // 兜底:字盒本身就是安全值(不超出字形,咬不到下一行)
    return line.height
  }

  /**
   * 锚点所在块的计算行高;拿不到(`normal` / 文档卸载)返回 null。
   *
   * 取文本节点的父元素而不是 `closest` 到的块:行内元素(span)会继承段落的
   * 行高,而 `closest` 在标题(h2)上会跳过它本身拿到外层 div 的值。
   */
  #computedLineHeight(): number | null {
    const anchor = this.#anchor
    const node = anchor?.startContainer ?? null
    if (node === null) return null
    const element =
      node.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : ((node as Element).closest(BLOCK_SELECTOR) ?? (node as Element))
    const view = element?.ownerDocument.defaultView ?? null
    if (element === null || view === null) return null
    try {
      const lineHeight = Number.parseFloat(view.getComputedStyle(element).lineHeight)
      if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
    } catch {
      // 文档正在卸载(getComputedStyle 拿不到元素):走实测兜底。
    }
    return null
  }

  /** 两个 Range 是否在同一个段落块里(跨段量到的「行距」隔着段距)。 */
  #sameBlock(range: Range): boolean {
    const anchor = this.#anchor
    if (anchor === null) return false
    return blockOf(anchor) === blockOf(range)
  }

  /** 滚动模式:把焦点行滑到视口中间(内容往上走,眼睛不动)。 */
  #reveal(): boolean {
    if (!this.#scrolled()) return false
    const line = this.#anchorLine()
    if (line === null) return false
    const host = this.#hostBox()
    const delta = (line.top + line.bottom) / 2 - (host.top + host.height / 2)
    if (Math.abs(delta) <= 1) return false
    const renderer = this.#view()?.renderer
    if (renderer === undefined) return false
    // 不 await:移尺要跟手,连按方向键时后一步接管前一步(见 #animateTo),
    // 排队等前一段滑完就变成「按一下、等一下」。
    void this.#animateTo((renderer.containerPosition ?? 0) + Math.round(delta))
    return true
  }

  /**
   * 画带 + 把当前行滑回视口中间。
   *
   * 带子在宿主层、正文在 iframe 里:#reveal 滚的是内核容器,内容动而带子
   * 不动,不重画就停在旧位置 —— 只能等内核 250ms 防抖的 relocate 才纠正,
   * 连续移尺时看起来就是「不居中 / 慢半拍」。滑动过程由 #animateTo 逐帧重画。
   */
  #place(): void {
    this.#paint()
    this.#reveal()
  }

  /**
   * 平滑滚到目标位置 —— 移尺的动画。
   *
   * - 每帧自己重画:只改 containerPosition 的话,带子要等内核事件才跟上,
   *   滑的时候带子和正文各走各的(带子在宿主层,内容在 iframe)。
   * - 新的移动直接取消上一段动画并从**当前视觉位置**接着滑(重定向),不是
   *   排队等上一段结束 —— 长按方向键时才是一条连续的滑行。
   * - 被接管时把上一段的 Promise 兑现掉:半屏跳(#advance)在 await 它,
   *   不兑现就永远挂住。
   */
  #animateTo(target: number): Promise<void> {
    this.#cancelAnim()
    const renderer = this.#view()?.renderer
    if (renderer === undefined) return Promise.resolve()
    const from = renderer.containerPosition ?? 0
    const distance = target - from
    if (Math.abs(distance) <= 1) return Promise.resolve()
    if (this.#reducedMotion()) {
      renderer.containerPosition = Math.round(target)
      this.#paint()
      return Promise.resolve()
    }
    const duration = revealDuration(distance)
    const started = performance.now()
    return new Promise((resolve) => {
      this.#animDone = resolve
      const tick = (now: number): void => {
        const t = Math.min(1, (now - started) / duration)
        // ease-out(二次):按键当帧就有位移(响应感),收尾缓停(眼睛跟着带子
        // 走)。三次方起步太猛 —— 首帧就吃掉三成位移,看着像「弹」出去的。
        const eased = 1 - (1 - t) ** 2
        renderer.containerPosition = Math.round(from + distance * eased)
        this.#paint()
        if (t < 1) {
          this.#anim = requestAnimationFrame(tick)
          return
        }
        this.#cancelAnim()
      }
      this.#animating = true
      this.#anim = requestAnimationFrame(tick)
    })
  }

  #cancelAnim(): void {
    if (this.#anim !== null) {
      cancelAnimationFrame(this.#anim)
      this.#anim = null
    }
    this.#animating = false
    const done = this.#animDone
    this.#animDone = null
    done?.()
  }

  /** 系统开了「减少动态效果」:直接落位,不滑。 */
  #reducedMotion(): boolean {
    try {
      return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    } catch {
      return false
    }
  }

  /* ---------------- 装配 ---------------- */

  #ensureLayer(): void {
    if (this.#layer !== null) return
    const layer = document.createElement('div')
    layer.className = 'reading-ruler'
    const band = document.createElement('div')
    band.className = 'reading-ruler-band'
    layer.append(band)
    this.#host.append(layer)
    this.#layer = layer
    this.#band = band
  }

  #teardown(): void {
    if (this.#retryTimer !== null) {
      window.clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#seedRetry = 0
    this.#cancelAnim()
    this.#layer?.remove()
    this.#layer = null
    this.#band = null
    this.#applied = null
  }

  /** 蒙版色 = 纸色 + (1 - 不透明度)。主题走 CSS 变量也是延迟变色,直接算死。 */
  #applyDim(): void {
    const options = this.#options
    const band = this.#band
    if (options === null || band === null) return
    band.style.setProperty(
      '--reading-ruler-scrim',
      rulerScrim(options.background, options.dimOpacity),
    )
  }

  #contents(): Content[] {
    const view = this.#view()
    if (view === null || view.isFixedLayout) return []
    return view.renderer.getContents().flatMap((item) => {
      const frame = item.doc.defaultView?.frameElement?.getBoundingClientRect()
      return frame === undefined ? [] : [{ doc: item.doc, frame }]
    })
  }

  #isMounted(doc: Document): boolean {
    return this.#contents().some((item) => item.doc === doc)
  }

  #scrolled(): boolean {
    return this.#view()?.renderer.scrolled === true
  }

  #hostBox(): Box {
    const rect = this.#host.getBoundingClientRect()
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
  }
}

/** 命中点 → 折叠 Range;Chromium/WebKit 用 caretRangeFromPoint,Firefox 用 caretPositionFromPoint。 */
function caretRangeAt(doc: Document, x: number, y: number): Range | null {
  const legacy = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (typeof legacy.caretRangeFromPoint === 'function') {
    return legacy.caretRangeFromPoint(x, y)
  }
  const position = legacy.caretPositionFromPoint?.(x, y)
  if (position === undefined || position === null) return null
  const range = doc.createRange()
  range.setStart(position.offsetNode, position.offset)
  range.collapse(true)
  return range
}

/** Range 所在的段落块(没有块祖先时返回 null,null === null 视为同段)。 */
function blockOf(range: Range): Element | null {
  const node = range.startContainer
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return element?.closest(BLOCK_SELECTOR) ?? null
}

/**
 * Range → 字符盒(宿主坐标)。
 *
 * 只取一个字符的 rect:同一行里的字符共享一条基线,一个字符的 rect 就锁定
 * 了这一行的位置,比 `getBoundingClientRect`(整段)精确。注意这是**字盒**
 * (字体度量,18px 字 ≈ 25px),不是行盒 —— 行盒 = 字盒 ± 半 leading,由
 * #focusBox 用行距推。`getClientRects` 里挑第一个落在正文命名空间、且有高度的。
 */
function lineBoxOf(range: Range, frame: DOMRect): LineBox | null {
  const chars = charRangeAt(range)
  if (chars === null) return null
  let rects: DOMRectList
  try {
    rects = chars.getClientRects()
  } catch {
    // Range 所在的文档已被丢弃(iframe 离窗):量不了版面就当没这一行。
    return null
  }
  for (const rect of rects) {
    if (!(rect.height > 0)) continue
    return {
      top: rect.top + frame.top,
      bottom: rect.bottom + frame.top,
      left: rect.left + frame.left,
      height: rect.height,
    }
  }
  return null
}

/** 与 reader-options 的 withAlpha 同一套(adapter 不依赖 app 层,复制一份)。 */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex === null) return color
  const value = hex[1] ?? ''
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

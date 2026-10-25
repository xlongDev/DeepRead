/**
 * PDF 滚动模式(fixed-layout scrolled)的页Strip。
 *
 * foliate-js 的固定排版渲染器(foliate-fxl)只有「spread 翻页」一种形态:
 * spread 分组在 `open()` 时一次算定(私有字段),没有 scrolled 流。readest
 * 的做法是 fork 内核自己实现(flow="scrolled" + 页面虚拟化),本项目不 patch
 * npm 的 foliate-js(见 books/vendor/foliate-pdf.js 文件头的约定),所以滚动
 * 形态在这里单独实现:宿主里的一个滚动容器,按 PDF 每页的自然尺寸预排占位,
 * IntersectionObserver 懒挂载 iframe,fit-width 缩放后调页面的 onZoom 渲染
 * (与 foliate-fxl 的 #render 同一套几何:canvas 按 devicePixelRatio 渲染、
 * 文档 CSS 缩回)。
 *
 * 事件走内核既有通道,不新造协议:页面挂载 → 引擎把 load 事件搬上
 * foliate-fxl(view.js #onLoad → #emit('load')),滚动位置 → 引擎以
 * {reason:'scroll', index, fraction, size:0} 派发 relocate(经
 * SectionProgress 精确插值,见 progress.js#getProgress)。划词、简繁、chrome
 * 唤醒等挂在 view 'load' 上的逻辑因此原样复用。
 *
 * `ponytail`: 全部页面一次性 load() 拿自然尺寸(只建 blob,不渲染画布),
 * 挂载后不卸载 —— 长书(上千页)会累积已渲染页,将来卡顿再加虚拟化窗口。
 */

import type { FixedLayoutPage, FoliateBook } from 'foliate-js/view.js'

/** 页间距 / 首尾留白(px)。offsets 的算术与 CSS 必须一致:容器是 flex
 *  column,除第一页外每页 margin-top = PAGE_GAP,末尾补一块同高 spacer。 */
const PAGE_GAP = 16
/** fit-width 时两侧留出的呼吸空间(px)。 */
const PAGE_INSET = 24

export interface PdfScrollHooks {
  /** 页文档挂载后调用(引擎经它把 load 事件搬进内核管线)。 */
  onPageMounted(doc: Document, index: number): void
  /** 滚动位置变化(已按帧节流):当前页 index + 页内比例 0..1。 */
  onScroll(index: number, fractionInSection: number): void
}

/**
 * 每页的滚动偏移:offset(i) = Σ_{j<i} (h_j + gap)。
 * 纯函数 —— 与 CSS 的 flex column + margin-top 布局互为镜像,单测直接锁。
 */
export const pageOffsets = (heights: readonly number[], gap = PAGE_GAP): number[] => {
  const offsets: number[] = []
  let top = 0
  for (const height of heights) {
    offsets.push(top)
    top += height + gap
  }
  return offsets
}

/** scrollTop 落在哪一页:最后一个 offset ≤ scrollTop 的页。 */
export const topPageIndex = (offsets: readonly number[], scrollTop: number): number => {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid]! <= scrollTop) lo = mid
    else hi = mid - 1
  }
  return lo
}

export class PdfScrollStrip {
  #host: HTMLElement
  #book: FoliateBook
  #hooks: PdfScrollHooks
  #container: HTMLElement | null = null
  #wrappers: HTMLElement[] = []
  #iframes: (HTMLIFrameElement | null)[] = []
  #pages: FixedLayoutPage[] = []
  #scales: number[] = []
  #offsets: number[] = []
  #observer: IntersectionObserver | null = null
  #resizeObserver: ResizeObserver | null = null
  #scrollFrame: number | null = null
  #destroyed = false

  constructor(host: HTMLElement, book: FoliateBook, hooks: PdfScrollHooks) {
    this.#host = host
    this.#book = book
    this.#hooks = hooks
  }

  /**
   * 建容器与全部占位并落到第 0 页。
   *
   * 先 load() 所有 section:blob 文档此刻才创建(画布要等 onZoom),所以这是
   * 便宜的;换来的是每页自然尺寸,占位高度才能在 iframe 挂载前算出来。
   */
  async mount(): Promise<void> {
    const sections = this.#book.sections
    this.#pages = (await Promise.all(
      sections.map((section) => section.load()),
    )) as FixedLayoutPage[]
    if (this.#destroyed) return

    const container = document.createElement('div')
    container.className = 'pdf-scroll'
    const spacer = document.createElement('div')
    spacer.className = 'pdf-scroll-spacer'
    for (const [index] of sections.entries()) {
      const wrapper = document.createElement('div')
      wrapper.className = 'pdf-scroll-page'
      wrapper.dataset.index = String(index)
      container.append(wrapper)
      this.#wrappers.push(wrapper)
    }
    container.append(spacer)
    this.#host.append(container)
    this.#container = container

    this.#relayout()
    container.addEventListener('scroll', () => this.#scheduleReport())
    this.#resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.#relayout()) : null
    this.#resizeObserver?.observe(container)
    this.#observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting) continue
                this.#mountPage(Number((entry.target as HTMLElement).dataset.index))
              }
            },
            // 视口上下各一屏:连续滚动时下一页在进入视口前就已渲染完。
            { root: container, rootMargin: '100% 0px' },
          )
        : null
    for (const wrapper of this.#wrappers) this.#observer?.observe(wrapper)
    this.#report()
  }

  /** 跳到某一页(页首)。 */
  goToIndex(index: number): void {
    const clamped = Math.min(Math.max(index, 0), Math.max(0, this.#pages.length - 1))
    this.#scrollTo(clamped, 0)
  }

  /** 按全书比例跳转;比例口径与上报一致((页 + 页内比例)/ 总页数)。 */
  scrollToFraction(fraction: number): void {
    const total = this.#pages.length
    if (total === 0) return
    const exact = Math.min(Math.max(fraction, 0), 1) * total
    const index = Math.min(total - 1, Math.floor(exact))
    this.#scrollTo(index, exact - index)
  }

  /** 翻一「屏」(与 EPUB 滚动模式的方向键同语义:内核按视口高度滚动)。 */
  scrollByViewport(direction: 1 | -1): void {
    const container = this.#container
    if (!container) return
    container.scrollTop += direction * container.clientHeight
    this.#report()
  }

  /** 主题变了:已挂载页按新色重渲染(setPageColors 是模块级状态)。 */
  rerenderMounted(): void {
    for (const [index, iframe] of this.#iframes.entries()) {
      if (iframe) this.#renderPage(index)
    }
  }

  /** 已挂载页的文档(供 getText 等按 index 取内容,替代 renderer.getContents)。 */
  mountedDocs(): { doc: Document; index: number }[] {
    const docs: { doc: Document; index: number }[] = []
    for (const [index, iframe] of this.#iframes.entries()) {
      const doc = iframe?.contentDocument
      if (doc) docs.push({ doc, index })
    }
    return docs
  }

  destroy(): void {
    this.#destroyed = true
    this.#observer?.disconnect()
    this.#observer = null
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = null
    if (this.#scrollFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.#scrollFrame)
      else clearTimeout(this.#scrollFrame)
      this.#scrollFrame = null
    }
    this.#container?.remove()
    this.#container = null
    this.#wrappers = []
    this.#iframes = []
    this.#pages = []
    this.#scales = []
    this.#offsets = []
  }

  #scrollTo(index: number, within: number): void {
    const container = this.#container
    if (!container) return
    const height = (this.#pages[index]?.height ?? 0) * (this.#scales[index] ?? 1)
    container.scrollTop = (this.#offsets[index] ?? 0) + within * height
    this.#report()
  }

  /** 重算缩放 / 占位高度 / 偏移;缩放真变了才重渲染已挂载页(resize 拖动时
   *  ResizeObserver 每帧都响,高度-only 的变化不能触发整页重画)。 */
  #relayout(): void {
    const container = this.#container
    if (!container) return
    const width = container.clientWidth
    let changed = false
    const heights: number[] = []
    for (const [index, page] of this.#pages.entries()) {
      const scale = page.width && width > 0 ? Math.max(0.05, (width - PAGE_INSET) / page.width) : 1
      if (scale !== this.#scales[index]) {
        this.#scales[index] = scale
        changed = true
      }
      const height = Math.round((page.height ?? 0) * scale)
      heights.push(height)
      const wrapper = this.#wrappers[index]
      if (wrapper) wrapper.style.height = `${height}px`
    }
    this.#offsets = pageOffsets(heights)
    if (changed) this.rerenderMounted()
  }

  #mountPage(index: number): void {
    if (this.#destroyed || this.#iframes[index]) return
    const page = this.#pages[index]
    const wrapper = this.#wrappers[index]
    if (!page || !wrapper) return
    const iframe = document.createElement('iframe')
    Object.assign(iframe.style, { border: '0', display: 'block', overflow: 'hidden' })
    // allow-scripts 是 WebKit 事件 bug 的既知 workaround(内核同款配置)。
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
    iframe.setAttribute('scrolling', 'no')
    iframe.addEventListener(
      'load',
      () => {
        const scale = this.#scales[index] ?? 1
        Object.assign(iframe.style, {
          width: `${(page.width ?? 0) * scale}px`,
          height: `${(page.height ?? 0) * scale}px`,
        })
        const doc = iframe.contentDocument
        if (doc && page.onZoom) {
          Promise.resolve(page.onZoom({ doc, scale })).catch(() => {})
        }
        if (doc) this.#hooks.onPageMounted(doc, index)
      },
      { once: true },
    )
    iframe.src = page.src
    wrapper.append(iframe)
    this.#iframes[index] = iframe
  }

  #renderPage(index: number): void {
    const page = this.#pages[index]
    const iframe = this.#iframes[index]
    const doc = iframe?.contentDocument
    if (!page?.onZoom || !doc) return
    Promise.resolve(page.onZoom({ doc, scale: this.#scales[index] ?? 1 })).catch(() => {})
  }

  #scheduleReport(): void {
    if (this.#scrollFrame !== null) return
    const run = (): void => {
      this.#scrollFrame = null
      this.#report()
    }
    this.#scrollFrame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : (setTimeout(run, 0) as unknown as number)
  }

  /** 当前滚动位置 → (页, 页内比例),走 hooks 上报。 */
  #report(): void {
    const container = this.#container
    if (!container || this.#offsets.length === 0) return
    const scrollTop = container.scrollTop
    const index = topPageIndex(this.#offsets, scrollTop)
    const height = (this.#pages[index]?.height ?? 0) * (this.#scales[index] ?? 1)
    const within =
      height > 0 ? Math.min(Math.max((scrollTop - (this.#offsets[index] ?? 0)) / height, 0), 1) : 0
    this.#hooks.onScroll(index, within)
  }
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoliateBook } from 'foliate-js/view.js'
import { PdfScrollStrip, pageOffsets, topPageIndex } from './pdf-scroll'

/** jsdom 没有 IntersectionObserver / ResizeObserver,也没有布局(clientWidth
 *  恒 0、scrollTop 写不进去)—— 测试里给足最小桩,其余走真实 DOM 路径。 */
class FakeIntersectionObserver {
  constructor(
    private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }])
  }
  unobserve(): void {}
  disconnect(): void {}
}

const realIO = globalThis.IntersectionObserver
const realRO = globalThis.ResizeObserver
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

/** 每页一个假 section:{src, onZoom, 自然尺寸}。 */
const makeBook = (
  pages: readonly { width: number; height: number }[],
  onZoom: ReturnType<typeof vi.fn>,
): FoliateBook =>
  ({
    sections: pages.map((page, index) => ({
      size: 1000,
      load: async () => ({
        src: `about:blank#${index}`,
        onZoom,
        width: page.width,
        height: page.height,
      }),
    })),
  }) as unknown as FoliateBook

describe('pageOffsets / topPageIndex', () => {
  it('偏移含页间距,与 CSS 的 flex column + margin-top 互为镜像', () => {
    expect(pageOffsets([100, 200, 300])).toEqual([0, 116, 332])
    expect(pageOffsets([], 16)).toEqual([])
  })

  it('滚动位置落在哪个页:边界归属上一页,页首起算新页', () => {
    const offsets = [0, 116, 332]
    expect(topPageIndex(offsets, 0)).toBe(0)
    expect(topPageIndex(offsets, 115)).toBe(0)
    expect(topPageIndex(offsets, 116)).toBe(1)
    expect(topPageIndex(offsets, 331)).toBe(1)
    expect(topPageIndex(offsets, 332)).toBe(2)
    // 超出末页(滚动到最底):夹在最后一页。
    expect(topPageIndex(offsets, 99_999)).toBe(2)
  })
})

describe('PdfScrollStrip', () => {
  let host: HTMLElement
  let onZoom: ReturnType<typeof vi.fn>
  let onPageMounted: ReturnType<typeof vi.fn>
  let onScroll: ReturnType<typeof vi.fn>
  let strip: PdfScrollStrip

  beforeEach(() => {
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    })
    host = document.createElement('div')
    document.body.append(host)
    onZoom = vi.fn()
    onPageMounted = vi.fn()
    onScroll = vi.fn()
  })

  afterEach(() => {
    strip?.destroy()
    host.remove()
    if (realIO) globalThis.IntersectionObserver = realIO
    else delete (globalThis as Record<string, unknown>).IntersectionObserver
    if (realRO) globalThis.ResizeObserver = realRO
    else delete (globalThis as Record<string, unknown>).ResizeObserver
    if (realClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth)
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  })

  const mountStrip = async (pages: readonly { width: number; height: number }[]): Promise<void> => {
    strip = new PdfScrollStrip(host, makeBook(pages, onZoom), {
      onPageMounted: onPageMounted as (doc: Document, index: number) => void,
      onScroll: onScroll as (index: number, fractionInSection: number) => void,
    })
    await strip.mount()
  }

  it('按自然尺寸预排占位,fit-width 缩放后渲染每页', async () => {
    await mountStrip([
      { width: 400, height: 600 },
      { width: 200, height: 400 },
      { width: 800, height: 1000 },
    ])
    const container = host.querySelector('.pdf-scroll')
    expect(container).not.toBeNull()
    const wrappers = [...container!.querySelectorAll<HTMLElement>('.pdf-scroll-page')]
    expect(wrappers).toHaveLength(3)
    // scale = (800 - PAGE_INSET 24) / width;高度取整后写进占位。
    expect(wrappers.map((w) => w.style.height)).toEqual(['1164px', '1552px', '970px'])

    // 观察器一挂上就懒挂载:iframe 已按 sandbox/scrolling 约定创建。
    const iframes = [...container!.querySelectorAll<HTMLIFrameElement>('iframe')]
    expect(iframes).toHaveLength(3)
    expect(iframes[0]!.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts')
    expect(iframes[0]!.getAttribute('scrolling')).toBe('no')

    // load 之后:iframe 按缩放尺寸撑开、onZoom 拿到同一缩放、页文档交给上层。
    const doc = document.implementation.createHTMLDocument()
    for (const iframe of iframes) {
      Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: doc })
      iframe.dispatchEvent(new Event('load'))
    }
    expect(onZoom.mock.calls.map(([arg]) => arg.scale)).toEqual([1.94, 3.88, 0.97])
    expect(onPageMounted.mock.calls.map(([d, i]) => [d, i])).toEqual([
      [doc, 0],
      [doc, 1],
      [doc, 2],
    ])
    expect(iframes[0]!.style.width).toBe('776px')
    expect(iframes[0]!.style.height).toBe('1164px')
  })

  it('滚动位置按(页, 页内比例)上报,比例可直接喂回跳转', async () => {
    await mountStrip([
      { width: 400, height: 600 },
      { width: 200, height: 400 },
    ])
    const container = host.querySelector('.pdf-scroll') as HTMLElement
    // jsdom 没有布局,scrollTop 直接换成实例属性。
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    })
    // offsets: [0, 1180];页 1 高 1552。
    container.scrollTop = 1180
    container.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onScroll.mock.calls.at(-1)).toEqual([1, 0])

    container.scrollTop = 1180 + 776
    container.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onScroll.mock.calls.at(-1)).toEqual([1, 0.5])

    // 比例 → 跳转 → 上报, round-trip 落在同一处(进度恢复/刮擦依赖这个)。
    // 2 页的书:0.75 = 第 2 页的一半(口径 = (页 + 页内比例) / 总页数)。
    strip.scrollToFraction(0.75)
    expect(container.scrollTop).toBe(1180 + 776)
    expect(onScroll.mock.calls.at(-1)).toEqual([1, 0.5])

    strip.goToIndex(0)
    expect(container.scrollTop).toBe(0)
    expect(onScroll.mock.calls.at(-1)).toEqual([0, 0])
  })

  it('rerenderMounted 用当前缩放重画已挂载页(主题切换走这条)', async () => {
    await mountStrip([{ width: 400, height: 600 }])
    const iframe = host.querySelector<HTMLIFrameElement>('iframe')!
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: document.implementation.createHTMLDocument(),
    })
    iframe.dispatchEvent(new Event('load'))
    onZoom.mockClear()
    strip.rerenderMounted()
    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onZoom.mock.calls[0]?.[0]).toMatchObject({ scale: 1.94 })
  })
})

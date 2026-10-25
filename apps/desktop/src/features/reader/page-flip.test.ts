/**
 * 纸叶翻页契约(readest 那套时序的桌面版):
 * 克隆书页 → 铺满正文 → 内核在纸叶底下瞬间翻页 → 纸叶绕书脊转走 → 拆掉。
 * 这几条是「翻页闪一下」与「纸叶留在正文上」两块回归的防线。
 *
 * 纸叶在动画结束后就被拆了,所以断言都抓在 `flip` 里那一刻 —— 正是内核换页
 * 被纸叶盖住的瞬间,也是这套时序唯一要保证成立的时刻。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { animateFlipTurn } from './page-flip'

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

const withRect = (el: Element, { x, y, w, h }: Box): void => {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }),
  })
}

/** 造一个装着书页文档的 iframe:jsdom 的 about:blank 文档能同步拿到。 */
function pageFrame(markup = '<p>第一章正文</p>'): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frame.contentDocument!.body.innerHTML = markup
  return frame
}

/** 批注层:内核把它叠在 iframe 上,不在书页文档里。 */
function overlay(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  document.body.append(svg)
  return svg
}

let animate: ReturnType<typeof vi.fn>

beforeEach(() => {
  animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: () => {} }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
})

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'animate')
  document.body.innerHTML = ''
})

function makeHost(): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  withRect(host, { x: 0, y: 0, w: 800, h: 600 })
  return host
}

/** 跑一次翻页,把纸叶在 `flip` 那一刻的样子交回给断言。 */
async function turn(options: {
  host: HTMLElement
  layers: readonly Element[]
  dir: 'next' | 'prev'
  columns: 1 | 2
}): Promise<{ wrapper: HTMLElement | null; panes: HTMLElement[]; flips: number }> {
  const { host, layers, dir, columns } = options
  // 闭包里赋值 TS 不跟踪,放进数组才拿得到窄化后的类型。
  const seen: HTMLElement[] = []
  let flips = 0
  await animateFlipTurn({
    host,
    layers,
    dir,
    columns,
    flip: async () => {
      flips++
      const wrapper = host.firstElementChild
      if (wrapper) seen.push(wrapper as HTMLElement)
    },
  })
  const wrapper = seen[0] ?? null
  const panes = wrapper === null ? [] : (Array.from(wrapper.children) as HTMLElement[])
  return { wrapper, panes, flips }
}

describe('animateFlipTurn', () => {
  it('没有可见页时退回宿主动画:不翻页,也不留纸叶', async () => {
    const host = makeHost()
    const flip = vi.fn(async () => {})
    await expect(
      animateFlipTurn({ host, layers: [], dir: 'next', columns: 1, flip }),
    ).resolves.toBe(false)
    expect(flip).not.toHaveBeenCalled()
    expect(host.children).toHaveLength(0)
  })

  it('纸叶克隆自书页文档,翻页那一刻已盖在正文上', async () => {
    const host = makeHost()
    const frame = pageFrame()
    // 书页 iframe 比版心宽得多(整章多列),被内核平移到当前页的偏移上。
    withRect(frame, { x: -1600, y: 0, w: 4000, h: 600 })
    const { wrapper, flips } = await turn({ host, layers: [frame], dir: 'next', columns: 1 })
    expect(flips).toBe(1)
    expect(wrapper).not.toBeNull()
    const leaf = wrapper!.querySelector('iframe') as HTMLIFrameElement
    // 同一份文档:图片、字体一起带走。
    expect(leaf.contentDocument?.body.innerHTML).toBe('<p>第一章正文</p>')
    // 几何照抄原 iframe:纸叶与真身逐像素对齐(含内核的负向平移)。
    expect(leaf.style.left).toBe('-1600px')
    expect(leaf.style.width).toBe('4000px')
    // 书里的脚本不能在纸叶里再跑一遍,但父页面要能写它的文档。
    expect(leaf.getAttribute('sandbox')).toBe('allow-same-origin')
  })

  it('批注层跟书页一起克隆:翻页那半秒里划线不会整片消失', async () => {
    const host = makeHost()
    const frame = pageFrame()
    const svg = overlay()
    withRect(frame, { x: 0, y: 0, w: 800, h: 600 })
    withRect(svg, { x: 0, y: 0, w: 800, h: 600 })
    const { wrapper } = await turn({ host, layers: [frame, svg], dir: 'next', columns: 1 })
    // 顺序就是绘制顺序:iframe 在下、批注 SVG 在上。
    expect(wrapper!.children[0]!.children[0]!.tagName).toBe('IFRAME')
    expect(wrapper!.children[0]!.children[1]!.tagName).toBe('svg')
  })

  it('单页:铰链在纸叶左缘,向前翻转 -90°;往回翻铰链落右缘', async () => {
    const host = makeHost()
    const frame = pageFrame()
    withRect(frame, { x: 0, y: 0, w: 800, h: 600 })
    const next = await turn({ host, layers: [frame], dir: 'next', columns: 1 })
    expect(next.panes).toHaveLength(1)
    expect(next.panes[0]!.style.transformOrigin).toBe('left center')
    expect(next.panes[0]!.style.width).toBe('800px')
    const keyframes = animate.mock.calls[0]?.[0] as Keyframe[]
    expect(keyframes.at(-1)).toMatchObject({ transform: 'rotateY(-90deg)' })

    const prev = await turn({ host, layers: [frame], dir: 'prev', columns: 1 })
    expect(prev.panes[0]!.style.transformOrigin).toBe('right center')
  })

  it('双页:只转外侧那一半,铰链落在书脊(版心正中),另一半整幅淡出', async () => {
    const host = makeHost()
    const frame = pageFrame()
    withRect(frame, { x: 0, y: 0, w: 800, h: 600 })
    const { panes } = await turn({ host, layers: [frame], dir: 'next', columns: 2 })
    // 两层:没翻的那一半(整幅淡出)+ 转走的那一半。
    expect(panes).toHaveLength(2)
    expect(panes[0]!.style.width).toBe('800px')
    expect(panes[1]!.style.left).toBe('400px')
    expect(panes[1]!.style.width).toBe('400px')
    expect(panes[1]!.style.transformOrigin).toBe('left center')
  })

  it('内核翻页抛错也要把纸叶拆掉:不留残影,错误照旧抛出', async () => {
    const host = makeHost()
    const frame = pageFrame()
    withRect(frame, { x: 0, y: 0, w: 800, h: 600 })
    await expect(
      animateFlipTurn({
        host,
        layers: [frame],
        dir: 'next',
        columns: 1,
        flip: async () => {
          throw new Error('kernel broke')
        },
      }),
    ).rejects.toThrow('kernel broke')
    expect(host.children).toHaveLength(0)
  })

  it('克隆失败(书页量不出来)时返回 false 且不翻页', async () => {
    const host = makeHost()
    const frame = pageFrame()
    // 藏起来的那一页:量出来是 0,不该被当成纸叶。
    withRect(frame, { x: 0, y: 0, w: 0, h: 0 })
    const flip = vi.fn(async () => {})
    await expect(
      animateFlipTurn({ host, layers: [frame], dir: 'next', columns: 1, flip }),
    ).resolves.toBe(false)
    expect(flip).not.toHaveBeenCalled()
    expect(host.children).toHaveLength(0)
  })

  it('版心没量出来(隐藏态)直接退回,不建纸叶', async () => {
    const host = makeHost()
    withRect(host, { x: 0, y: 0, w: 0, h: 0 })
    const frame = pageFrame()
    withRect(frame, { x: 0, y: 0, w: 800, h: 600 })
    await expect(
      animateFlipTurn({ host, layers: [frame], dir: 'next', columns: 1, flip: async () => {} }),
    ).resolves.toBe(false)
    expect(host.children).toHaveLength(0)
  })

  it('纸叶不吃指针事件,也不进无障碍树', async () => {
    const host = makeHost()
    const frame = pageFrame()
    withRect(frame, { x: 0, y: 0, w: 800, h: 600 })
    const { wrapper } = await turn({ host, layers: [frame], dir: 'next', columns: 1 })
    expect(wrapper!.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper!.style.pointerEvents).toBe('none')
    expect(wrapper!.style.overflow).toBe('hidden')
    expect(wrapper!.style.perspective).toBe('1760px')
  })
})

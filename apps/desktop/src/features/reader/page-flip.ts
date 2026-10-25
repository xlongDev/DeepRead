/**
 * 仿真翻页 —— 纸叶(page leaf)。
 *
 * readest 的做法是「先把当前页抓成一张位图,让内核在位图底下瞬间翻页,再把
 * 位图当一张纸卷走」(原生快照 + WebGL:64 段铰接、每段 π/65,弯折带占纸宽
 * 0.7,配透视与正反面明暗)。位图在桌面端拿不到 —— 书页住在内核**关闭影子根
 * 里的 iframe**,WKWebView / WebView2 都没有 JS 侧的截图口子;readest 自己
 * 也只在 Android / iOS 走原生 PixelCopy / takeSnapshot,桌面回落到
 * View Transitions。
 *
 * 这里的替代:不抓位图,**整棵克隆书页文档**当纸叶。同一个文档、同一份样式、
 * 同一处几何(直接抄 iframe 的视口矩形),所以纸叶和真身逐像素一致 —— 批注
 * SVG、图片、字体一起带走。流程照搬 readest:
 *
 *   克隆( capture )→ 铺满正文 → 内核在纸叶底下瞬间翻页 → 纸叶绕书脊转走
 *   → 拆掉纸叶。
 *
 * 老实现(宿主 WAAPI 两段动画夹一次翻页 + 「停车」)整段作废:纸叶全程盖着
 * 正文,翻页窗口根本不露,也就不再需要停车,更不需要靠 opacity 把半透明的
 * 旧页藏起来 —— 旧页现在是实实在在转走的。
 *
 * 观感上限写在前面:纸叶是活的 DOM,**不能被网格弯折**(readest 那 64 段铰接
 * 只有位图才做得到),只能整张绕书脊刚性转走。没有卷曲,但有真实的纸页抬起、
 * 投影、暗面,以及新的一页被真正「露出来」而不是淡入。想要卷曲,得先有原生
 * 页面快照,再把这套时序接到 readest 的 pageCurlMesh 上。
 *
 * 已知风险:WKWebView 在 iframe 的祖先层做 3D 变换时,提层瞬间可能有栅格
 * 闪烁(老实现就是因为这条才退回内核动画)。这里躲不开 —— 纸叶必须是书页
 * 文档的克隆。真出问题,退路是 `animateFlipTurn` 返回 false 时的旧动画。
 */

import type { PageTurnDir } from './page-turn'

export interface FlipTurnRequest {
  /** 阅读宿主(纸叶挂在它里面,铺满整个版心)。 */
  readonly host: HTMLElement
  /** 纸叶要克隆的层:正文 iframe 在前、批注 SVG 在后(见 `FoliateAdapter.flipLeafLayers`)。 */
  readonly layers: readonly Element[]
  readonly dir: PageTurnDir
  /** 版心列数:双页只转外侧那一页,铰链落在书脊(版心正中)。 */
  readonly columns: 1 | 2
  /** 内核瞬间翻页(animate:false),在纸叶底下完成。 */
  readonly flip: () => Promise<void>
}

/** 整轮时长对齐 readest 的 450ms 量级:再快纸页看不清,再慢像卡。 */
const DURATION_MS = 420
/** 起步慢、收尾缓 —— 手指离开纸页后的惯性。 */
const EASING = 'cubic-bezier(0.32, 0.72, 0.24, 1)'
/** 纸叶里的图与样式表要从缓存里再取一遍,等太久不如直接开翻。 */
const ASSET_BUDGET_MS = 120
/** 透视距离按版心宽给:窄栏翻起来起伏明显,宽屏不畸变。 */
const PERSPECTIVE_RATIO = 2.2

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 纸色:内核把文档 body 的背景清掉了(纸色由 paginator 自己铺),克隆出来
 *  的纸叶是透明的,不垫一层就会直接透出新的一页。 */
const paperColor = (host: HTMLElement): string =>
  getComputedStyle(host).getPropertyValue('--reader-bg').trim() || '#ffffff'

/**
 * 播一次仿真翻页。纸叶建不起来(没可见页 / 宿主不支持 WAAPI / 克隆失败)
 * 时返回 false 且不翻页 —— 由调用方退回 {@link animatePageTurn}。
 */
export async function animateFlipTurn(request: FlipTurnRequest): Promise<boolean> {
  const { host, layers, dir, columns, flip } = request
  if (layers.length === 0 || typeof host.animate !== 'function') return false
  const hostRect = host.getBoundingClientRect()
  if (hostRect.width < 1 || hostRect.height < 1) return false

  const wrapper = document.createElement('div')
  wrapper.setAttribute('aria-hidden', 'true')
  Object.assign(wrapper.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '5',
    perspective: `${Math.round(hostRect.width * PERSPECTIVE_RATIO)}px`,
  })
  host.append(wrapper)
  try {
    const paper = paperColor(host)
    const spread = columns === 2
    const leafWidth = spread ? hostRect.width / 2 : hostRect.width
    // 铰链(书脊):向前翻是纸叶左缘,往回翻是纸叶右缘;双页时两边都落在版心正中。
    const hingeLeft = dir === 'next' && spread ? leafWidth : 0
    // 双页的另一半在内核翻页后就换了页,没有背面可翻,只能整幅淡出把新页透出来。
    const held = spread ? addPane(wrapper, paper, 0, hostRect.width) : null
    const hinge = addPane(wrapper, paper, hingeLeft, leafWidth)
    Object.assign(hinge.style, {
      transformOrigin: dir === 'next' ? 'left center' : 'right center',
      // 翻过 90° 纸页就该消失:背面是镜像正文,不能露。
      backfaceVisibility: 'hidden',
      willChange: 'transform',
    })

    const docs: Document[] = []
    for (const layer of layers) {
      // 双页要两份克隆:一份整幅淡出(没翻的那一半)、一份绕书脊转走。
      for (const pane of held === null ? [hinge] : [held, hinge]) {
        const doc = mountLayer(pane, layer, hostRect, pane === hinge ? hingeLeft : 0)
        if (doc === null) return false
        if (doc !== undefined) docs.push(doc)
      }
    }
    // 图 / 样式表没就位就开翻,纸叶会先空一拍再补上 —— 宁可等,也有上限。
    await Promise.race([waitForAssets(docs), delay(ASSET_BUDGET_MS)])
    // 纸叶必须真的上了屏才让内核换页,否则换页那一帧会当着用户露出来。
    await nextFrame()
    await nextFrame()

    await flip()

    const animations = [
      hinge.animate(
        [
          { transform: 'rotateY(0deg)', boxShadow: '0 0 0 rgba(0, 0, 0, 0)' },
          {
            transform: `rotateY(${dir === 'next' ? -90 : 90}deg)`,
            // 投影落在被露出来的那一页上,跟着纸页一起走。
            boxShadow: `${dir === 'next' ? 26 : -26}px 0 38px rgba(0, 0, 0, 0.3)`,
          },
        ],
        { duration: DURATION_MS, easing: EASING, fill: 'forwards' },
      ),
      // 纸面转离光源,越翻越暗。
      shadePane(hinge, dir),
    ]
    // 没翻的那一半:整幅淡出,底下的新页透上来(硬切太跳)。
    if (held !== null)
      animations.push(
        held.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: DURATION_MS,
          easing: EASING,
          fill: 'forwards',
        }),
      )
    await Promise.all(animations.map((a) => a.finished)).catch(() => {})
    return true
  } finally {
    // 终帧纸叶已转成一条线,直接拆;翻页抛错时同样不能把纸叶留在正文上。
    wrapper.remove()
  }
}

/** 一层纸:盒子按版心切出一块,里头的书页克隆超出的部分被裁掉。 */
function addPane(wrapper: HTMLElement, paper: string, left: number, width: number): HTMLElement {
  const pane = document.createElement('div')
  Object.assign(pane.style, {
    position: 'absolute',
    left: `${left}px`,
    top: '0',
    width: `${width}px`,
    height: '100%',
    overflow: 'hidden',
    background: paper,
    boxShadow: '0 0 0 rgba(0, 0, 0, 0)',
  })
  wrapper.append(pane)
  return pane
}

/** 明暗层:纸页转离光源,铰链一侧压深。 */
function shadePane(pane: HTMLElement, dir: PageTurnDir): Animation {
  const layer = document.createElement('div')
  Object.assign(layer.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    opacity: '0',
    background:
      dir === 'next'
        ? 'linear-gradient(90deg, rgba(0, 0, 0, 0.22), rgba(0, 0, 0, 0) 55%)'
        : 'linear-gradient(270deg, rgba(0, 0, 0, 0.22), rgba(0, 0, 0, 0) 55%)',
  })
  pane.append(layer)
  return layer.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: DURATION_MS,
    easing: EASING,
    fill: 'forwards',
  })
}

/**
 * 把一层(书页 iframe / 批注 SVG)克隆成纸叶的一部分挂进 `pane`。
 *
 * 几何直接抄原元素的视口矩形 —— 同一个文档、同一份样式、同一处位置,纸叶
 * 和真身逐像素一致。返回克隆出来的文档(只有 iframe 有,等资源用);
 * 拿不到内容返回 null,整轮翻页作废。
 */
function mountLayer(
  pane: HTMLElement,
  layer: Element,
  hostRect: DOMRect,
  paneLeft: number,
): Document | undefined | null {
  const rect = layer.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null

  // 批注层:一张普通 SVG,整棵克隆、按原位置摆好就行。
  if (layer.tagName !== 'IFRAME') {
    const clone = layer.cloneNode(true) as HTMLElement
    place(clone, rect, hostRect, paneLeft)
    pane.append(clone)
    return undefined
  }

  const source = (layer as HTMLIFrameElement).contentDocument
  if (!source?.documentElement) return null
  const leaf = document.createElement('iframe')
  place(leaf, rect, hostRect, paneLeft)
  Object.assign(leaf.style, {
    border: '0',
    // 内核挂在书页上的滤镜(夜间重着色的 url(#id))不随文档克隆,照抄计算值。
    filter: getComputedStyle(layer).filter,
  })
  // 书里的脚本不能在纸叶里再跑一遍;allow-same-origin 留着,父页面还要写文档。
  leaf.setAttribute('sandbox', 'allow-same-origin')
  leaf.setAttribute('scrolling', 'no')
  pane.append(leaf)

  const doc = leaf.contentDocument
  if (!doc?.documentElement) return null
  const clone = doc.importNode(source.documentElement, true)
  for (const script of clone.querySelectorAll('script')) script.remove()
  doc.replaceChild(clone, doc.documentElement)
  return doc
}

/** 按原元素的视口位置摆进纸叶盒子(pane 自己裁掉超出的部分)。 */
function place(element: HTMLElement, rect: DOMRect, hostRect: DOMRect, paneLeft: number): void {
  Object.assign(element.style, {
    position: 'absolute',
    left: `${rect.left - hostRect.left - paneLeft}px`,
    top: `${rect.top - hostRect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

/** 等纸叶里的图与样式表就位:它们要按 blob URL 再取一遍(走缓存,通常一帧内)。 */
async function waitForAssets(docs: readonly Document[]): Promise<void> {
  const pending: Promise<unknown>[] = []
  const settled = (element: Element): Promise<unknown> =>
    new Promise((resolve) => {
      element.addEventListener('load', resolve, { once: true })
      element.addEventListener('error', resolve, { once: true })
    })
  for (const doc of docs) {
    for (const img of doc.querySelectorAll('img')) {
      if (!img.complete) pending.push(settled(img))
    }
    for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      if (!link.sheet) pending.push(settled(link))
    }
  }
  await Promise.all(pending)
}

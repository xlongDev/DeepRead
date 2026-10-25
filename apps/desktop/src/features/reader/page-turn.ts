/**
 * 翻页动画(宿主 WAAPI 两段式)—— 只服务「覆盖/淡入」两档,外加「仿真」档
 * 拿不到书页时的退化路径;
 * 「滑动」档走内核自带的 animated 翻页(真实内容运动、无空窗,见
 * FoliateAdapter 的 `animated` 属性与 ReaderScreen.turnPage 的注释);
 * 「仿真」档的正式实现在 page-flip.ts —— 它克隆整页书当纸叶盖住正文,
 * 翻页窗口根本不露,本文件的 flip 计划只在纸叶建不起来时兜底。
 *
 * 旧实现(含「滑动」档都在这里放)的历史问题,两条都已修:
 * 1. View Transitions 依赖浏览器对 `.reader-host` 的快照,而书页内容住在
 *    foliate 的 **closed shadow root 里的 iframe** 中 —— 快照拿不到
 *    iframe 内容(WKWebView 尤其如此),过渡要么整段被跳过、要么推一张空
 *    白快照上来,用户看到的就是「翻页动画无效」+ 一次空白闪帧。现在不做
 *    快照:直接对书页层做 WAAPI 两段动画,内核瞬时换页夹在中间 —— 旧页
 *    退场 → 翻页 → 新页进场。动的是真实 DOM,任何引擎都必然生效;顶栏/
 *    底栏/面板不在 host 里,保持静止。
 * 2. 「闪一下」:两段动画之间夹着内核翻页(flip),folio 默认每次翻页强制
 *    debounce 100ms(调用方已传 animate:false 摘掉它,但翻页本身仍有耗时),
 *    这段空窗里 host 停在半路/屏外,旧页已消失、新页未进场,用户看到的
 *    就是内容闪空一下。修法是「停车」(park):翻页前先把 host 钉在进场段
 *    首帧上,空窗于是完全停在不可见状态(屏外 / opacity 0)——
 *    不停车的话,新页会在空窗里以自然位置整个弹出,再跳回屏外重新进场
 *    (每次翻页必闪);仿真档 out/in 绕反方向(±82°),半透明的旧页还会
 *    在空窗里当着用户的面翻面。
 *
 * 3. 「仿真档翻页后排版错乱」(本文件头上的 #parkGeometry):停车帧**不是
 *    随便挑一个不可见状态就行**——它压在内核翻页窗口上,而内核在窗口里
 *    活着:folio `#beforeRender` 用 `container.getBoundingClientRect()` 量
 *    页面尺寸,跨章翻页时 `view.load(src, afterLoad, beforeRender)` 把这次
 *    测量拌进 await 链;`size`/`page`/`atEnd` 一族 getter 同样建在它上面。
 *    **祖先的 transform 会污染 getBoundingClientRect**:仿真档停车在
 *    rotateY(82°) 时,700px 的容器量出来只有 ~99px(700×cos82°),内核据此
 *    columnize 出窄列宽写进 iframe 文档——动画结束后没人再重排,错乱就
 *    这么钉死了(还顺带把 atEnd 算成 true,翻页直接 no-op)。所以仿真档的
 *    停车帧必须几何中性:只有 opacity 0,transform 显式 none。覆盖档的
 *    停车帧可以带 transform,但只能是纯平移——平移不改宽度测量,且它
 *    需要整张停在屏外。
 */

import type { PageTurnStyle } from './reader-options'

export type PageTurnDir = 'next' | 'prev'

type Frames = Keyframe[]
type Plan = {
  readonly out: (dir: PageTurnDir) => Frames
  readonly outDuration: number
  readonly outEasing: string
  /** 翻页空窗期的停放帧:必须不可见,且不得含会缩放/旋转的 transform
   *  (缩放/旋转会污染内核的 getBoundingClientRect 测量,见文件头 #3)。
   *  纯平移(覆盖档的屏外停车)不影响宽度测量,可以留。 */
  readonly park: (dir: PageTurnDir) => Keyframe
  readonly inFrames: (dir: PageTurnDir) => Frames
  readonly inDuration: number
  readonly inEasing: string
}

const sign = (dir: PageTurnDir): number => (dir === 'next' ? -1 : 1)

const EASE_OUT = 'cubic-bezier(0.2, 0.7, 0.3, 1)'
const EASE_IN = 'cubic-bezier(0.4, 0, 0.7, 0.4)'

/** 覆盖档进场段首帧:整张新页停在屏外,带纸边投影。 */
const coverInStart = (dir: PageTurnDir): Keyframe => ({
  transform: `translateX(${-sign(dir) * 100}%)`,
  boxShadow: `${-sign(dir) * 28}px 0 52px rgba(0, 0, 0, 0.2)`,
})

/** 各档位的两段动画。out = 翻页前旧页退场;in = 翻页后新页进场。
 *  「滑动」不在这里:它走内核 animated 滑动,见文件头注释。 */
const PLANS: Readonly<Record<'cover' | 'flip' | 'fade', Plan>> = {
  cover: {
    // 覆盖:旧页向行进方向退场,新页整张从对面盖上来(带纸边投影)。
    // 单宿主元素做不了「旧页不动、新页盖上」(旧页在翻页瞬间就被内核换
    // 掉了),所以 out 段不可省 —— 没有它,停车会把旧页在点击瞬间硬切走,
    // 用户先看到一帧空白再看到新页滑入,比不停车更糟。
    out: (dir) => [
      { transform: 'translateX(0)' },
      { transform: `translateX(${sign(dir) * 100}%)` },
    ],
    outDuration: 240,
    outEasing: EASE_IN,
    // 停车帧同进场首帧:纯平移把 host 挪出屏外。平移不改变
    // getBoundingClientRect 的宽高,内核翻页窗口里量到的尺寸是干净的。
    park: coverInStart,
    inFrames: (dir) => [
      coverInStart(dir),
      { transform: 'translateX(0)', boxShadow: '0 0 0 rgba(0, 0, 0, 0)' },
    ],
    inDuration: 340,
    inEasing: EASE_OUT,
  },
  flip: {
    // 仿真(兜底):旧页绕书脊掀起离场,新页从对称角落回。正式路径见
    // page-flip.ts,那里旧页是真身克隆、翻页全程被盖住。perspective 内联进
    // transform(rotateY 没有透视只是水平压缩)。换页瞬间必须不可见:
    // out 收在 opacity 0、in 起在 opacity 0,否则空窗里那半透明的旧页
    // 会当着用户的面从 +82° 翻到 -82°。
    out: (dir) => [
      { transform: 'perspective(2400px) rotateY(0)', opacity: 1 },
      { transform: `perspective(2400px) rotateY(${sign(dir) * 82}deg)`, opacity: 0 },
    ],
    outDuration: 240,
    outEasing: EASE_IN,
    // 停车帧几何中性:transform 显式 none(压过 out 段 fill 留下的
    // rotateY),只留 opacity 0。rotateY(82°) 会把容器量成 ~99px 宽,
    // 内核据此 columnize 出的窄列宽会写进 iframe 文档并永不重排——
    // 这就是「仿真翻页后排版错乱」的根因,见文件头 #3。
    park: () => ({ transform: 'none', opacity: 0 }),
    inFrames: (dir) => [
      { transform: `perspective(2400px) rotateY(${-sign(dir) * 82}deg)`, opacity: 0 },
      { transform: 'perspective(2400px) rotateY(0)', opacity: 1 },
    ],
    inDuration: 280,
    inEasing: EASE_OUT,
  },
  fade: {
    out: () => [{ opacity: 1 }, { opacity: 0 }],
    outDuration: 150,
    outEasing: 'ease-out',
    park: () => ({ opacity: 0 }),
    inFrames: () => [{ opacity: 0 }, { opacity: 1 }],
    inDuration: 220,
    inEasing: 'ease-out',
  },
}

/** 同一 host 上还没放完的上一轮动画:新一轮开始时先取消,避免 fill 残留
 *  把 transform 钉在半路。 */
const running = new WeakMap<Element, Animation[]>()

/**
 * 围绕 `flip`(内核瞬时换页)对 `host` 播放 `style` 档位的翻页动画。
 * 引擎不支持 element.animate、或该档位没有动画计划(无/none)时退化为
 * 直接翻页。
 */
export async function animatePageTurn(
  host: Element,
  style: PageTurnStyle,
  dir: PageTurnDir,
  flip: () => Promise<void>,
): Promise<void> {
  // slide 走内核 animated 滑动、none 不播动画,两者都没有宿主动画计划。
  const plan = style === 'cover' || style === 'flip' || style === 'fade' ? PLANS[style] : undefined
  if (plan === undefined || typeof host.animate !== 'function') {
    await flip()
    return
  }
  for (const previous of running.get(host) ?? []) previous.cancel()

  const started: Animation[] = []
  running.set(host, started)
  const track = (anim: Animation): Animation => {
    started.push(anim)
    return anim
  }
  try {
    const outAnim = track(
      host.animate(plan.out(dir), {
        duration: plan.outDuration,
        easing: plan.outEasing,
        fill: 'forwards',
      }),
    )
    await outAnim.finished.catch(() => {})
    // 停车(park):零时长 + fill:'both',把 host 钉在停放帧上。内核翻页
    // 期间的每一帧都停在这个不可见状态,空窗不再露内容:覆盖档翻页间隙
    // 旧页已退场,不停车新页会在空窗里以自然位置整个弹出,再跳回屏外
    // 重新滑入(每次翻页必闪);仿真档 out/in 绕反方向,半透明旧页会当着
    // 用户的面翻面。创建在 out 之后 → 合成顺序压过 out 的 fill(仿真档
    // 的 transform:none 正是靠这个压掉 out 留下的 rotateY);放进场动画
    // 后又压过它。停放帧的约束(不可见 + 几何中性)见 Plan.park 注释。
    const parkFrame = plan.park(dir)
    track(host.animate([parkFrame, parkFrame], { duration: 0, fill: 'both' }))
    await flip()
    const extra: Record<string, string> =
      style === 'flip' ? { transformOrigin: dir === 'next' ? 'left center' : 'right center' } : {}
    const inAnim = track(
      host.animate(
        plan.inFrames(dir).map((frame) => ({ ...frame, ...extra })),
        {
          duration: plan.inDuration,
          easing: plan.inEasing,
          fill: 'forwards',
        },
      ),
    )
    await inAnim.finished.catch(() => {})
  } finally {
    // 终帧都是恒等态:清掉 fill,把 host 交还给普通布局。
    for (const anim of started) anim.cancel()
    running.set(host, [])
  }
}

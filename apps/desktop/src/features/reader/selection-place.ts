/**
 * 划词工具的几何:选区锚点 → 面板位置。
 *
 * 纯函数、无 DOM。ReaderScreen 只负责把测量好的 `SelectionGeometry` 喂进来,
 * 单元测试因此不需要 jsdom —— 这条路径上真正会错的(窄窗、贴边、翻到上方)
 * 全是算术,不是渲染。
 *
 * 三个输入frame、面板、锚点全部用「宿主窗口坐标系」(`position: fixed` 的那
 * 个坐标系):选区的 rect 由内核从 iframe 里换算成窗口坐标后传来(见
 * `engine.ts` 的 `onSelection`),所以这里不再碰 iframe。
 */

/** 视口 insets:面板永远离阅读区边缘这么远(px)。 */
export const TOOLBAR_EDGE = 12

/** 面板宽度(px)。动作带 9 个 32px 图标 + justify-between 的呼吸缝;再宽
 *  按钮间距会被摊得太散,再窄就开始换行。 */
export const TOOLBAR_WIDTH = 372

/** 窄阅读区下的宽度下限:再窄就让图标换行,而不是把面板挤出页面。 */
export const TOOLBAR_MIN_WIDTH = 300

/** 面板底边与选区框之间的缝隙(px)。选区框落在文字 content box 上,行剩余
 *  的 leading 在它下面 —— 留一丝缝,图标落进缝隙而不是压住下一行。 */
export const TOOLBAR_GAP = 2

/** 面板的近似高度(px),只用来决定入场动画从哪侧滑入;定位本身靠测量。 */
export const TOOLBAR_ENTRANCE_HEIGHT = 96

/** 阅读内容区的矩形:宿主窗口坐标系。 */
export interface ReadingFrame {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** 选区锚点:窗口坐标系。`bottom` 是选中文字最低行的底边。 */
export interface SelectionAnchor {
  /** 选区框中心的 x,面板以它为水平中心。 */
  readonly x: number
  /** 选区框顶边。 */
  readonly top: number
  /** 选区框底边 —— 面板优先贴着它下面放。 */
  readonly bottom: number
}

/** 定位结果。`left` 写进 inline style,`top` 由组件测量后覆盖。 */
export interface ToolbarPlacement {
  readonly left: number
  /** 面板会落在选区的哪一侧:true = 上方。只用于瞄准入场偏移。 */
  readonly above: boolean
  /** 面板在本帧内放得下的高度;调用方据此决定「贴着下面」还是「翻到上面」。 */
  readonly fitsBelow: boolean
}

/** 窗口兜底帧:没有 `[data-reading-content]` 时(挂载瞬间、测试)用它。 */
export function windowFrame(width: number, height: number): ReadingFrame {
  return { left: 0, top: 0, right: width, bottom: height }
}

/**
 * 水平定位:以选区中心对齐,整体夹进阅读区。
 *
 * 宽度也按阅读区收窄:固定 446px 的面板在窄阅读区里根本夹不住,left 下界会
 * 直接赢,面板挂在页面外。
 */
export function placeToolbarX(frame: ReadingFrame, x: number, width: number): number {
  const minLeft = frame.left + TOOLBAR_EDGE
  const maxLeft = frame.right - TOOLBAR_EDGE - width
  return Math.min(Math.max(x - width / 2, minLeft), Math.max(maxLeft, minLeft))
}

/** 面板在阅读区内可用的宽度:窄阅读区会低于 `TOOLBAR_WIDTH`。 */
export function toolbarWidth(frame: ReadingFrame): number {
  return Math.min(
    TOOLBAR_WIDTH,
    Math.max(frame.right - frame.left - TOOLBAR_EDGE * 2, TOOLBAR_MIN_WIDTH),
  )
}

/**
 * 垂直定位:整块面板放得下就贴选区下方,否则翻到上方;两侧都放不下时夹在
 * 阅读区头尾之间。
 *
 * `panelHeight` 是**测量值** —— 高度取决于内容(窄页图标换行、笔记字段展开),
 * 常量一旦漂移,夹取就是拿它当真值,面板会挂出阅读区脚底。
 */
export function placeToolbarY(
  frame: ReadingFrame,
  anchor: SelectionAnchor,
  panelHeight: number,
): { top: number; above: boolean; fitsBelow: boolean } {
  const head = frame.top + TOOLBAR_EDGE
  const foot = frame.bottom - TOOLBAR_EDGE
  const fitsBelow = anchor.bottom + TOOLBAR_GAP + panelHeight <= foot
  const wanted = fitsBelow
    ? anchor.bottom + TOOLBAR_GAP
    : // 翻到上方:贴着选区顶边。若上面也不够,最终 clamp 会把面板压在头顶。
      anchor.top - TOOLBAR_GAP - panelHeight
  return {
    top: Math.min(Math.max(wanted, head), Math.max(foot - panelHeight, head)),
    above: !fitsBelow,
    fitsBelow,
  }
}

/**
 * 选区 rect → 锚点。内核只给 top/left/height,底边自己算。
 */
export function anchorFromRect(rect: {
  readonly top: number
  readonly left: number
  readonly height: number
}): SelectionAnchor {
  return { x: rect.left, top: rect.top, bottom: rect.top + rect.height }
}

/** 划词工具的典型高度(动作带 + 墨带,笔记字段收起时):协作浮层(翻译卡)
 *  避让它时按这个估算。实测 86px,取整留余量;笔记展开时卡片可能轻叠一两
 *  像素,比把卡片扔到屏幕外好。 */
export const TOOLBAR_TYPICAL_HEIGHT = 96

/**
 * 协作浮层(翻译卡)的落点:避开划词工具,不遮它。
 *
 * 三级落位,逐级退让:
 *   1. 工具在选区下方 → 卡片去工具底下;
 *      底下放不下(卡片高)→ 翻到选区上方,与工具异侧;
 *   2. 工具翻到了选区上方 → 卡片贴选区下沿;
 *      下沿也放不下 → 去工具更上方。
 * 都夹不住时 clamp 在阅读区内(与 placeToolbarY 同一套头尾边界)。
 *
 * `cardHeight` 用调用方对卡片高度的估计(卡片 max-height 有界,流式中会
 * 变化,但缝隙只需要一次算对)。
 */
export function placeCompanionCard(
  frame: ReadingFrame,
  anchor: SelectionAnchor,
  cardHeight: number,
): { top: number } {
  const head = frame.top + TOOLBAR_EDGE
  const foot = frame.bottom - TOOLBAR_EDGE
  const clamp = (top: number): number =>
    Math.min(Math.max(top, head), Math.max(foot - cardHeight, head))
  const toolbarBottom = anchor.bottom + TOOLBAR_GAP + TOOLBAR_TYPICAL_HEIGHT
  if (toolbarBottom <= foot) {
    // 工具在选区下方:卡片首选工具底下,放不下就翻去选区上方(异侧)。
    const belowToolbar = toolbarBottom + 8
    if (belowToolbar + cardHeight <= foot) return { top: belowToolbar }
    return { top: clamp(anchor.top - TOOLBAR_GAP - cardHeight) }
  }
  // 工具在选区上方:卡片贴选区下沿,放不下就去工具更上方。
  const belowSelection = anchor.bottom + 8
  if (belowSelection + cardHeight <= foot) return { top: belowSelection }
  return { top: clamp(anchor.top - TOOLBAR_GAP - TOOLBAR_TYPICAL_HEIGHT - 8 - cardHeight) }
}

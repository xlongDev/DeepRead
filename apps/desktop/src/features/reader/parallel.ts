/**
 * 并行阅读(双栏对照)的纯逻辑:分栏比例 + 联动对位的回声守卫。
 *
 * 和 selection-place.ts 同一个理由放在组件外:这里会错的都是算术与状态机,
 * 不是渲染,单测因此不需要 jsdom。
 */

export type PaneSide = 'a' | 'b'

/**
 * 分栏比例的上下限。30% 不是为了好看:
 * - 每栏至少要放得下排版面板(276px + 两侧 16px),窄于此面板会溢出栏外;
 * - 宿主宽度经 `#maxInlineSize` 推导栏宽,太窄时内核会把整页挤成一列乱码。
 */
export const SPLIT_MIN = 30
export const SPLIT_MAX = 70
export const SPLIT_DEFAULT = 50

/** 拖动分隔条时按一次方向键的步长(百分比)。 */
export const SPLIT_STEP = 2

/**
 * 联动回声窗口。本栏把对面拽到某个进度后,对面会回调一次 relocate ——
 * 那是回声,不能再转回去,否则两栏互相顶、无限对跳。
 *
 * 窗口要有上限:目标栏本来就在那一页时内核可能不回调,守卫若永久挂着,
 * 对面下一次**真实**的翻页会被当成回声吞掉(表现:联动偶尔失灵一次)。
 */
export const ECHO_WINDOW_MS = 700

/**
 * 联动的最小间隔。滚动模式下 relocate 每帧都报,不节流的话另一边会被
 * 拽着每秒跳几十次,读起来像在打架。
 */
export const RELAY_INTERVAL_MS = 120

const SPLIT_KEY = 'deepread.reader.split'

/** 脏值(NaN、越界、手改 localStorage)一律收成合法比例。 */
export function clampSplit(percent: number): number {
  if (!Number.isFinite(percent)) return SPLIT_DEFAULT
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(percent)))
}

export function loadSplit(): number {
  try {
    const stored = localStorage.getItem(SPLIT_KEY)
    return stored === null ? SPLIT_DEFAULT : clampSplit(Number(stored))
  } catch {
    return SPLIT_DEFAULT
  }
}

export function persistSplit(percent: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(clampSplit(percent)))
  } catch {
    // 隐私模式下 localStorage 会抛:比例记不住不影响读书。
  }
}

export function otherSide(side: PaneSide): PaneSide {
  return side === 'a' ? 'b' : 'a'
}

/** 「刚才把哪一栏拽到了别处,守卫到什么时候」。 */
export interface RelayEcho {
  readonly side: PaneSide
  readonly until: number
}

export interface RelayDecision {
  /** 这一跳要转给谁;null = 不转。 */
  readonly relay: PaneSide | null
  /** 下一轮的守卫。 */
  readonly echo: RelayEcho | null
}

/**
 * 本栏报了一次位置变化,决定要不要转给对面。
 *
 * - 守卫命中且未过期 → 这是对面拽过来的回声,吞掉(守卫一起清掉);
 * - 守卫命中但已过期 → 上次对面没回调,这一次是本栏用户自己的动作,照常转;
 * - 无守卫 → 照常转,并给对面挂上守卫。
 */
export function relayDecision(side: PaneSide, echo: RelayEcho | null, now: number): RelayDecision {
  if (echo !== null && echo.side === side) {
    if (now <= echo.until) return { relay: null, echo: null }
  }
  const target = otherSide(side)
  return { relay: target, echo: { side: target, until: now + ECHO_WINDOW_MS } }
}

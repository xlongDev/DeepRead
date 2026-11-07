/**
 * Motion tokens for JS-driven animation (CSS equivalents live in `tokens.css`).
 * All animation must respect `prefers-reduced-motion` (spec §12 / §20).
 */

export interface SpringParams {
  readonly stiffness: number
  readonly damping: number
  readonly mass: number
}

export const MOTION = {
  durationFastMs: 150,
  durationBaseMs: 250,
  durationSlowMs: 400,
  easeOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
  easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  springSnappy: { stiffness: 380, damping: 30, mass: 1 } satisfies SpringParams,
  springGentle: { stiffness: 210, damping: 26, mass: 1 } satisfies SpringParams,
} as const

/**
 * 用户意图,与「生效值」分开:
 *   system — 不写 DOM 属性,系统偏好交给浏览器原生的 @media 处理
 *   reduce — 写 `data-motion="reduce"`,走 CSS 里那条并列的强制路径
 *
 * 刻意不做「系统偏好也解析成属性」的单一信号源:那需要 JS 监听 matchMedia
 * 变化,而且 React 挂载前属性还没写,首屏会有一段动画空窗。两条路径各自
 * 独立,用户的显式选择永远压过系统(只会更安静,不会更吵)。
 */
export type MotionPreference = 'system' | 'reduce'

export const MOTION_STORAGE_KEY = 'deepread.motion'

export const MOTION_PREFERENCE_OPTIONS: readonly {
  readonly value: MotionPreference
  readonly label: string
  readonly hint: string
}[] = [
  { value: 'system', label: '跟随系统', hint: '系统开启「减少动态效果」时自动生效' },
  { value: 'reduce', label: '减少动效', hint: '始终关闭界面过渡与装饰动画' },
]

export function parseMotionPreference(raw: string | null): MotionPreference {
  return raw === 'reduce' ? 'reduce' : 'system'
}

/** 用户意图 → 写在 `<html>` 上的生效值;null 表示移除属性、交还系统。 */
export function motionAttribute(preference: MotionPreference): 'reduce' | null {
  return preference === 'reduce' ? 'reduce' : null
}

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') {
    return true
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

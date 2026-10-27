/**
 * 屏幕常亮(Wake Lock API):阅读/听书时系统别灭屏。特性探测兜底 ——
 * 不支持的环境(部分桌面 WebView)返回 no-op 会话,面板入口随之禁用;
 * 系统规范:页面转入后台会自动释放锁,恢复可见后需重新申请(调用方的
 * visibilitychange 生命周期负责)。
 */

const WAKE_LOCK_KEY = 'deepread.reader.wakeLock'

/** 默认开:阅读应用「读到一半屏幕黑了」是最痛的失败;桌面不支持时入口禁用。 */
export function loadWakeLockEnabled(): boolean {
  try {
    return localStorage.getItem(WAKE_LOCK_KEY) !== 'off'
  } catch {
    return true
  }
}

export function persistWakeLockEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(WAKE_LOCK_KEY, enabled ? 'on' : 'off')
  } catch {
    // 写不进(隐私模式等):选择只对本会话生效。
  }
}

export interface WakeLockSession {
  /** false = 当前环境不支持(或申请被拒),release 是 no-op。 */
  readonly supported: boolean
  release(): void
}

interface WakeLockSentinel {
  release: () => Promise<void>
}

/** 当前环境是否支持 Wake Lock(面板入口据此禁用,而不是点了没反应)。 */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/** 申请屏幕常亮锁。申请失败(拒绝/不支持)都归入 unsupported 会话,
 *  调用方无需区分 —— 屏幕常亮是锦上添花,不值得为此报错打扰阅读。 */
export async function acquireWakeLock(): Promise<WakeLockSession> {
  const sentinel = (
    navigator as unknown as {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
    }
  ).wakeLock
  if (sentinel === undefined) return { supported: false, release: () => {} }
  try {
    const lock = await sentinel.request('screen')
    let released = false
    return {
      supported: true,
      release: () => {
        if (released) return
        released = true
        void lock.release().catch(() => {})
      },
    }
  } catch {
    return { supported: false, release: () => {} }
  }
}

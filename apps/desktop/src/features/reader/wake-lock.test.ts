// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireWakeLock,
  isWakeLockSupported,
  loadWakeLockEnabled,
  persistWakeLockEnabled,
} from './wake-lock'

afterEach(() => {
  localStorage.clear()
  delete (navigator as unknown as Record<string, unknown>).wakeLock
})

describe('屏幕常亮(Wake Lock)', () => {
  it('偏好默认开;off 持久化往返', () => {
    expect(loadWakeLockEnabled()).toBe(true)
    persistWakeLockEnabled(false)
    expect(loadWakeLockEnabled()).toBe(false)
    persistWakeLockEnabled(true)
    expect(loadWakeLockEnabled()).toBe(true)
  })

  it('不支持的环境:isWakeLockSupported false,acquire 返回 no-op 会话', async () => {
    expect(isWakeLockSupported()).toBe(false)
    const session = await acquireWakeLock()
    expect(session.supported).toBe(false)
    expect(() => session.release()).not.toThrow()
  })

  it('支持的环境:申请到哨兵,release 幂等且只调一次底层', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue({ release })
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request },
    })
    expect(isWakeLockSupported()).toBe(true)

    const session = await acquireWakeLock()
    expect(session.supported).toBe(true)
    expect(request).toHaveBeenCalledWith('screen')
    session.release()
    session.release()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('申请被拒归入 unsupported 会话,不向调用方抛错', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const session = await acquireWakeLock()
    expect(session.supported).toBe(false)
  })
})

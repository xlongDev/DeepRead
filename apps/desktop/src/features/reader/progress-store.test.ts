import { describe, expect, it, vi } from 'vitest'
import { createProgressStore } from './progress-store'

describe('progress-store(进度下沉)', () => {
  it('set 换快照并通知订阅者;setFraction 只改 fraction、保留 cfi/location', () => {
    const store = createProgressStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.set({ cfi: 'epubcfi(/6/4!2/2)', fraction: 0.4, location: { current: 3, total: 12 } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get().cfi).toBe('epubcfi(/6/4!2/2)')

    store.setFraction(0.7)
    expect(listener).toHaveBeenCalledTimes(2)
    // cfi 与 location 原样保留 —— 拖动滑杆不改「当前页」口径。
    expect(store.get()).toEqual({
      cfi: 'epubcfi(/6/4!2/2)',
      fraction: 0.7,
      location: { current: 3, total: 12 },
    })

    unsubscribe()
    store.setFraction(0.9)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('初始快照:未报位时 cfi 为 null(落库进度为 null,书签键不可写)', () => {
    const store = createProgressStore()
    expect(store.get()).toEqual({ cfi: null, fraction: 0, location: undefined })
  })

  it('get 返回最新引用(useSyncExternalStore 的快照语义要求换引用)', () => {
    const store = createProgressStore()
    const before = store.get()
    store.setFraction(0.5)
    expect(store.get()).not.toBe(before)
  })
})

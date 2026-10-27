import { useSyncExternalStore } from 'react'

/**
 * 阅读进度外部 store:把高频 relocate 的进度从 ReaderScreen 的 state 里
 * 下沉出去 —— relocate 只写 store(零重渲染),只有真正显示进度的叶件
 * (底栏、顶栏书签键)经 useSyncExternalStore 订阅。
 *
 * 快照语义:cfi 永远保留**最近一次已知值**(内核某次上报不带 cfi 时不清掉
 * 旧的)—— 书签点亮与落库都按「当前页」口径;首次 relocate 之前是 null。
 */

export interface ReaderProgressSnapshot {
  readonly cfi: string | null
  readonly fraction: number
  readonly location: { readonly current: number; readonly total: number } | undefined
}

export interface ProgressStore {
  get(): ReaderProgressSnapshot
  set(next: ReaderProgressSnapshot): void
  /** 拖动滑杆:只改 fraction,cfi/location 保持(落点跳转发生在松手时)。 */
  setFraction(fraction: number): void
  subscribe(listener: () => void): () => void
}

export function createProgressStore(): ProgressStore {
  let snapshot: ReaderProgressSnapshot = { cfi: null, fraction: 0, location: undefined }
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    set(next) {
      snapshot = next
      listeners.forEach((listener) => listener())
    },
    setFraction(fraction) {
      snapshot = { ...snapshot, fraction }
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 订阅进度快照。**只有显示进度的叶件**(底栏、书签键)允许调用 ——
 *  ReaderScreen 本体不订阅,否则下沉失去意义。 */
export function useProgressSnapshot(store: ProgressStore): ReaderProgressSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * jsdom 没有 matchMedia。阅读器用它判断 `prefers-reduced-motion`(决定翻页是
 * 否走 View Transition),缺了会直接抛 `window.matchMedia is not a function`。
 * 统一在 setup 里补上,免得每个碰翻页的用例各补一次。
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList
}

/**
 * jsdom 也没有 ResizeObserver。`ScrollingText` 用它重新量文本溢出(字体异步加载完
 * 宽度会变),缺了会直接抛 `ResizeObserver is not defined`。这里给个空壳 ——
 * 测不了"溢出多少",但组件能正常挂载,用例关注的是它渲染出了什么。
 */
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void {
      // 不测量:jsdom 里没有布局,量出来的宽度没有意义。
    }

    unobserve(): void {
      // 同上。
    }

    disconnect(): void {
      // 同上。
    }
  } as unknown as typeof ResizeObserver
}

afterEach(() => {
  cleanup()
})

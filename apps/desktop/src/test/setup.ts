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

afterEach(() => {
  cleanup()
})

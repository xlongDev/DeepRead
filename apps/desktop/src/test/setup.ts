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

/**
 * jsdom 同样没有 IndexedDB,而 web 端的持久化(IndexedDB + IPC 分流)全靠它。
 * 用 `fake-indexeddb/auto` 把 IDBFactory 等挂到 globalThis —— 它是个纯内存实现,
 * 足以验证"写进去能读出来""事务失败要回滚""删书不留孤儿"这类行为。
 *
 * 动态 import + 容错:这个依赖没能进 lockfile 的环境(比如只跑了 npm 装、没跑
 * pnpm install)不该让**整套**测试崩掉。缺了的话,碰 IndexedDB 的用例会自己
 * 报错并指名道姓,比在 setup 阶段全军覆没更好定位。
 */
try {
  // @ts-expect-error -- fake-indexeddb 的 package.json exports 没给 `auto` 入口
  // 声明类型,TS 报 TS7016。它是纯副作用导入(把 IDBFactory 挂到 globalThis),
  // 本来就没有类型要引。
  await import('fake-indexeddb/auto')
} catch {
  console.warn('[test setup] fake-indexeddb 不可用,依赖 IndexedDB 的用例会失败')
}

/**
 * jsdom 的 `URL.createObjectURL` 升级后与 `Blob` 不配套了:它内部读 jsdom 私有的
 * `blob._bytes`,而 `globalThis.Blob` 已经不是 jsdom 那个实现(也不是 Node 的 ——
 * 拿 Node 的 `createObjectURL` 去接,它同样拒收)。两边不配套就抛
 * `Cannot read properties of undefined (reading '_bytes')`。
 *
 * 后果比看上去严重:`foliate-js/fb2.js` 在**模块顶层**给样式表建 blob URL,所以
 * `import { makeFB2 } from 'foliate-js/fb2.js'` 直接崩在 import 阶段 —— 整个测试
 * 文件一个用例都跑不到,而不是"某个用例失败"。定位时别被 "193 passed" 骗了:
 * 少掉的那 2 个就是没跑到的。
 *
 * 这里给个最小实现。jsdom 不会真的去加载 blob URL(没有网络栈),调用方拿它当
 * 字符串用而已。等 jsdom 把两边修配套就可以删。
 */
function canCreateObjectURL(): boolean {
  try {
    URL.createObjectURL(new Blob(['probe']))
    return true
  } catch {
    return false
  }
}

if (!canCreateObjectURL()) {
  URL.createObjectURL = (): string => `blob:vitest/${Math.random().toString(36).slice(2)}`
  URL.revokeObjectURL = (): void => {
    // 上面那个 URL 不指向任何东西,没什么可释放的。
  }
}

/**
 * jsdom 同样没有 Element.scrollIntoView(TTS 句子列表切句时把当前句滚到居中,
 * 内核目录跳转等也用它)。没有布局引擎,滚动了也没有意义,给个 no-op。
 */
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = (): void => {
    // jsdom 没有布局,无处可滚。
  }
}

afterEach(() => {
  cleanup()
})

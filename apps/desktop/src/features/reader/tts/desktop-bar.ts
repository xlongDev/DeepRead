/**
 * 桌面悬浮迷你条 —— 退到桌面/最小化后,听书的最后一界面。
 *
 * 参照 ColorReader 的 `mini_bar`:主窗口「不在眼前」(最小化或被红钮收起)时,
 * 一块无边框、置顶、不占程序坞的小胶囊浮在桌面底部,播放不中断。主窗口回到
 * 眼前,它自动退场 —— 应用内那条胶囊(tts-mini)接管。
 *
 * 分工刻意做得薄:
 * - **状态**(书名/章节/进度/剩余)由主窗口的 TtsDrawer 经 `tts://mini-state`
 *   事件推过来,本模块只转发,不持有;
 * - **控制**(播放/上一句/下一句/回到阅读/收起)由迷你条经 `tts://mini-control`
 *   发回,由 TtsDrawer 的 handle 执行 —— 播放在哪起,控制就回哪去;
 * - **去留**是本模块唯一的判断:主窗口可见且未最小化 → 不该出现(见
 *   {@link barBelongs})。
 *
 * 没有新增任何 invoke 命令:窗口经 JS `WebviewWindow` 创建,数据走 Tauri 事件,
 * 协议层(COMMAND/zod/ts-rs)不受影响。浏览器(非 Tauri)下整套是空操作。
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { isTauriRuntime } from '../../../lib/ipc'

/** 迷你条窗口的 label —— capabilities 也按它授权。 */
export const BAR_LABEL = 'tts-mini'
/** 主窗口的 label —— 控制事件显式发给它(不靠「广播」这种默认语义)。 */
const MAIN_LABEL = 'main'

/** 主窗口 → 迷你条:要画什么。 */
export const BAR_STATE_EVENT = 'tts://mini-state'
/** 迷你条 → 主窗口:用户按了什么。 */
export const BAR_CONTROL_EVENT = 'tts://mini-control'
/** 迷你条 → 主窗口:窗口刚画好,请立刻推一份状态(否则要等下一个 tick)。 */
export const BAR_READY_EVENT = 'tts://mini-ready'

export interface TtsBarState {
  readonly title: string
  readonly chapter: string | null
  readonly coverUrl: string | null
  /** 正在出声。 */
  readonly playing: boolean
  /** 合成中(还没出声)。 */
  readonly loading: boolean
  /** 0–1,本章进度。 */
  readonly progress: number
  /** 剩余时间的显示文本(已格式化)。 */
  readonly remaining: string
  readonly error: string | null
  /** 当前阅读主题的明暗:迷你条跟着 app 走,不在深色桌面上顶一盏白灯。 */
  readonly colorScheme: 'light' | 'dark'
}

export type TtsBarControl = 'toggle' | 'prev' | 'next' | 'reveal' | 'dismiss' | 'stop'

/** 胶囊尺寸(逻辑像素):比应用内那条宽一点,多带「回到阅读」与「收起」。 */
const BAR_W = 476
const BAR_H = 56
/** 距屏幕底边的距离:避开程序坞。 */
const BAR_LIFT = 72
/** 主窗口没有「被最小化」事件(tao 只报 focus/size/move),所以轮询问它。 */
const TICK_MS = 400

/**
 * 迷你条该不该在屏幕上 —— 本模块唯一的判断,抽成自由函数是为了能单测
 * (窗口调用 `let _ =` 断言不了,这个能)。
 *
 * 「不在眼前」是两半的或:最小化到程序坞,或被红钮收起(隐藏)。
 * 用户手动收起过(dismissed)就安静待着,直到主窗口回来。
 */
export function barBelongs(
  wanted: boolean,
  dismissed: boolean,
  mainVisible: boolean,
  mainMinimized: boolean,
): boolean {
  return wanted && !dismissed && (!mainVisible || mainMinimized)
}

let wanted = false
let dismissed = false
let bar: WebviewWindow | null = null
let ticker: ReturnType<typeof setInterval> | null = null
let onControl: ((action: TtsBarControl) => void) | null = null
let onRefresh: (() => void) | null = null

/**
 * 控制回路的监听在**模块加载时**就挂上,不等第一次起播。
 *
 * 曾经挂在 `desktopBarWatch(true)` 里 —— 结果任何一条链路没走到
 * (TtsDrawer 没挂载 / 会话信号没翻真),用户看到的就是「悬浮条上所有
 * 按钮都没反应」。监听本身没有成本,值得从第一步就在场。
 */
if (isTauriRuntime()) {
  // .catch 兜底:测试/半 mocked 环境里(有 __TAURI_INTERNALS__ 但没有完整
  // 事件桥)listen 会 reject —— void 掉的 rejection 会以 unhandled error
  // 的形式把 vitest 整轮判红,监听失败本身不值得让应用炸。
  void listen<TtsBarControl>(BAR_CONTROL_EVENT, (event) => {
    onControl?.(event.payload)
  }).catch(() => {})
  void listen(BAR_READY_EVENT, () => {
    onRefresh?.()
  }).catch(() => {})
}

async function ensureBar(): Promise<WebviewWindow | null> {
  if (bar !== null) return bar
  const created = new WebviewWindow(BAR_LABEL, {
    url: 'mini.html',
    title: 'DeepRead 朗读',
    width: BAR_W,
    height: BAR_H,
    // 桌面上的小胶囊:窗口本身什么都不是 —— 无框、无阴影、透明底,
    // 圆角与毛玻璃由内容自己画。backgroundColor 全透明是第二道保险:
    // 页面样式没加载完的那一瞬也不会闪一块白底。
    decorations: false,
    shadow: false,
    transparent: true,
    backgroundColor: [0, 0, 0, 0],
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visible: false,
  })
  bar = created
  // 等窗口真的建好再定位:创建是异步的,过早 setPosition 会落在默认位置上。
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    void created.once('tauri://created', finish)
    void created.once('tauri://error', finish)
    setTimeout(finish, 2000)
  })
  const monitor = await primaryMonitor()
  if (monitor !== null) {
    const scale = monitor.scaleFactor
    const width = monitor.size.width / scale
    const height = monitor.size.height / scale
    await created
      .setPosition(new LogicalPosition((width - BAR_W) / 2, height - BAR_H - BAR_LIFT))
      .catch(() => {})
  }
  return created
}

async function closeBar(): Promise<void> {
  const current = bar
  bar = null
  if (current === null) return
  await current.close().catch(() => {})
}

async function tick(): Promise<void> {
  const main = getCurrentWindow()
  const [visible, minimized] = await Promise.all([
    main.isVisible().catch(() => true),
    main.isMinimized().catch(() => false),
  ])
  // 主窗口回来了:上次手动收起的迷你条可以再次出现(下一轮最小化时)。
  if (visible && !minimized) dismissed = false
  const show = barBelongs(wanted, dismissed, visible, minimized)
  const current = show ? await ensureBar() : bar
  if (current === null) return
  const already = await current.isVisible().catch(() => false)
  if (already === show) return
  if (show) await current.show().catch(() => {})
  else await current.hide().catch(() => {})
}

/**
 * 会话开关:起播时开(true),停止/关闭时关(false)。
 * 关的那一下顺手把窗口收掉 —— 第二个 webview 不该在没有语音时白占内存。
 */
export function desktopBarWatch(active: boolean): void {
  if (!isTauriRuntime()) return
  wanted = active
  if (!active) {
    dismissed = false
    void closeBar()
    return
  }
  // 新开一次朗读会话:上一回手动收起的就不算了 —— 「这一本我想听着它」
  // 比「上一本我不想看见条」更新。
  dismissed = false
  if (ticker === null) ticker = setInterval(() => void tick(), TICK_MS)
  void tick()
}

/** 主窗口把「要画什么」显式发给迷你条窗口。非 Tauri 或无会话时是空操作。 */
export function desktopBarPublish(state: TtsBarState): void {
  if (!isTauriRuntime() || !wanted) return
  void emitTo(BAR_LABEL, BAR_STATE_EVENT, state).catch(() => {})
}

/** 注册迷你条的控制入口(由 TtsDrawer 的 handle 提供)。 */
export function onDesktopBarControl(
  handler: (action: TtsBarControl) => void,
  refresh: () => void,
): () => void {
  onControl = handler
  onRefresh = refresh
  return () => {
    onControl = null
    onRefresh = null
  }
}

/**
 * 迷你条 → 主窗口的控制入口。显式 `emitTo('main')`:广播语义在跨窗口时
 * 不够直白,点名发送让「发给谁」在代码里看得见,失败也立刻能报出来
 * (返回值交给调用方 —— 悬浮条要把它显示给用户,见 MiniBarWindow)。
 */
export function desktopBarSendControl(action: TtsBarControl): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve()
  return emitTo(MAIN_LABEL, BAR_CONTROL_EVENT, action)
}

/** 迷你条 → 主窗口:窗口画好了,要一份新鲜状态。 */
export function desktopBarAskState(): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve()
  return emitTo(MAIN_LABEL, BAR_READY_EVENT, null)
}

/** 迷你条上的「回到阅读」:主窗口回前台,焦点回来。 */
export async function desktopBarRevealMain(): Promise<void> {
  const main = getCurrentWindow()
  await main.show().catch(() => {})
  await main.unminimize().catch(() => {})
  await main.setFocus().catch(() => {})
}

/** 迷你条上的「收起」:这一次最小化不再打扰,直到主窗口回来。 */
export function desktopBarDismiss(): void {
  dismissed = true
  void (async () => {
    const current = bar
    if (current !== null) await current.hide().catch(() => {})
  })()
}

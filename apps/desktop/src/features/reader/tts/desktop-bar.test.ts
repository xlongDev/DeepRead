import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 桌面悬浮条的接线测试:去留判断、建窗时机、控制回路。
 *
 * 这里 mock 掉 Tauri 的窗口/事件 API —— 真实窗口建不建由单测断言不了,
 * 但「什么时候该建、建完给谁看、按钮按了往哪送」全是本模块的决策,
 * 值得钉死。真实置顶/透明由 tauri 自己保证(参照 ColorReader 的同一套参数)。
 */

const h = vi.hoisted(() => {
  const win = {
    show: vi.fn(async (): Promise<void> => {}),
    hide: vi.fn(async (): Promise<void> => {}),
    close: vi.fn(async (): Promise<void> => {}),
    isVisible: vi.fn(async (): Promise<boolean> => false),
    setPosition: vi.fn(async (): Promise<void> => {}),
    once: vi.fn(async (event: string, handler: () => void): Promise<() => void> => {
      if (event === 'tauri://created') setTimeout(handler, 0)
      return () => {}
    }),
  }
  const instances: { label: string; options: Record<string, unknown>; win: typeof win }[] = []
  class FakeWebviewWindow {
    readonly label: string
    readonly options: Record<string, unknown>
    constructor(label: string, options: Record<string, unknown>) {
      this.label = label
      this.options = options
      instances.push({ label, options, win })
    }
    show = win.show
    hide = win.hide
    close = win.close
    isVisible = win.isVisible
    setPosition = win.setPosition
    once = win.once
  }
  return { win, instances, FakeWebviewWindow }
})

vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: h.FakeWebviewWindow }))

const main = vi.hoisted(() => ({
  isVisible: vi.fn(async (): Promise<boolean> => false),
  isMinimized: vi.fn(async (): Promise<boolean> => false),
  show: vi.fn(async (): Promise<void> => {}),
  unminimize: vi.fn(async (): Promise<void> => {}),
  setFocus: vi.fn(async (): Promise<void> => {}),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => main,
  primaryMonitor: async () => ({ size: { width: 2560, height: 1440 }, scaleFactor: 2 }),
}))

const events = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  return {
    listeners,
    emit: vi.fn(async (event: string): Promise<void> => {
      void event
    }),
    emitTo: vi.fn(async (): Promise<void> => {}),
    listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    }),
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  emit: events.emit,
  emitTo: events.emitTo,
  listen: events.listen,
}))

vi.mock('../../../lib/ipc', () => ({ isTauriRuntime: (): boolean => true }))

const {
  BAR_CONTROL_EVENT,
  BAR_LABEL,
  BAR_STATE_EVENT,
  barBelongs,
  desktopBarDismiss,
  desktopBarPublish,
  desktopBarWatch,
  onDesktopBarControl,
} = await import('./desktop-bar')

/** 让 tick 里的 Promise 链跑完(所有 mock 都是立即 resolve)。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

beforeEach(() => {
  desktopBarWatch(false)
  h.instances.length = 0
  h.win.show.mockClear()
  h.win.hide.mockClear()
  h.win.close.mockClear()
  h.win.isVisible.mockClear()
  h.win.isVisible.mockImplementation(async () => false)
  h.win.setPosition.mockClear()
  main.isVisible.mockClear()
  main.isVisible.mockImplementation(async () => false)
  main.isMinimized.mockClear()
  main.isMinimized.mockImplementation(async () => false)
  main.show.mockClear()
  main.unminimize.mockClear()
  main.setFocus.mockClear()
  events.emit.mockClear()
  events.emitTo.mockClear()
})

afterEach(() => {
  desktopBarWatch(false)
})

describe('barBelongs', () => {
  it('主窗口在眼前时,什么都不该出现', () => {
    expect(barBelongs(true, false, true, false)).toBe(false)
  })

  it('最小化、被红钮收起、两者皆是 —— 都算「不在眼前」', () => {
    expect(barBelongs(true, false, true, true)).toBe(true)
    expect(barBelongs(true, false, false, false)).toBe(true)
    expect(barBelongs(true, false, false, true)).toBe(true)
  })

  it('没有语音时永远不出现', () => {
    expect(barBelongs(false, false, true, true)).toBe(false)
  })

  it('手动收起过就安静待着,直到主窗口回来', () => {
    expect(barBelongs(true, true, true, true)).toBe(false)
    expect(barBelongs(true, true, false, false)).toBe(false)
  })
})

describe('桌面悬浮条接线', () => {
  it('起播 + 主窗口最小化:建窗、置底居中、显示', async () => {
    main.isMinimized.mockImplementation(async () => true)
    desktopBarWatch(true)
    await flush()

    expect(h.instances).toHaveLength(1)
    const created = h.instances[0]
    if (created === undefined) throw new Error('迷你条窗口没有建起来')
    expect(created.label).toBe('tts-mini')
    // 桌面上的小胶囊:窗口本身什么都不是。
    expect(created.options).toMatchObject({
      decorations: false,
      shadow: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      visible: false,
    })
    // 2560×1440 @2x → 逻辑 1280×720,居中并抬离底边 72px。
    expect(h.win.setPosition).toHaveBeenCalledTimes(1)
    expect(h.win.show).toHaveBeenCalledTimes(1)
  })

  it('主窗口在眼前:不建窗', async () => {
    main.isVisible.mockImplementation(async () => true)
    desktopBarWatch(true)
    await flush()

    expect(h.instances).toHaveLength(0)
    expect(h.win.show).not.toHaveBeenCalled()
  })

  it('会话结束:关窗并释放(第二个 webview 不该白占内存)', async () => {
    main.isMinimized.mockImplementation(async () => true)
    desktopBarWatch(true)
    await flush()
    desktopBarWatch(false)
    await flush()

    expect(h.win.close).toHaveBeenCalledTimes(1)
    expect(h.win.hide).not.toHaveBeenCalled()
  })

  it('「收起」只是这一次不打扰:主窗口回来后还能再来', async () => {
    main.isMinimized.mockImplementation(async () => true)
    desktopBarWatch(true)
    await flush()
    h.win.isVisible.mockImplementation(async () => true)

    desktopBarDismiss()
    await flush()
    expect(h.win.hide).toHaveBeenCalledTimes(1)
    // 收起后窗口是隐藏的(下一次判断「该不该出现」要看到这一点)。
    h.win.isVisible.mockImplementation(async () => false)

    // 主窗口回前台:dismissed 清零,下一次最小化重新出现。
    main.isMinimized.mockImplementation(async () => false)
    main.isVisible.mockImplementation(async () => true)
    desktopBarWatch(true)
    await flush()
    main.isMinimized.mockImplementation(async () => true)
    main.isVisible.mockImplementation(async () => false)
    desktopBarWatch(true)
    await flush()
    expect(h.win.show.mock.calls.length).toBeGreaterThan(1)
  })

  it('没有会话时 publish 是空操作(别往一个不存在的窗口发状态)', async () => {
    desktopBarPublish({
      title: 't',
      chapter: null,
      coverUrl: null,
      playing: true,
      loading: false,
      progress: 0,
      remaining: '0:00',
      error: null,
      colorScheme: 'light',
    })
    await flush()
    expect(events.emitTo).not.toHaveBeenCalled()
  })

  it('有会话时 publish 广播状态;控制事件回到注册的 handler', async () => {
    main.isMinimized.mockImplementation(async () => true)
    const seen: string[] = []
    onDesktopBarControl(
      (action) => seen.push(action),
      () => {},
    )
    desktopBarWatch(true)
    await flush()

    desktopBarPublish({
      title: '长日将尽',
      chapter: '第三章',
      coverUrl: null,
      playing: true,
      loading: false,
      progress: 0.42,
      remaining: '12:48',
      error: null,
      colorScheme: 'light',
    })
    await flush()
    // 状态显式发给迷你条窗口(不靠广播语义)。
    expect(events.emitTo).toHaveBeenCalledWith(
      BAR_LABEL,
      BAR_STATE_EVENT,
      expect.objectContaining({ title: '长日将尽', progress: 0.42 }),
    )

    events.listeners.get(BAR_CONTROL_EVENT)?.({ payload: 'toggle' })
    events.listeners.get(BAR_CONTROL_EVENT)?.({ payload: 'reveal' })
    await flush()
    expect(seen).toEqual(['toggle', 'reveal'])
  })
})

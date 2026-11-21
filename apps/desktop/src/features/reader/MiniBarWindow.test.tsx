/**
 * 桌面悬浮条的拖拽把手守卫:
 * - 信息区(tts-mini-open)虽然是 button,但就是把手 —— 挪过 4px 交棒
 *   startDragging,这是「整条胶囊几乎全是按钮」时唯一够用的拖拽面;
 * - 控制键(播放/上一句/…)不是把手,按下绝不触发窗口拖动。
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TtsBarState } from './tts/desktop-bar'
import { MiniBarWindow } from './MiniBarWindow'
import { BAR_STATE_EVENT } from './tts/desktop-bar'

const startDragging = vi.fn(async (): Promise<void> => undefined)
let stateListener: ((event: { payload: TtsBarState }) => void) | null = null

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: TtsBarState }) => void) => {
    stateListener = handler
    return () => {
      stateListener = null
    }
  }),
}))

vi.mock('../../lib/ipc', () => ({
  isTauriRuntime: vi.fn((): boolean => true),
}))

vi.mock('./tts/desktop-bar', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tts/desktop-bar')>()
  return {
    ...real,
    desktopBarAskState: vi.fn(async (): Promise<void> => undefined),
    desktopBarSendControl: vi.fn(async (): Promise<void> => undefined),
  }
})

function runningState(): TtsBarState {
  return {
    title: '十一个时区之旅',
    chapter: '前言',
    coverUrl: null,
    playing: false,
    loading: false,
    progress: 0.2,
    remaining: '1:42',
    error: null,
    colorScheme: 'light',
  }
}

async function deliverState(state: TtsBarState): Promise<void> {
  // 手动注入状态要包 act:否则 React 19 推迟渲染,querySelector 落空。
  await act(async () => {
    stateListener!({ payload: state })
  })
}

beforeEach(() => {
  startDragging.mockClear()
  stateListener = null
})

describe('MiniBarWindow 拖拽把手', () => {
  it('按住信息区挪过 4px 交棒 startDragging', async () => {
    render(<MiniBarWindow />)
    await waitFor(() => expect(stateListener).not.toBeNull())
    await deliverState(runningState())

    const open = document.querySelector('.tts-mini-open')!
    fireEvent.pointerDown(open, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 112, clientY: 104 })
    await waitFor(() => expect(startDragging).toHaveBeenCalled())
  })

  it('按在控制键上不触发窗口拖动', async () => {
    render(<MiniBarWindow />)
    await waitFor(() => expect(stateListener).not.toBeNull())
    await deliverState(runningState())

    const play = document.querySelector('.tts-mini-play')!
    fireEvent.pointerDown(play, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 140, clientY: 140 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(startDragging).not.toHaveBeenCalled()
  })

  it('信息区按下没挪过 4px 不交棒(松手仍是「回到阅读」点击)', async () => {
    render(<MiniBarWindow />)
    await waitFor(() => expect(stateListener).not.toBeNull())
    await deliverState(runningState())

    const open = document.querySelector('.tts-mini-open')!
    fireEvent.pointerDown(open, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 101, clientY: 101 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(startDragging).not.toHaveBeenCalled()
  })
})

// 状态事件名被守卫测试依赖,常量改名会静默断流 —— 钉住。
expect(BAR_STATE_EVENT).toBe('tts://mini-state')

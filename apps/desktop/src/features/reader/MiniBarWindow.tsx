import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  BookOpenText,
  CaretDown,
  CaretLeft,
  CaretRight,
  Pause,
  Play,
  Warning,
  X,
} from '@phosphor-icons/react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '../../lib/ipc'
import {
  BAR_STATE_EVENT,
  desktopBarAskState,
  desktopBarSendControl,
  type TtsBarControl,
  type TtsBarState,
} from './tts/desktop-bar'

/** 按下去挪过这么多像素才算拖动;挪不到就是点击,点击归按钮。 */
const DRAG_SLOP = 4

/**
 * 桌面悬浮条(第二个 webview 的整个界面)。
 *
 * 它只画、只转发:状态从 `tts://mini-state` 来,控制从 `tts://mini-control`
 * 回 —— 没有 store、没有引擎、没有 IPC 调用,挂任何一样都会在这里起第二份
 * 播放器。视觉与应用内的胶囊(`.tts-mini`)同一套类,所以两条胶囊在任何
 * 阅读主题下都长一样。
 *
 * 窗口无边框,胶囊本身就是标题栏:按住非按钮处拖动 = 拖动窗口。拖动要挪过
 * 4px 才交棒(参照 ColorReader 的 `dragWindow`)—— 一按下去就 startDragging
 * 会把随后那次 click 一起吃掉,按钮于是「点了没反应」。
 */
export function MiniBarWindow() {
  const [state, setState] = useState<TtsBarState | null>(null)
  /** 控制发送失败(权限/IPC):不吞,胶囊上亮一盏小灯,用户知道没送到。 */
  const [sendError, setSendError] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // 浏览器(非 Tauri)下这个入口根本不该被加载;真被加载也别往一个
    // 不存在的 IPC 桥上发请求。
    if (!isTauriRuntime()) return
    // 窗口是「想要它的时候」才建的,第一条状态可能已经发过了 —— 主动要一份。
    void desktopBarAskState().catch(() => {})
    const unlisten = listen<TtsBarState>(BAR_STATE_EVENT, (event) => {
      setState(event.payload)
    })
    return () => {
      void unlisten.then((off) => off())
    }
  }, [])

  // 迷你条跟着 app 的阅读主题明暗走(深夜桌面不该顶一盏白灯)。
  const colorScheme = state?.colorScheme
  useEffect(() => {
    if (colorScheme === undefined) return
    document.documentElement.dataset.theme = colorScheme
  }, [colorScheme])

  useEffect(
    () => () => {
      if (errorTimer.current !== null) clearTimeout(errorTimer.current)
    },
    [],
  )

  // 会话结束:主窗口会收起这个窗口,这里不自己关(关不关是主窗口的判断)。
  if (state === null) {
    return <div className="tts-bar-boot" aria-hidden />
  }

  const send = (action: TtsBarControl): void => {
    void desktopBarSendControl(action)
      .then(() => {
        setSendError(null)
      })
      .catch((error: unknown) => {
        setSendError(error instanceof Error ? error.message : String(error))
        if (errorTimer.current !== null) clearTimeout(errorTimer.current)
        errorTimer.current = setTimeout(() => setSendError(null), 4000)
      })
  }

  /** 拖动窗口:按在按钮上不算,且要挪过 4px 才交棒。 */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button') !== null) return
    const from = { x: event.clientX, y: event.clientY }
    let dragging = false
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    const onMove = (moved: PointerEvent): void => {
      if (dragging) return
      if (Math.hypot(moved.clientX - from.x, moved.clientY - from.y) < DRAG_SLOP) return
      dragging = true
      cleanup()
      void getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
    const onUp = (): void => cleanup()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const clock = state.loading
    ? '合成中'
    : state.playing
      ? state.remaining
      : `已暂停 · ${state.remaining}`

  return (
    <div className="reader-scope tts-bar-host" onPointerDown={onPointerDown}>
      <section className="tts-mini" aria-label="朗读悬浮条">
        <button
          type="button"
          className="tts-mini-open"
          onClick={() => send('reveal')}
          title="回到阅读"
          aria-label="回到阅读"
        >
          {state.coverUrl ? (
            <img src={state.coverUrl} className="tts-mini-cover" alt="" />
          ) : (
            <span className="tts-mini-cover tts-cover-fallback" aria-hidden>
              {state.title.charAt(0)}
            </span>
          )}
          <span className="tts-mini-text">
            <span className="tts-mini-title">{state.title}</span>
            <span className="tts-mini-sub">
              {state.error !== null ? (
                <span className="tts-mini-error">{state.error}</span>
              ) : (
                <>
                  <span className="tts-mini-section">{state.chapter ?? '当前章节'}</span>
                  <span className="tts-mini-dot" aria-hidden>
                    ·
                  </span>
                  <span className="tts-mini-clock">剩余 {clock}</span>
                </>
              )}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="tts-mini-btn"
          onClick={() => send('prev')}
          title="上一句"
          aria-label="上一句"
        >
          <CaretLeft size={14} weight="bold" aria-hidden />
        </button>
        <button
          type="button"
          className="tts-mini-btn tts-mini-play"
          onClick={() => send('toggle')}
          title={state.playing ? '暂停' : '继续'}
          aria-label={state.playing ? '暂停' : '播放'}
        >
          {state.playing ? (
            <Pause size={15} weight="fill" aria-hidden />
          ) : (
            <Play size={15} weight="fill" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="tts-mini-btn"
          onClick={() => send('next')}
          title="下一句"
          aria-label="下一句"
        >
          <CaretRight size={14} weight="bold" aria-hidden />
        </button>
        <span className="tts-mini-divider" aria-hidden />
        <button
          type="button"
          className="tts-mini-btn"
          onClick={() => send('reveal')}
          title="回到阅读"
          aria-label="回到阅读"
        >
          <BookOpenText size={14} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          className="tts-mini-btn"
          onClick={() => send('dismiss')}
          title="收起悬浮条"
          aria-label="收起悬浮条"
        >
          <CaretDown size={14} weight="bold" aria-hidden />
        </button>
        <button
          type="button"
          className="tts-mini-btn"
          onClick={() => send('stop')}
          title="停止并关闭"
          aria-label="停止并关闭"
        >
          <X size={13} weight="regular" aria-hidden />
        </button>
        {sendError !== null && (
          <output className="tts-mini-alert" title={sendError}>
            <Warning size={12} weight="fill" aria-hidden />
          </output>
        )}
        {state.progress > 0 && state.progress < 1 && (
          <span className="tts-mini-rail" aria-hidden>
            <span
              className="tts-mini-rail-fill"
              style={{ transform: `scaleX(${state.progress})` }}
            />
          </span>
        )}
      </section>
    </div>
  )
}

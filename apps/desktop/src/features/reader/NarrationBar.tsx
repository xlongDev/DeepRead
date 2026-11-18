/**
 * 原书配音播放条(EPUB3 media overlays):本书自带音频时,听书交给内核的
 * MediaOverlay —— 播放、跟播跳页、激活高亮都是内核的事,这里只有播控。
 *
 * 刻意独立于 TtsDrawer:两条音频管线的时间轴/歌词页/进度模型完全不同(配音
 * 没有"句文本",只有 SMIL 段),硬塞进抽屉是把两套状态机焊在一起。入口在
 * 听书抽屉的横幅(见 TtsDrawer),互相礼让由宿主(ReaderScreen)裁决。
 */

import { Pause, Play, SkipBack, SkipForward, SpeakerHigh, X } from '@phosphor-icons/react'

export type NarrationPhase = 'playing' | 'paused'

/** 语速档(原生 playbackRate,不走 TTS 的播音侧拉伸)。 */
export const NARRATION_RATES = [1, 1.25, 1.5, 2] as const

export interface NarrationBarProps {
  readonly phase: NarrationPhase
  readonly rate: number
  readonly onToggle: () => void
  readonly onPrev: () => void
  readonly onNext: () => void
  /** 循环切下一档语速。 */
  readonly onRate: () => void
  readonly onStop: () => void
}

export function NarrationBar({
  phase,
  rate,
  onToggle,
  onPrev,
  onNext,
  onRate,
  onStop,
}: NarrationBarProps) {
  return (
    <div className="narration-bar" role="toolbar" aria-label="原书配音播放条">
      <span className="narration-badge" aria-hidden>
        <SpeakerHigh size={14} weight="fill" />
        原声
      </span>
      <button
        type="button"
        className="chrome-button"
        onClick={onPrev}
        title="上一句"
        aria-label="上一句"
      >
        <SkipBack size={14} weight="regular" aria-hidden />
      </button>
      <button
        type="button"
        className="chrome-button"
        onClick={onToggle}
        title={phase === 'playing' ? '暂停' : '继续'}
        aria-label={phase === 'playing' ? '暂停' : '继续'}
      >
        {phase === 'playing' ? (
          <Pause size={16} weight="fill" aria-hidden />
        ) : (
          <Play size={16} weight="fill" aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="chrome-button"
        onClick={onNext}
        title="下一句"
        aria-label="下一句"
      >
        <SkipForward size={14} weight="regular" aria-hidden />
      </button>
      <button
        type="button"
        className="chrome-button narration-rate"
        onClick={onRate}
        title="语速(点击切下一档)"
        aria-label={`语速 ${rate} 倍,点击切下一档`}
      >
        {rate}×
      </button>
      <button
        type="button"
        className="chrome-button"
        onClick={onStop}
        title="停止原声朗读"
        aria-label="停止原声朗读"
      >
        <X size={14} weight="regular" aria-hidden />
      </button>
    </div>
  )
}

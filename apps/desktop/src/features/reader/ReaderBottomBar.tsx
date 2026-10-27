/**
 * 底栏:进度滑杆 + 页码/字数/预计时间。从 ReaderScreen 下沉的进度消费者
 * —— 进度经 progress-store 订阅(useSyncExternalStore),relocate 高频
 * 写入只重渲染这一个 memo 化的叶件,不再拖动整棵阅读器树。
 */

import { memo, useMemo } from 'react'
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react'
import { buildReadingStats } from './reading-indicators'
import type { BookCharStats } from '@deepread/reader-core'
import { type StatsSettings } from './reader-options'
import { useProgressSnapshot, type ProgressStore } from './progress-store'

interface ReaderBottomBarProps {
  readonly progressStore: ProgressStore
  readonly statsSettings: StatsSettings
  readonly bookLanguage: string | undefined
  readonly sectionChars: number | null
  readonly bookCharStats: BookCharStats | null
  /** 拖动滑杆:只移滑块,不跳转(跳转在松手/失焦的 onScrubCommit)。 */
  readonly onScrubFraction: (fraction: number) => void
  /** 拖动开始(pointer 按下 / 键盘步进):宿主记「正在拖」,松手才 goTo。 */
  readonly onScrubStart: () => void
  readonly onScrubCommit: () => void
  /** 字数口径切换(本章 ↔ 全书):落库与状态都在宿主。 */
  readonly onWordsScopeChange: (next: StatsSettings) => void
}

export const ReaderBottomBar = memo(function ReaderBottomBar({
  progressStore,
  statsSettings,
  bookLanguage,
  sectionChars,
  bookCharStats,
  onScrubFraction,
  onScrubStart,
  onScrubCommit,
  onWordsScopeChange,
}: ReaderBottomBarProps) {
  const snapshot = useProgressSnapshot(progressStore)
  const readingStats = useMemo(
    () =>
      buildReadingStats({
        location: snapshot.location,
        fraction: snapshot.fraction,
        bookLanguage,
        sectionChars,
        bookCharStats,
        wordsScope: statsSettings.wordsScope,
      }),
    [
      snapshot.location,
      snapshot.fraction,
      bookLanguage,
      sectionChars,
      bookCharStats,
      statsSettings.wordsScope,
    ],
  )

  return (
    <footer className="reader-bottom">
      <input
        type="range"
        className="reader-slider"
        min={0}
        max={1000}
        value={Math.round(snapshot.fraction * 1000)}
        aria-label="阅读进度"
        onChange={(event) => {
          // Scrubbing only moves the thumb: a goTo per input event relayouts
          // the whole book. The jump happens once, on release.
          onScrubFraction(Number(event.target.value) / 1000)
        }}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubCommit}
        onKeyDown={onScrubStart}
        onKeyUp={onScrubCommit}
        onBlur={onScrubCommit}
      />
      <span className="reader-arrow" aria-hidden>
        <ArrowLeft size={14} weight="regular" />
      </span>
      <span className="reader-arrow" aria-hidden>
        <ArrowRight size={14} weight="regular" />
      </span>
      {statsSettings.words && readingStats.chars && (
        <button
          type="button"
          className="reader-count-toggle"
          title={`当前显示${statsSettings.wordsScope === 'book' ? '全书' : '本章'}字数,点按切换`}
          onClick={() => {
            onWordsScopeChange({
              ...statsSettings,
              wordsScope:
                statsSettings.wordsScope === 'book' ? ('section' as const) : ('book' as const),
            })
          }}
        >
          {readingStats.chars}
        </button>
      )}
      {statsSettings.time && readingStats.time && (
        <span className="reader-percent">{readingStats.time}</span>
      )}
      {statsSettings.progress && readingStats.page && (
        <span className="reader-percent reader-percent-strong">{readingStats.page}</span>
      )}
    </footer>
  )
})

/**
 * 底栏:进度滑杆 + 页码/字数/预计时间。从 ReaderScreen 下沉的进度消费者
 * —— 进度经 progress-store 订阅(useSyncExternalStore),relocate 高频
 * 写入只重渲染这一个 memo 化的叶件,不再拖动整棵阅读器树。
 *
 * 分两组,和顶栏同一套语言:滑杆与它的读数(页码)是一件事,字数/剩余时间
 * 是另一件事,中间一条发丝线。原先的 ← → 是初版留下的装饰性 span
 * (aria-hidden、无 onClick),读者会当成翻页键去点,所以删掉 —— 翻页靠
 * 两侧的 page-flip 热区与方向键。
 */

import { memo, useMemo } from 'react'
import type { CSSProperties } from 'react'
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

  /** 三块读数各有开关(设置里勾),关掉的那块不占位。 */
  const showPage = statsSettings.progress && readingStats.page !== null
  const showWords = statsSettings.words && readingStats.chars !== null
  const showTime = statsSettings.time && readingStats.time !== null

  return (
    <footer className="reader-bottom">
      <input
        type="range"
        className="reader-slider"
        min={0}
        max={1000}
        value={Math.round(snapshot.fraction * 1000)}
        aria-label="阅读进度"
        /* 轨道要用「已读」实心到拇指:range 的 value 只有 CSS 读不到,
           所以把比例作为自定义属性递给 ::-webkit-slider-runnable-track。 */
        style={{ '--fill': `${(snapshot.fraction * 100).toFixed(2)}%` } as CSSProperties}
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
      {showPage && <span className="reader-stat is-strong">{readingStats.page}</span>}
      {showWords || showTime ? (
        <div className="reader-stats">
          {showWords && (
            <button
              type="button"
              className="reader-stat is-toggle"
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
          {showTime && <span className="reader-stat">{readingStats.time}</span>}
        </div>
      ) : null}
    </footer>
  )
})

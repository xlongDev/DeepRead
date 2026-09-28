/**
 * 统计视图(W1):内容与原来的统计弹窗一一对应,只是从「打断式弹窗」搬进
 * 「可以待着看的页面」。数字、图表、类名都没动,搬的是容器。
 */

import { readingStreak, type DayStat } from '@deepread/shared'
import type { ReadingStats } from '../../lib/reading-stats'
import { formatStatDuration } from './shelf-view'

export interface StatsViewProps {
  readonly stats: ReadingStats | null
  readonly todaySeconds: number
  readonly series: readonly (DayStat & { readonly label: string })[]
  /** 柱高归一用的峰值;全零时有地板值,不会除零。 */
  readonly peak: number
}

export function StatsView({ stats, todaySeconds, series, peak }: StatsViewProps) {
  return (
    <section className="stats-page" aria-label="阅读统计">
      <h1 className="shelf-title">阅读统计</h1>
      {stats === null ? (
        <p className="library-note">统计加载中…</p>
      ) : (
        <>
          <div className="stats-summary">
            <div className="stats-tile">
              <span className="stats-tile-value">{formatStatDuration(todaySeconds)}</span>
              <span className="stats-tile-label">今日</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{readingStreak(stats.days)}</span>
              <span className="stats-tile-label">连续天数</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatStatDuration(stats.totalSeconds)}</span>
              <span className="stats-tile-label">累计</span>
            </div>
          </div>

          <section className="modal-section">
            <p className="modal-section-label">最近 7 天</p>
            <div className="stats-chart">
              {series.map((entry, index) => (
                <div
                  key={entry.day}
                  className="stats-bar"
                  title={`${entry.day} · ${formatStatDuration(entry.seconds)}`}
                >
                  <span className="stats-bar-track">
                    <span
                      className="stats-bar-fill"
                      style={{
                        height: `${Math.round((entry.seconds / peak) * 100)}%`,
                        // 从周一到周日依次长起来:一排同时弹满的柱子读不出先后。
                        animationDelay: `${index * 40}ms`,
                      }}
                    />
                  </span>
                  <span className="stats-bar-label">{entry.label}</span>
                </div>
              ))}
            </div>
            <p className="library-note">
              只统计前台真正在读书的时间;累计 {formatStatDuration(stats.totalSeconds)}。
            </p>
          </section>
        </>
      )}
    </section>
  )
}

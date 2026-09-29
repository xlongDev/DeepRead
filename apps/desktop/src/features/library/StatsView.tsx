/**
 * 统计视图:本周/连续/读完/日均四块指标 + 最近 7 天柱状图 + 读得最久的书。
 *
 * 「本周读完」没有落库 —— 书里没有「读完时间」这个字段,拿 progress >= 1 现数
 * 的就是已读完的本数,这跟用户看到的书架一致。想做真正的周维度,得先有完成
 * 时间,那又是一条新数据。
 */

import { type BookReadingStat, readingStreak, type DayStat } from '@deepread/shared'
import type { ReadingStats } from '../../lib/reading-stats'
import { formatStatDuration, shelfTitle } from './shelf-view'

export interface StatsViewProps {
  readonly stats: ReadingStats | null
  readonly series: readonly (DayStat & { readonly label: string })[]
  /** 柱高归一用的峰值;全零时有地板值,不会除零。 */
  readonly peak: number
  /** 已读完的本数(progress >= 1)。 */
  readonly finishedCount: number
  readonly topBooks: readonly BookReadingStat[]
  readonly onOpenBook: (bookHash: string) => void
}

export function StatsView({
  stats,
  series,
  peak,
  finishedCount,
  topBooks,
  onOpenBook,
}: StatsViewProps) {
  const weekSeconds = series.reduce((sum, entry) => sum + entry.seconds, 0)
  const perDay = Math.round(weekSeconds / Math.max(series.length, 1))
  const topPeak = Math.max(...topBooks.map((entry) => entry.seconds), 1)
  const ranked = topBooks.slice(0, 5)

  return (
    <section className="stats-page" aria-label="阅读统计">
      <h1 className="shelf-title">阅读统计</h1>
      {stats === null ? (
        <p className="library-note">统计加载中…</p>
      ) : (
        <>
          <div className="stats-summary">
            <div className="stats-tile">
              <span className="stats-tile-value">{formatStatDuration(weekSeconds)}</span>
              <span className="stats-tile-label">本周阅读</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{readingStreak(stats.days)}</span>
              <span className="stats-tile-label">连续天数</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{finishedCount}</span>
              <span className="stats-tile-label">已读完</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatStatDuration(perDay)}</span>
              <span className="stats-tile-label">平均每日</span>
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

          <section className="modal-section">
            <p className="modal-section-label">读得最久的书</p>
            {ranked.length === 0 ? (
              <p className="library-note">还没有记录 —— 读一会儿之后这里会排出来。</p>
            ) : (
              <ol className="stats-rank">
                {ranked.map((entry, index) => (
                  <li key={entry.bookHash} className="stats-rank-row">
                    <button
                      type="button"
                      className="stats-rank-open"
                      onClick={() => onOpenBook(entry.bookHash)}
                    >
                      <span className="stats-rank-index">{index + 1}</span>
                      <span className="stats-rank-name" title={shelfTitle(entry)}>
                        {shelfTitle(entry)}
                      </span>
                      <span className="stats-rank-bar" aria-hidden>
                        <span
                          className="stats-rank-fill"
                          style={{
                            width: `${Math.round((entry.seconds / topPeak) * 100)}%`,
                            animationDelay: `${index * 40}ms`,
                          }}
                        />
                      </span>
                      <span className="stats-rank-time">{formatStatDuration(entry.seconds)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  )
}

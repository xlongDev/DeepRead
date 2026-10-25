/**
 * 统计视图:今日目标 hero + 我的目标(每周天数 / 年度本数)+ 最近 7 天柱状图
 * (带目标线)+ 年度阅读热力图 + 累计指标 + 读得最久的书。
 *
 * **阅读目标住在这里,不住设置弹窗** —— 目标与它的进度是同一件事,分居两处
 * 只会让人"定了目标却看不见进度"。设置弹窗只保留外观 / AI / 备份与更新。
 *
 * 数据口径:
 * - 「今年读完」按 `books.finished_at` 数(进度第一次到 100% 时后端盖章,
 *   见 state.rs `store_state`);没有完成时间的老书不计入 —— 宁少报,不猜。
 * - 「本周达标」= 最近 7 天里读够每日目标的天数;「读过了」= 当天至少
 *   STREAK_MIN_SECONDS(2 分钟),与连续天数同一把尺。
 * - 没有每日目标时不画完成度环:一个 0% 的环会把「没定目标」演成
 *   「今天完全没读」,那是说谎。
 */

import { useState } from 'react'
import { Books, CalendarCheck } from '@phosphor-icons/react'
import {
  daysWithReading,
  goalDays,
  goalRatio,
  goalReached,
  heatLevel,
  readingStreak,
  yearHeatmap,
  type BookReadingStat,
  type DayStat,
  type ReadingGoals,
} from '@deepread/shared'
import type { ReadingStats } from '../../lib/reading-stats'
import { formatStatDuration, shelfTitle } from './shelf-view'

/** 目标环半径 52 的周长:stroke-dasharray 按它算百分比。 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 52

/** 常用预设:点一下就存,不用调步进器。 */
const DAILY_PRESETS = [15, 30, 45, 60, 90, 120] as const
const WEEKLY_PRESETS = [3, 4, 5, 6, 7] as const
const YEARLY_PRESETS = [6, 12, 24, 36, 52] as const

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

export interface StatsViewProps {
  readonly stats: ReadingStats | null
  readonly series: readonly (DayStat & { readonly label: string })[]
  /** 今年(本地年历年),由调用方按「今日」的口径给 —— 渲染里不新开时钟。 */
  readonly year: number
  /** 已读完的本数(progress >= 1)。 */
  readonly finishedCount: number
  /** 今年(本地年)读完的本数 —— 按完成时间数,不是按进度现数。 */
  readonly finishedThisYear: number
  readonly goals: ReadingGoals
  /** 存一项(或多项)目标;返回前保持 busy,busy 期间所有编辑器不可点。 */
  readonly onSaveGoals: (patch: Partial<ReadingGoals>) => void
  readonly goalsBusy: boolean
  readonly topBooks: readonly BookReadingStat[]
  readonly onOpenBook: (bookHash: string) => void
}

/* ---------- 目标行内编辑器 ----------
一个目标一个编辑器:预设芯片(点了就存)+ 自定义输入 + 清除。就地展开,
不弹窗 —— 改个目标不该打断看统计。 */

interface GoalEditorProps {
  readonly value: number
  readonly presets: readonly number[]
  readonly max: number
  readonly unit: string
  readonly label: string
  readonly busy: boolean
  readonly onSave: (value: number) => void
}

function GoalEditor({ value, presets, max, unit, label, busy, onSave }: GoalEditorProps) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)

  const commit = (text: string): void => {
    const trimmed = text.trim()
    const minutes = trimmed === '' ? 0 : Number(trimmed)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > max) {
      setError(`请输入 0 到 ${max} 之间的整数(0 = 不设目标)。`)
      return
    }
    setError(null)
    onSave(minutes)
  }

  return (
    <div className="goal-editor">
      <div className="goal-editor-chips">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`goal-chip${preset === value ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => onSave(preset)}
          >
            {preset}
            {unit}
          </button>
        ))}
      </div>
      <form
        className="goal-editor-custom"
        onSubmit={(event) => {
          // 表单只承载「输入框里按 Enter」:浏览器原生隐式提交走这里。
          // 确定按钮是 type="button" —— jsdom 不实现点击 submit 触发提交,
          // 而且按钮显式调用比依赖隐式行为少一层魔法。
          event.preventDefault()
          commit(draft)
        }}
      >
        <input
          type="number"
          min={0}
          max={max}
          step={1}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={label}
        />
        <span className="goal-editor-unit">{unit}</span>
        <button type="button" className="btn" disabled={busy} onClick={() => commit(draft)}>
          确定
        </button>
        {value > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setError(null)
              onSave(0)
            }}
          >
            清除
          </button>
        )}
      </form>
      {error !== null && (
        <p className="library-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/* ---------- 统计页 ---------- */

export function StatsView({
  stats,
  series,
  year,
  finishedCount,
  finishedThisYear,
  goals,
  onSaveGoals,
  goalsBusy,
  topBooks,
  onOpenBook,
}: StatsViewProps) {
  /** 行内编辑器只开一个:同时展开三个只会互相抢注意力。 */
  const [editing, setEditing] = useState<'daily' | 'weekly' | 'yearly' | null>(null)

  const weekSeconds = series.reduce((sum, entry) => sum + entry.seconds, 0)
  const perDay = Math.round(weekSeconds / Math.max(series.length, 1))
  const topPeak = Math.max(...topBooks.map((entry) => entry.seconds), 1)
  const ranked = topBooks.slice(0, 5)
  // 今日 = 序列最后一项(dailySeries 以今天收尾)。目标环与侧栏摘要同一口径。
  const todaySeconds = series[series.length - 1]?.seconds ?? 0
  const ratio = goalRatio(todaySeconds, goals.dailyMinutes)
  const reachedDays = goalDays(stats?.days ?? [], goals.dailyMinutes, 7)
  const streak = readingStreak(stats?.days ?? [])
  const readDays = daysWithReading(stats?.days ?? [], 7)

  const heat = yearHeatmap(stats?.days ?? [])
  // 热力图色尺:有每日目标就按目标(格子点亮 = 当天达标,与柱状图同一把尺),
  // 没有就按年度峰值。
  const heatReference =
    goals.dailyMinutes > 0
      ? goals.dailyMinutes * 60
      : Math.max(...heat.flat().map((c) => c.seconds))
  const weeklyReached = goals.weeklyDays > 0 && readDays >= goals.weeklyDays
  const yearlyReached = goals.yearlyBooks > 0 && finishedThisYear >= goals.yearlyBooks

  // 目标线要一直在画布内:峰值把目标秒数也算进去。
  const goalSeconds = goals.dailyMinutes * 60
  const chartPeak = Math.max(60, ...series.map((entry) => entry.seconds), goalSeconds)

  return (
    <section className="stats-page" aria-label="阅读统计">
      <header className="stats-head">
        <h1 className="shelf-title">阅读统计</h1>
        {stats !== null && (
          <p className="stats-head-sub">
            累计 {formatStatDuration(stats.totalSeconds)} · {stats.days.length} 天有记录
          </p>
        )}
      </header>

      {stats === null ? (
        <p className="library-note">统计加载中…</p>
      ) : (
        <>
          {/* ---- 目标总览:今日 / 每周 / 年度,一张卡三层 ----
              目标与它的进度是同一件事,分居三张卡只会层层嵌套;一张卡内
              用 hairline 分层:今日是焦点(环 + 数字),每周与年度是次级行
              (一行搞定,不再大卡包小卡)。 */}
          <section className="stats-overview" aria-label="目标总览">
            <div className="stats-overview-today">
              <div className="stats-hero-ring">
                {ratio === null ? (
                  <div className="stats-hero-empty">
                    <span className="stats-hero-empty-value">
                      {formatStatDuration(todaySeconds)}
                    </span>
                    <span className="stats-hero-empty-label">今日已读</span>
                  </div>
                ) : (
                  <div className="stats-goal-ring-wrap">
                    {/* 环本身是装饰:百分比与右侧「今日 / 目标」文字已经表意,
                        读屏不需要再念一遍 SVG(role="img" 会被 lint 拦)。 */}
                    <svg className="stats-goal-ring" viewBox="0 0 120 120" aria-hidden>
                      <circle className="stats-goal-track" cx="60" cy="60" r="52" />
                      <circle
                        className="stats-goal-fill"
                        cx="60"
                        cy="60"
                        r="52"
                        strokeDasharray={`${(Math.min(ratio, 1) * RING_CIRCUMFERENCE).toFixed(
                          1,
                        )} ${RING_CIRCUMFERENCE.toFixed(1)}`}
                        transform="rotate(-90 60 60)"
                      />
                    </svg>
                    <span className="stats-goal-percent">{Math.round(ratio * 100)}%</span>
                  </div>
                )}
              </div>
              <div className="stats-hero-side">
                <p className="stats-hero-line">
                  {ratio === null ? (
                    '还没设每日目标'
                  ) : (
                    <>
                      今日 {formatStatDuration(todaySeconds)} / 目标{' '}
                      {formatStatDuration(goals.dailyMinutes * 60)}
                      {goalReached(todaySeconds, goals.dailyMinutes) ? ' · 已达成' : ''}
                    </>
                  )}
                </p>
                <p className="library-note">
                  连续 {streak} 天 · 本周达标 {reachedDays} / 7 天
                </p>
                <button
                  type="button"
                  className={ratio === null ? 'btn-primary' : 'btn'}
                  onClick={() => setEditing(editing === 'daily' ? null : 'daily')}
                  aria-expanded={editing === 'daily'}
                >
                  {ratio === null ? '设定每日目标' : '调整目标'}
                </button>
                {editing === 'daily' && (
                  <GoalEditor
                    value={goals.dailyMinutes}
                    presets={DAILY_PRESETS}
                    max={1440}
                    unit="分"
                    label="每日阅读目标(分钟)"
                    busy={goalsBusy}
                    onSave={(value) => onSaveGoals({ dailyMinutes: value })}
                  />
                )}
              </div>
            </div>

            {/* 每周:一行 —— 名称、最近 7 天圆点、进度值、状态、动作。 */}
            <div className="stats-overview-row">
              <span className="stats-overview-name">
                <CalendarCheck size={15} weight="regular" aria-hidden />
                每周阅读
              </span>
              <span className="stats-overview-viz">
                {/* 最近 7 天,一天一格:读过的日子点亮,顺序从旧到新。 */}
                <span className="goal-week-dots">
                  {series.map((entry) => {
                    const read = entry.seconds >= 120
                    // 星期几从日期串本地解析:`new Date('YYYY-MM-DD')` 是 UTC 午夜,
                    // 负时区会退到前一天,周几就错位。解构给默认值防越界。
                    const [cellYear = 0, cellMonth = 1, cellDay = 1] = entry.day
                      .split('-')
                      .map(Number)
                    const weekday =
                      WEEKDAY_LABELS[
                        (new Date(cellYear, cellMonth - 1, cellDay).getDay() + 6) % 7
                      ] ?? ''
                    return (
                      <span
                        key={entry.day}
                        className={`goal-week-dot${read ? ' is-read' : ''}`}
                        title={`${entry.day} · ${formatStatDuration(entry.seconds)}${
                          read ? ' · 读过了' : ''
                        }`}
                      >
                        {weekday}
                      </span>
                    )
                  })}
                </span>
              </span>
              <span className="stats-overview-value">{readDays} / 7 天</span>
              <span className="stats-overview-note">
                {goals.weeklyDays === 0
                  ? '还没设每周目标'
                  : weeklyReached
                    ? `本周目标已达成(目标 ${goals.weeklyDays} 天)`
                    : `目标 ${goals.weeklyDays} 天 · 还差 ${goals.weeklyDays - readDays} 天`}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => setEditing(editing === 'weekly' ? null : 'weekly')}
                aria-expanded={editing === 'weekly'}
                aria-label={goals.weeklyDays === 0 ? '设定每周目标' : '调整每周目标'}
              >
                {goals.weeklyDays === 0 ? '设定' : '调整'}
              </button>
              {editing === 'weekly' && (
                <GoalEditor
                  value={goals.weeklyDays}
                  presets={WEEKLY_PRESETS}
                  max={7}
                  unit="天"
                  label="每周阅读天数目标"
                  busy={goalsBusy}
                  onSave={(value) => onSaveGoals({ weeklyDays: value })}
                />
              )}
            </div>

            {/* 年度:一行 —— 有目标才有进度条,没目标是引导文案(不画假进度)。 */}
            <div className="stats-overview-row">
              <span className="stats-overview-name">
                <Books size={15} weight="regular" aria-hidden />
                年度读完
              </span>
              {goals.yearlyBooks > 0 ? (
                <>
                  <span className="stats-overview-viz">
                    {/* 进度条是可视化:数值与「还剩几本」的文字已经表意,读屏不
                        再念一遍(role=progressbar 会被 lint 拦,原生 progress
                        的跨浏览器样式又是另一场战争)。 */}
                    <span className="goal-year-bar" aria-hidden>
                      <span
                        className="goal-year-fill"
                        style={{
                          width: `${Math.min(100, Math.round((finishedThisYear / goals.yearlyBooks) * 100))}%`,
                        }}
                      />
                    </span>
                  </span>
                  <span className="stats-overview-value">
                    {finishedThisYear} / {goals.yearlyBooks} 本
                  </span>
                  <span className="stats-overview-note">
                    {yearlyReached
                      ? `${year} 年目标已达成`
                      : `还剩 ${goals.yearlyBooks - finishedThisYear} 本`}
                  </span>
                </>
              ) : (
                <span className="stats-overview-note">
                  今年已读完 {finishedThisYear} 本,还没定年度目标
                </span>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => setEditing(editing === 'yearly' ? null : 'yearly')}
                aria-expanded={editing === 'yearly'}
                aria-label={goals.yearlyBooks === 0 ? '设定年度目标' : '调整年度目标'}
              >
                {goals.yearlyBooks === 0 ? '设定' : '调整'}
              </button>
              {editing === 'yearly' && (
                <GoalEditor
                  value={goals.yearlyBooks}
                  presets={YEARLY_PRESETS}
                  max={366}
                  unit="本"
                  label="年度读完本数目标"
                  busy={goalsBusy}
                  onSave={(value) => onSaveGoals({ yearlyBooks: value })}
                />
              )}
            </div>
          </section>

          {/* ---- 最近 7 天 ---- */}
          <section className="modal-section">
            <p className="modal-section-label">最近 7 天</p>
            <div className="stats-chart">
              {/* 绘图区与标签行分开:目标线按绘图区高度定位,才和柱高同一把尺。 */}
              <div className="stats-chart-plot">
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
                          height: `${Math.round((entry.seconds / chartPeak) * 100)}%`,
                          // 从周到日依次长起来:一排同时弹满的柱子读不出先后。
                          animationDelay: `${index * 40}ms`,
                        }}
                      />
                    </span>
                  </div>
                ))}
                {/* 目标线:虚线横在每日目标的高度上 —— 柱头越过它就是达标,
                    比每根柱子顶一个点更读得出"比目标高还是低"。 */}
                {goalSeconds > 0 && (
                  <span
                    className="stats-chart-goal"
                    style={{ bottom: `${Math.round((goalSeconds / chartPeak) * 100)}%` }}
                    title={`每日目标 ${formatStatDuration(goalSeconds)}`}
                    aria-hidden
                  />
                )}
              </div>
              <div className="stats-chart-labels" aria-hidden>
                {series.map((entry) => (
                  <span key={entry.day} className="stats-bar-label">
                    {entry.label}
                  </span>
                ))}
              </div>
            </div>
            <p className="library-note">
              只统计前台真正在读书的时间;累计 {formatStatDuration(stats.totalSeconds)}。
            </p>
          </section>

          {/* ---- 年度热力图 ---- */}
          <section className="modal-section" aria-label="年度阅读热力图">
            <p className="modal-section-label">{year} 年</p>
            <div className="stats-heatmap-scroll">
              <div className="stats-heatmap">
                <div className="stats-heatmap-months" aria-hidden>
                  {heat.map((column, index) => {
                    const firstInYear = column.find((cell) => cell.inYear)
                    if (firstInYear === undefined) return <span key={`pad-${index}`} />
                    const month = Number(firstInYear.day.slice(5, 7))
                    const previous =
                      index > 0 ? heat[index - 1]?.find((cell) => cell.inYear) : undefined
                    const previousMonth =
                      previous === undefined ? 0 : Number(previous.day.slice(5, 7))
                    return (
                      <span key={firstInYear.day}>
                        {month !== previousMonth ? `${month} 月` : ''}
                      </span>
                    )
                  })}
                </div>
                <div className="stats-heatmap-grid">
                  {heat.map((column) =>
                    column.map((cell) => {
                      const level =
                        cell.future || !cell.inYear ? 0 : heatLevel(cell.seconds, heatReference)
                      return (
                        <span
                          key={cell.day}
                          className={`stats-heat-cell level-${level}${
                            cell.future ? ' is-future' : ''
                          }${cell.inYear ? '' : ' is-pad'}`}
                          title={
                            cell.inYear && !cell.future
                              ? `${cell.day} · ${
                                  cell.seconds > 0 ? formatStatDuration(cell.seconds) : '没读'
                                }`
                              : undefined
                          }
                        />
                      )
                    }),
                  )}
                </div>
              </div>
            </div>
            <div className="stats-heatmap-legend">
              <span className="library-note">少</span>
              <span className="stats-heat-cell level-0" aria-hidden />
              <span className="stats-heat-cell level-1" aria-hidden />
              <span className="stats-heat-cell level-2" aria-hidden />
              <span className="stats-heat-cell level-3" aria-hidden />
              <span className="stats-heat-cell level-4" aria-hidden />
              <span className="library-note">多</span>
            </div>
          </section>

          {/* ---- 累计指标 ---- */}
          <div className="stats-summary">
            <div className="stats-tile">
              <span className="stats-tile-value">{formatStatDuration(stats.totalSeconds)}</span>
              <span className="stats-tile-label">累计时长</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{streak}</span>
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

          {/* ---- 读得最久的书 ---- */}
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

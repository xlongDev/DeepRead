import { describe, expect, it } from 'vitest'
import {
  STREAK_MIN_SECONDS,
  booksFinishedInYear,
  dailySeries,
  daysWithReading,
  goalDays,
  goalRatio,
  goalReached,
  heatLevel,
  localDayKey,
  readingStreak,
  recentDayKeys,
  yearHeatmap,
} from './stats'

const today = new Date(2026, 8, 28, 22, 0, 0) // 2026-09-28 local

describe('day keys', () => {
  it('formats the local calendar day', () => {
    expect(localDayKey(today)).toBe('2026-09-28')
    expect(recentDayKeys(3, today)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28'])
  })

  it('crosses month boundaries', () => {
    expect(recentDayKeys(2, new Date(2026, 9, 1))).toEqual(['2026-09-30', '2026-10-01'])
  })
})

describe('readingStreak', () => {
  const day = (offset: number, seconds: number) => {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    return { day: localDayKey(date), seconds }
  }

  it('counts back from today', () => {
    const days = [day(0, 600), day(1, 600), day(2, 300)]
    expect(readingStreak(days, today)).toBe(3)
  })

  it('keeps yesterday’s streak before today has been read', () => {
    expect(readingStreak([day(1, 600), day(2, 600)], today)).toBe(2)
  })

  it('breaks on a missed day', () => {
    expect(readingStreak([day(0, 600), day(2, 600)], today)).toBe(1)
    expect(readingStreak([day(2, 600)], today)).toBe(0)
  })

  it('ignores days below the floor', () => {
    expect(readingStreak([day(0, STREAK_MIN_SECONDS - 1)], today)).toBe(0)
  })
})

describe('dailySeries', () => {
  it('fills gaps with zeros, oldest first', () => {
    const series = dailySeries([{ day: '2026-09-26', seconds: 300 }], 3, today)
    expect(series.map((entry) => entry.seconds)).toEqual([300, 0, 0])
    expect(series.map((entry) => entry.day)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28'])
  })
})

describe('reading goal', () => {
  const day = (offset: number, seconds: number) => {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    return { day: localDayKey(date), seconds }
  }

  it('goalRatio is null without a goal — no fake 0% ring', () => {
    expect(goalRatio(1800, 0)).toBeNull()
    expect(goalRatio(0, 30)).toBe(0)
    expect(goalRatio(15 * 60, 30)).toBeCloseTo(0.5)
    // 超额也是合法比值:环画满,文案照实说。
    expect(goalRatio(45 * 60, 30)).toBeCloseTo(1.5)
  })

  it('goalReached needs the full minutes, not "any reading"', () => {
    expect(goalReached(29 * 60 + 59, 30)).toBe(false)
    expect(goalReached(30 * 60, 30)).toBe(true)
    expect(goalReached(30 * 60, 0)).toBe(false)
  })

  it('goalDays counts the last N days meeting the goal, gaps excluded', () => {
    const days = [day(0, 30 * 60), day(1, 30 * 60), day(2, 20 * 60), day(7, 60 * 60)]
    // 窗口是最近 7 天(09-22…09-28):达标的只有今天与昨天;20 分那天不够,
    // 第 7 天前(09-21)在窗口外,读得再久也不算。
    expect(goalDays(days, 30, 7, today)).toBe(2)
    expect(goalDays(days, 0, 7, today)).toBe(0)
    // 3 天窗口(09-26…09-28):今天与昨天达标,20 分那天不够。
    expect(goalDays(days, 30, 3, today)).toBe(2)
  })
})

describe('weekly & yearly goals', () => {
  const day = (offset: number, seconds: number) => {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    return { day: localDayKey(date), seconds }
  }

  it('daysWithReading counts days past the two-minute floor, not any touch', () => {
    const days = [day(0, 600), day(1, STREAK_MIN_SECONDS - 1), day(3, 3600)]
    expect(daysWithReading(days, 7, today)).toBe(2)
    expect(daysWithReading(days, 2, today)).toBe(1) // 窗口只有今天与昨天
    expect(daysWithReading([], 7, today)).toBe(0)
  })

  it('booksFinishedInYear counts dated finishes by local year', () => {
    const books = [
      { finishedAt: '2026-03-04T00:00:00Z' },
      { finishedAt: '2026-11-20T00:00:00Z' },
      { finishedAt: '2025-06-15T00:00:00Z' },
      { finishedAt: null },
    ]
    // 归属按本地日历年(时区由运行环境决定,断言用年内 unambiguous 日期)。
    expect(booksFinishedInYear(books, 2026)).toBe(2)
    expect(booksFinishedInYear(books, 2025)).toBe(1)
    expect(booksFinishedInYear(books, 2024)).toBe(0)
    // 没盖章的老书(进度 100% 但没有完成时间)不计入 —— 宁少报,不猜。
    expect(booksFinishedInYear([{ finishedAt: null }])).toBe(0)
  })
})

describe('year heatmap', () => {
  const day = (offset: number, seconds: number) => {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    return { day: localDayKey(date), seconds }
  }

  it('lays out Monday-first weeks covering the whole year', () => {
    const columns = yearHeatmap([day(0, 600)], today)
    // 2026-01-01 是周四 → 第一列从 2025-12-29(周一)开始,整年 53 列。
    expect(columns[0]?.[0]).toMatchObject({ day: '2025-12-29', inYear: false })
    expect(columns[0]?.[3]).toMatchObject({ day: '2026-01-01', inYear: true })
    // 最后一列必须盖住 12 月 31 日。
    const last = columns[columns.length - 1]!
    expect(last.map((cell) => cell.day)).toContain('2026-12-31')
    // 每一列都是 7 格(周一→周日)。
    for (const column of columns) expect(column).toHaveLength(7)
  })

  it('marks today and the future, fills gaps with zero', () => {
    const columns = yearHeatmap([day(0, 600), day(1, 0)], today)
    const flat = columns.flat()
    const todayCell = flat.find((cell) => cell.day === localDayKey(today))
    expect(todayCell).toMatchObject({ seconds: 600, future: false })
    const yesterday = flat.find((cell) => cell.day === localDayKey(new Date(2026, 8, 27)))
    expect(yesterday).toMatchObject({ seconds: 0, future: false })
    // 2027 年 1 月(first column padding 之外没有)不在图里;今天之后全标 future。
    expect(flat.filter((cell) => cell.future).every((cell) => cell.seconds === 0)).toBe(true)
    expect(flat.some((cell) => cell.day === '2026-09-28' && cell.seconds === 600)).toBe(true)
  })

  it('heatLevel scales against the reference with a 30-minute floor', () => {
    expect(heatLevel(0, 1800)).toBe(0)
    expect(heatLevel(-5, 1800)).toBe(0)
    // 参考 30 分钟:1/4 以下 1 格,正好 1/2 → 2 格,满参考 4 格。
    expect(heatLevel(5 * 60, 30 * 60)).toBe(1)
    expect(heatLevel(15 * 60, 30 * 60)).toBe(2)
    expect(heatLevel(30 * 60, 30 * 60)).toBe(4)
    expect(heatLevel(90 * 60, 30 * 60)).toBe(4)
    // 参考值异常小时有地板:读 5 分钟也不会满格。
    expect(heatLevel(5 * 60, 60)).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { STREAK_MIN_SECONDS, dailySeries, localDayKey, readingStreak, recentDayKeys } from './stats'

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

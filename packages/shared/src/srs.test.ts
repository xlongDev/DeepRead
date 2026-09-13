import { describe, expect, it } from 'vitest'
import { INITIAL_SRS_STATE, isDue, scheduleReview } from './srs'

describe('scheduleReview', () => {
  const now = new Date('2026-09-14T00:00:00Z')

  it('a new good card graduates to one day', () => {
    const { next, dueAt } = scheduleReview(INITIAL_SRS_STATE, 'good', now)
    expect(next.reps).toBe(1)
    expect(next.intervalDays).toBe(1)
    expect(dueAt).toBe('2026-09-15T00:00:00.000Z')
  })

  it('an easy card jumps further and raises ease', () => {
    const { next } = scheduleReview(INITIAL_SRS_STATE, 'easy', now)
    expect(next.intervalDays).toBe(3)
    expect(next.ease).toBeCloseTo(2.65)
  })

  it('good grows the interval by ease', () => {
    const state = { ease: 2.5, intervalDays: 10, reps: 3, lapses: 0 }
    const { next } = scheduleReview(state, 'good', now)
    expect(next.intervalDays).toBeCloseTo(25)
  })

  it('again relearns in 10 minutes, drops ease and counts a lapse', () => {
    const state = { ease: 2.5, intervalDays: 10, reps: 3, lapses: 0 }
    const { next, dueAt } = scheduleReview(state, 'again', now)
    expect(next.lapses).toBe(1)
    expect(next.ease).toBeCloseTo(2.3)
    expect(next.intervalDays).toBeCloseTo(10 / 1440)
    expect(new Date(dueAt).getTime()).toBe(now.getTime() + 10 * 60 * 1000)
  })

  it('hard shortens growth but keeps the card scheduled', () => {
    const state = { ease: 2.5, intervalDays: 10, reps: 3, lapses: 0 }
    const { next } = scheduleReview(state, 'hard', now)
    expect(next.intervalDays).toBeCloseTo(12)
    expect(next.ease).toBeCloseTo(2.35)
  })

  it('ease never drops below the floor', () => {
    const state = { ease: 1.3, intervalDays: 5, reps: 9, lapses: 4 }
    const { next } = scheduleReview(state, 'again', now)
    expect(next.ease).toBe(1.3)
  })

  it('intervals cap at one year', () => {
    const state = { ease: 2.9, intervalDays: 400, reps: 30, lapses: 0 }
    const { next } = scheduleReview(state, 'easy', now)
    expect(next.intervalDays).toBe(365)
  })
})

describe('isDue', () => {
  it('is true for past dates and false for future ones', () => {
    expect(isDue('2026-09-13T00:00:00Z', new Date('2026-09-14T00:00:00Z'))).toBe(true)
    expect(isDue('2026-09-15T00:00:00Z', new Date('2026-09-14T00:00:00Z'))).toBe(false)
  })
})

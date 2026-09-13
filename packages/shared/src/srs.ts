/**
 * Spaced repetition scheduling (spec Sprint 12): SM-2 lite.
 *
 * Four grades, per-card state, no review log — the state fields live on the
 * card row and the next due date is derived from `now`. Deliberately simpler
 * than full SM-2: no per-answer quality scale, minimum interval 10 minutes.
 */

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

export interface SrsState {
  readonly ease: number
  readonly intervalDays: number
  readonly reps: number
  readonly lapses: number
}

export const INITIAL_SRS_STATE: SrsState = {
  ease: 2.5,
  intervalDays: 0,
  reps: 0,
  lapses: 0,
}

const MIN_EASE = 1.3
const MAX_INTERVAL_DAYS = 365
/** A failed card comes back in 10 minutes (1/1440 of a day is one minute). */
const RELEARN_DAYS = 10 / 1440

export interface ScheduledReview {
  readonly next: SrsState
  readonly dueAt: string
}

export function scheduleReview(
  state: SrsState,
  grade: ReviewGrade,
  now = new Date(),
): ScheduledReview {
  let { ease, intervalDays, reps, lapses } = state
  reps += 1
  switch (grade) {
    case 'again':
      lapses += 1
      ease = Math.max(MIN_EASE, ease - 0.2)
      intervalDays = RELEARN_DAYS
      break
    case 'hard':
      ease = Math.max(MIN_EASE, ease - 0.15)
      intervalDays = intervalDays === 0 ? 0.5 : intervalDays * 1.2
      break
    case 'good':
      intervalDays = intervalDays === 0 ? 1 : intervalDays * ease
      break
    case 'easy':
      ease += 0.15
      intervalDays = intervalDays === 0 ? 3 : intervalDays * ease * 1.3
      break
  }
  intervalDays = Math.min(MAX_INTERVAL_DAYS, intervalDays)
  const due = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000)
  return {
    next: { ease, intervalDays, reps, lapses },
    dueAt: due.toISOString(),
  }
}

/** True when the card is due for review (or overdue) at `now`. */
export function isDue(dueAt: string, now = new Date()): boolean {
  return new Date(dueAt).getTime() <= now.getTime()
}

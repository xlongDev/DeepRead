/**
 * Reading-stat derivations. Kept here (not in the UI) so the same rules can be
 * unit-tested without a DOM.
 */

export interface DayStat {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string
  readonly seconds: number
}

/** Local `YYYY-MM-DD` for a clock reading — "today" is the user's day, not UTC. */
export function localDayKey(date: Date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** The last `count` day keys ending at `today`, oldest first. */
export function recentDayKeys(count: number, today: Date = new Date()): string[] {
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    keys.push(localDayKey(date))
  }
  return keys
}

/**
 * Consecutive days with reading time, counting back from today. Two minutes is
 * the floor: opening a book for three seconds is not a reading day.
 */
export const STREAK_MIN_SECONDS = 120

export function readingStreak(days: readonly DayStat[], today: Date = new Date()): number {
  const byDay = new Map(days.map((entry) => [entry.day, entry.seconds]))
  const counts = (key: string): boolean => (byDay.get(key) ?? 0) >= STREAK_MIN_SECONDS

  let streak = 0
  const cursor = new Date(today)
  // Yesterday still counts when today has not been read yet, so the number
  // does not collapse to 0 every midnight.
  if (!counts(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (counts(localDayKey(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** Seconds from `days` grouped for a bar chart, gaps filled with zero. */
export function dailySeries(
  days: readonly DayStat[],
  count: number,
  today: Date = new Date(),
): readonly (DayStat & { readonly label: string })[] {
  const byDay = new Map(days.map((entry) => [entry.day, entry.seconds]))
  return recentDayKeys(count, today).map((key) => ({
    day: key,
    seconds: byDay.get(key) ?? 0,
    label: `${Number(key.slice(8, 10))}`,
  }))
}

/* ---------- Reading goal ----------
目标本身只是「每天多少分钟」;推导全部放这里,统计环 / 侧栏摘要 / 达标天数
三处共用同一套规则,不各写一遍。 */

/** 0 = 没有目标。 */
export const NO_GOAL_MINUTES = 0

/**
 * 今日目标完成度(可超过 1)。没有目标时返回 null —— 调用方据此不画环、
 * 不显示百分比,而不是画一个 0% 的环冒充"差了全部"。
 */
export function goalRatio(todaySeconds: number, goalMinutes: number): number | null {
  if (goalMinutes <= NO_GOAL_MINUTES) return null
  return todaySeconds / (goalMinutes * 60)
}

/** 今日是否达标。没有目标时永远 false(无从谈起)。 */
export function goalReached(todaySeconds: number, goalMinutes: number): boolean {
  const ratio = goalRatio(todaySeconds, goalMinutes)
  return ratio !== null && ratio >= 1
}

/**
 * 最近 `count` 天(含今天)里达标的天数。判定与 streak 同一个思路:
 * 读够了目标分钟才算,随手翻两页不算。
 */
export function goalDays(
  days: readonly DayStat[],
  goalMinutes: number,
  count = 7,
  today: Date = new Date(),
): number {
  if (goalMinutes <= NO_GOAL_MINUTES) return 0
  const threshold = goalMinutes * 60
  const byDay = new Map(days.map((entry) => [entry.day, entry.seconds]))
  return recentDayKeys(count, today).filter((key) => (byDay.get(key) ?? 0) >= threshold).length
}

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

/* ---------- Weekly / yearly goals ----------
「每周读几天」数的是读过的日子(判据与 streak 同一条:至少两分钟);
「今年读完几本」数的是带完成时间的书(完成时间在 `books.finished_at`,
进度第一次到 100% 时由后端盖章,见 state.rs `store_state`)。 */

/** 最近 `count` 天(含今天)里"读过了"的天数。 */
export function daysWithReading(
  days: readonly DayStat[],
  count = 7,
  today: Date = new Date(),
): number {
  const byDay = new Map(days.map((entry) => [entry.day, entry.seconds]))
  return recentDayKeys(count, today).filter((key) => (byDay.get(key) ?? 0) >= STREAK_MIN_SECONDS)
    .length
}

/** 只需要 `finishedAt` 一本书 —— 调用方传整个书架也无妨。 */
export interface FinishedBookLike {
  readonly finishedAt: string | null
}

/**
 * `year` 年(本地日历年)读完的本数。`finishedAt` 是 RFC3339 时刻,按用户
 * 本地时区归年 —— 12 月 31 日 23:30 读完的书,在 UTC+8 里算当年。
 * 没有完成时间的老书不计入:宁少报,不猜。
 */
export function booksFinishedInYear(
  books: readonly FinishedBookLike[],
  year: number = new Date().getFullYear(),
): number {
  return books.filter(
    (book) => book.finishedAt !== null && new Date(book.finishedAt).getFullYear() === year,
  ).length
}

/* ---------- Year heatmap ----------
一年的阅读热力图:列 = 周(周一起),行 = 周一→周日。数据只用
`DayStat[]`(reader.stats.get 最多给 400 天,覆盖一整年),缺的天补零。 */

export interface HeatCell {
  readonly day: string
  readonly seconds: number
  /** 今天之后:格子在,但没有数据,也不该被点亮。 */
  readonly future: boolean
  /** 是否属于目标年份(年初第一列可能带上去年 12 月的补位格)。 */
  readonly inYear: boolean
}

/** 目标年份的热力图列(每周一列,7 格周一→周日,最旧在前)。 */
export function yearHeatmap(
  days: readonly DayStat[],
  today: Date = new Date(),
): readonly (readonly HeatCell[])[] {
  const byDay = new Map(days.map((entry) => [entry.day, entry.seconds]))
  const year = today.getFullYear()
  const todayKey = localDayKey(today)
  // 网格从「1 月 1 日所在周的周一」开始 —— 一周之始按国内习惯是周一。
  const jan1 = new Date(year, 0, 1)
  const monday = new Date(jan1)
  monday.setDate(monday.getDate() - ((jan1.getDay() + 6) % 7))
  const dec31 = new Date(year, 11, 31)

  // 列数先算出来,循环按索引走:Date 的 setDate 就地改写对象,写成
  // `weekStart <= dec31` 的循环条件 lint 读不出"它在动"。
  const spanDays = Math.round((dec31.getTime() - monday.getTime()) / 86_400_000) + 1
  const weekCount = Math.ceil(spanDays / 7)

  const columns: HeatCell[][] = []
  for (let week = 0; week < weekCount; week += 1) {
    const column: HeatCell[] = []
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(monday)
      date.setDate(date.getDate() + week * 7 + offset)
      const key = localDayKey(date)
      column.push({
        day: key,
        seconds: byDay.get(key) ?? 0,
        future: key > todayKey,
        inYear: date.getFullYear() === year,
      })
    }
    columns.push(column)
  }
  return columns
}

/**
 * 热力图色阶(0…4)。参考值优先取每日目标(格子点亮 = 当天达标,和柱状图
 * 同一把尺);没有目标时退回年度峰值,地板 30 分钟防止"读 5 分钟就满格"。
 */
export function heatLevel(seconds: number, referenceSeconds: number): 0 | 1 | 2 | 3 | 4 {
  if (seconds <= 0) return 0
  const reference = Math.max(referenceSeconds, 30 * 60)
  return Math.min(4, Math.max(1, Math.ceil((seconds / reference) * 4))) as 1 | 2 | 3 | 4
}

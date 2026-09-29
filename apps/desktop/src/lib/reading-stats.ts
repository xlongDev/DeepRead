/**
 * Reading-time reporting — desktop stores per book per day in SQLite; the
 * browser build (dev, no IPC) keeps the same shape in localStorage so the
 * stats panel behaves identically.
 */

import type { BookReadingStat, DayStat } from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from './ipc'

const WEB_KEY = 'deepread.reading-stats'

function readWebStats(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WEB_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    )
  } catch {
    return {}
  }
}

/** Record a completed slice of reading time (the caller owns the clock). */
export async function reportReadingTime(
  bookHash: string,
  day: string,
  seconds: number,
): Promise<void> {
  if (seconds < 1) return
  if (isTauriRuntime()) {
    await invokeCommand('reader.stats.add', { bookHash, day, seconds: Math.round(seconds) })
    return
  }
  const stats = readWebStats()
  stats[day] = (stats[day] ?? 0) + Math.round(seconds)
  localStorage.setItem(WEB_KEY, JSON.stringify(stats))
}

export interface ReadingStats {
  readonly days: readonly DayStat[]
  readonly totalSeconds: number
}

export async function loadReadingStats(): Promise<ReadingStats> {
  if (isTauriRuntime()) return invokeCommand('reader.stats.get', undefined)
  const stats = readWebStats()
  const days = Object.entries(stats)
    .map(([day, seconds]) => ({ day, seconds }))
    .sort((a, b) => (a.day < b.day ? 1 : -1))
  return {
    days,
    totalSeconds: days.reduce((sum, entry) => sum + entry.seconds, 0),
  }
}

/**
 * 每本书累计读了多少(排行榜)。
 *
 * 浏览器模式只按天记总量,没有分书的账,所以如实返回空 —— 拿「今天总共读了
 * 多久」去冒充「这本书读得最久」是编数据,排行榜宁可空着。
 */
export async function loadBookStats(): Promise<readonly BookReadingStat[]> {
  if (!isTauriRuntime()) return []
  const response = await invokeCommand('reader.stats.books', undefined)
  return response.books
}

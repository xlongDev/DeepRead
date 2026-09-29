/**
 * 阅读时长的记录与读取。
 *
 * 两个平台走**同一条命令** —— 桌面端落到 SQLite 的「按书 × 按天」账,浏览器端
 * 在 `lib/ipc.ts` 被分流到 IndexedDB(见 `web-handlers.ts`)。过去浏览器端是拿
 * localStorage 单独记一份、且只记总量不记分书,现在那套分叉没有了。
 *
 * 注:localStorage 里的旧键 `deepread.reading-stats` 不再读取,不做迁移 ——
 * 那是浏览器预览期的临时数据,搬过来只会把「某天读了多久」和「哪本书读了多久」
 * 混在一起,而后者从来没被记过。
 */

import type { BookReadingStat, DayStat } from '@deepread/shared'
import { invokeCommand } from './ipc'

/** Record a completed slice of reading time (the caller owns the clock). */
export async function reportReadingTime(
  bookHash: string,
  day: string,
  seconds: number,
): Promise<void> {
  if (seconds < 1) return
  await invokeCommand('reader.stats.add', { bookHash, day, seconds: Math.round(seconds) })
}

export interface ReadingStats {
  readonly days: readonly DayStat[]
  readonly totalSeconds: number
}

export async function loadReadingStats(): Promise<ReadingStats> {
  return invokeCommand('reader.stats.get', undefined)
}

/** 每本书累计读了多少(排行榜)。 */
export async function loadBookStats(): Promise<readonly BookReadingStat[]> {
  const response = await invokeCommand('reader.stats.books', undefined)
  return response.books
}

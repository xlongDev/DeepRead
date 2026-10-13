/**
 * 每日阅读目标(分钟)的读写。
 *
 * 两个平台走同一条命令 —— 桌面端落到 SQLite 的 `app_settings` KV(随备份的
 * VACUUM INTO 全量快照走),浏览器端在 `lib/ipc.ts` 被分流到 localStorage
 * (见 `web-handlers.ts`)。
 *
 * 0 = 没有目标:统计环不画、侧栏只报今日时长,不拿一个 0% 的环冒充"全部未完成"。
 */

import { invokeCommand } from './ipc'

export async function loadReadingGoal(): Promise<number> {
  const response = await invokeCommand('reading.goal.get', undefined)
  return response.dailyMinutes
}

/** 返回落库后的生效值(清洗过:越界值在 Rust / web 两侧都被收敛)。 */
export async function saveReadingGoal(dailyMinutes: number): Promise<number> {
  const response = await invokeCommand('reading.goal.set', { dailyMinutes })
  return response.dailyMinutes
}

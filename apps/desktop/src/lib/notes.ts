/**
 * 跨书批注(笔记页的数据源)。
 *
 * 两个平台走**同一条命令** —— 桌面端读 SQLite,浏览器端在 `lib/ipc.ts` 被分流
 * 到 IndexedDB(见 `web-handlers.ts`)。这里不再需要「浏览器模式返回空数组」
 * 那种降级分支。
 */

import type { NoteEntry } from '@deepread/shared'
import { invokeCommand } from './ipc'

export async function loadNotes(): Promise<readonly NoteEntry[]> {
  const response = await invokeCommand('reader.notes.list', undefined)
  return response.notes
}

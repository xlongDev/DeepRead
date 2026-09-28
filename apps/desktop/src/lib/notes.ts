/**
 * 跨书批注(笔记页的数据源)。
 *
 * 浏览器模式返回空数组而不是假装有数据:那边的阅读器是内存态,批注从不落库,
 * 编一份出来只会让人以为笔记丢了。
 */

import type { NoteEntry } from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from './ipc'

export async function loadNotes(): Promise<readonly NoteEntry[]> {
  if (!isTauriRuntime()) return []
  const response = await invokeCommand('reader.notes.list', undefined)
  return response.notes
}

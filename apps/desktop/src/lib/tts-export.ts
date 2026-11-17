/**
 * 有声书导出(plan B8 / ADR-0009)的 TS 侧:块清单构建与任务状态轮询。
 *
 * 块清单与听书**同一套句级单元**(reader-core `buildSpeechUnits`)——两条
 * 路径共用 `tts-cache/`,听过的句子导出秒过,中断续跑天然免费。合成循环
 * 在 Rust(整书音频不过 IPC),前端只交付分章文本块。
 */

import { buildSpeechUnits } from '@deepread/reader-core'
import type { TtsExportChapter, TtsExportTaskEntry, TtsExportTaskStatus } from '@deepread/shared'
import { invokeCommand } from './ipc'

export type { TtsExportChapter, TtsExportTaskEntry, TtsExportTaskStatus }

/** 一章的导出原料:章节序号、标题(落文件名)、纯文本。 */
export interface ExportChapterSource {
  readonly index: number
  readonly title: string
  readonly text: string
}

/**
 * 章文本 → 句级块清单。空章(无正文,如封面页)产出空 blocks,Rust 侧
 * 会为它提交一个空 mp3 占位文件,manifest 里如实计 0 块。
 */
export function planExportChapters(chapters: readonly ExportChapterSource[]): TtsExportChapter[] {
  return chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    blocks: buildSpeechUnits(chapter.text).map((unit) => unit.text),
  }))
}

/** 全部导出任务的当前状态快照(省略 bookHash = 全部)。空响应按空表处理。 */
export async function fetchExportStatuses(
  bookHash?: string,
): Promise<readonly TtsExportTaskEntry[]> {
  const response = await invokeCommand('tts.export.status', bookHash ? { bookHash } : {})
  return response.tasks ?? []
}

/** 还有在跑的任务吗(轮询的停机条件)。 */
export function hasRunningExport(tasks: readonly TtsExportTaskEntry[]): boolean {
  return tasks.some((task) => task.status.phase === 'running')
}

/** 任务是否已到终态(done/error/cancelled)。 */
export function isTerminalExport(status: TtsExportTaskStatus): boolean {
  return status.phase !== 'running'
}

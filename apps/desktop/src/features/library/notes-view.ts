/**
 * 笔记页的展示逻辑:分组、日期、原文的精简 —— 全是纯函数,所以能被单独测,
 * 组件只负责把它们画出来。
 */

import type { NoteEntry } from '@deepread/shared'
import { shelfTitle } from './shelf-view'

export interface NoteGroup {
  readonly bookHash: string
  readonly title: string
  readonly notes: readonly NoteEntry[]
}

/**
 * 按书分组。组间顺序沿用「这本书最近被划到是什么时候」:输入本身已是
 * 新→旧,所以按首次出现顺序分组即可,不需要再排一次。
 */
export function groupNotesByBook(notes: readonly NoteEntry[]): readonly NoteGroup[] {
  const buckets = new Map<string, NoteEntry[]>()
  for (const note of notes) {
    const bucket = buckets.get(note.bookHash)
    if (bucket) bucket.push(note)
    else buckets.set(note.bookHash, [note])
  }
  return [...buckets].map(([bookHash, items]) => ({
    bookHash,
    title: shelfTitle(items[0]!),
    notes: items,
  }))
}

/** 两个字的相对时间够了:笔记页是回看用的,不需要精确到分秒。 */
export function formatNoteTime(updatedAt: string | null, now: Date = new Date()): string | null {
  if (updatedAt === null) return null
  const then = new Date(updatedAt)
  if (Number.isNaN(then.getTime())) return null

  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return `${then.getFullYear()}-${`${then.getMonth() + 1}`.padStart(2, '0')}-${`${then.getDate()}`.padStart(2, '0')}`
}

/**
 * 笔记页一行能显示的字数有限。原文摘录在列表里只做引导,不做全文展示 ——
 * 想看全的,点一下回原文。
 */
export function excerptPreview(excerpt: string | null, max = 160): string | null {
  if (excerpt === null) return null
  const trimmed = excerpt.trim()
  if (trimmed === '') return null
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** 只有写了自己话的那几条 —— 「仅有笔记」筛选用的。 */
export function onlyWithNotes(notes: readonly NoteEntry[]): readonly NoteEntry[] {
  return notes.filter((note) => note.note !== null && note.note.trim() !== '')
}

/**
 * 整页导出成 Markdown:按书分节,原文用引用块,自己写的那句话跟在后面。
 * 摘录在这里**不截断** —— 截断是列表的呈现选择,不该带到导出结果里。
 *
 * 复制走剪贴板而不是写文件:桌面端写文件要先装 fs 插件或加一条 IPC,那属于
 * 「批注导出」自己的一档事,不该顺手塞进来半个。
 */
export function notesToMarkdown(
  groups: readonly NoteGroup[],
  exportedAt: Date = new Date(),
): string {
  const lines: string[] = [
    '# 阅读笔记',
    '',
    `导出时间:${exportedAt.toISOString().slice(0, 10)}`,
    '',
  ]
  for (const group of groups) {
    lines.push(`## ${group.title}`, '')
    for (const note of group.notes) {
      const excerpt = note.excerpt?.trim()
      if (excerpt !== undefined && excerpt !== '') lines.push(`> ${excerpt}`, '')
      const own = note.note?.trim()
      if (own !== undefined && own !== '') lines.push(own, '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 书名当文件名:Windows 不认的字符统一换成下划线。 */
export function safeFileName(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, '_').trim()
  return cleaned === '' ? '批注' : cleaned
}

/**
 * 把 Markdown 落成 .md 下载。Blob + a[download] —— 浏览器预览用。
 *
 * ⚠️ 桌面端不要走这条:WebView 默认拦截 `<a download>`,用户点了什么都不会
 * 发生(这正是「导出图标没反应」的根因)。桌面端走 `saveNoteMarkdown`。
 */
export function downloadNoteMarkdown(title: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeFileName(title)}-批注.md`
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * 导出批注:桌面端弹系统保存对话框、由 Rust 写文件;浏览器预览回退到 Blob 下载。
 *
 * 返回 `true` 表示已落盘(或已触发下载),`false` 表示用户在保存对话框里取消了。
 *
 * 环境判断内联而不是调 `isTauriRuntime()`:那要从 `lib/ipc` 静态引入
 * `@tauri-apps/api/core`,而这个模块的纯函数是单独测的,不该被拖上 Tauri 依赖。
 * 判断本身也只读一个全局标记。
 */
export async function saveNoteMarkdown(title: string, markdown: string): Promise<boolean> {
  const defaultName = `${safeFileName(title)}-批注`
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    downloadNoteMarkdown(title, markdown)
    return true
  }
  const { invokeCommand } = await import('../../lib/ipc')
  const response = await invokeCommand('notes.export', { markdown, defaultName })
  return response.path !== null
}

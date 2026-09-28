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

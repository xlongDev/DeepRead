/**
 * Shelf presentation logic: pure functions and option tables that the screen
 * only renders. Kept out of LibraryScreen so the rules (title fallback,
 * generated-cover palette, size labels) can be unit-tested without a DOM.
 */

import type { LibraryBook } from '@deepread/shared'
import { cleanBookTitle, type ImportProblem } from '../../lib/book-import'

/** `library.list` already joins the reading fraction — no per-book IPC. */
export type ShelfBook = LibraryBook

export type SortKey = 'added' | 'title' | 'size' | 'progress'
export type ViewMode = 'grid' | 'list'
export type AppTheme =
  'pure-white' | 'warm-paper' | 'ivory' | 'soft-gray' | 'dark' | 'oled' | 'liquid-glass'

export const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  added: '最近添加',
  title: '书名',
  size: '文件大小',
  progress: '阅读进度',
}

export const APP_THEMES: readonly {
  readonly id: AppTheme
  readonly label: string
  /** Mini page preview: background, ink, and accent of this world. */
  readonly swatch: string
  readonly ink: string
  readonly accent: string
}[] = [
  { id: 'pure-white', label: '纯白', swatch: '#f6f5f2', ink: '#1d1b17', accent: '#3d6deb' },
  { id: 'warm-paper', label: '暖纸', swatch: '#f3ecdd', ink: '#2b2620', accent: '#3d6deb' },
  { id: 'ivory', label: '象牙', swatch: '#f8f4ea', ink: '#33302a', accent: '#3d6deb' },
  { id: 'soft-gray', label: '浅灰', swatch: '#ebebeb', ink: '#222222', accent: '#3d6deb' },
  { id: 'dark', label: '深色', swatch: '#131210', ink: '#ece9e3', accent: '#6e93f6' },
  { id: 'oled', label: 'OLED 纯黑', swatch: '#000000', ink: '#e8e5df', accent: '#7d9ef7' },
  { id: 'liquid-glass', label: '液态玻璃', swatch: '#dfe5ec', ink: '#1c2430', accent: '#3d6deb' },
]

export const PROBLEM_MESSAGE: Readonly<Record<ImportProblem['kind'], string>> = {
  unsupported: '暂时不认识这个文件格式。目前支持 EPUB、MOBI、AZW3、FB2、CBZ、PDF、TXT、Markdown。',
  chm: 'CHM 暂不支持:阅读内核(foliate-js)还没有 CHM 解析器,我们如实告诉你,而不是假装能打开。',
}

/** Muted generated-cover palettes; picked deterministically by book hash. */
const COVER_PALETTES: readonly (readonly [string, string])[] = [
  ['#dfe7f5', '#b9c8e8'], // indigo mist
  ['#dcf0ea', '#aedccf'], // sage
  ['#f7ecdb', '#eed7b3'], // sand
  ['#fbe7df', '#f2c9bc'], // clay
  ['#e9e4f4', '#cfc4e6'], // lavender gray
  ['#e2eef4', '#bcd8e6'], // dusk blue
  ['#f5e0e8', '#e8becd'], // rose
  ['#e4efdd', '#c8e0b8'], // leaf
]

/** Stable per-book color pair — the same book always looks the same. */
export function coverPalette(hash: string): readonly [string, string] {
  let value = 0
  for (const char of hash) value = (value * 31 + char.charCodeAt(0)) | 0
  return COVER_PALETTES[Math.abs(value) % COVER_PALETTES.length] ?? COVER_PALETTES[0]!
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** 统计数字的紧凑格式:秒 → 分 → 小时。 */
export function formatStatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

/** The shelf title: the book's own metadata title once known, else cleaned file name. */
export function shelfTitle(book: LibraryBook): string {
  return book.displayName ?? cleanBookTitle(book.fileName)
}

export const sortFromStorage = (): SortKey => {
  const stored = localStorage.getItem('deepread.shelf.sort')
  return stored && stored in SORT_LABELS ? (stored as SortKey) : 'added'
}

export const viewFromStorage = (): ViewMode => {
  const stored = localStorage.getItem('deepread.shelf.view')
  return stored === 'list' ? 'list' : 'grid'
}

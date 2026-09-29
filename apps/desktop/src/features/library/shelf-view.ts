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
export type SortDir = 'asc' | 'desc'
export type ViewMode = 'grid' | 'list'

/**
 * 侧栏「我的分组」:不需要用户维护的视图,按进度与标签现算。
 * 与标签筛选可叠加(两个条件都满足才显示),不互斥。
 */
export type SmartFilter = 'all' | 'reading' | 'favorite' | 'finished'

export const SMART_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'reading', label: '在读' },
  { id: 'favorite', label: '收藏' },
  { id: 'finished', label: '已读完' },
] as const satisfies readonly { readonly id: SmartFilter; readonly label: string }[]

/** 「在读」= 翻开过但没读完。读完的归「已读完」,两者互斥。 */
export function isReading(book: Pick<LibraryBook, 'progress'>): boolean {
  const progress = book.progress ?? 0
  return progress > 0 && progress < 1
}

export function isFinished(book: Pick<LibraryBook, 'progress'>): boolean {
  return (book.progress ?? 0) >= 1
}

export function matchesSmartFilter(
  book: Pick<LibraryBook, 'progress' | 'tags'>,
  filter: SmartFilter,
): boolean {
  switch (filter) {
    case 'reading':
      return isReading(book)
    case 'finished':
      return isFinished(book)
    case 'favorite':
      return isFavorite(book)
    case 'all':
    default:
      return true
  }
}

/**
 * 每种排序自己的「自然」方向:最近添加、大文件、高进度都是降序符合直觉,
 * 书名则天然是 A→Z。换排序键时把方向重置回这个默认值,而不是沿用上一个
 * 键的方向 —— 否则用户会看到「按书名」却从 Z 开始。
 */
export const SORT_DEFAULT_DIR: Readonly<Record<SortKey, SortDir>> = {
  added: 'desc',
  title: 'asc',
  size: 'desc',
  progress: 'desc',
}

/**
 * 排序是纯计算,所以它住在这里而不是组件里 —— 组件只负责把结果渲染出来。
 * 未开始读的书(进度为 null)在**两个方向**下都沉底:升序时把它们顶到最前
 * 面,是把「没读过」当成了「进度最小」,那不是用户想看的。
 */
export function sortBooks(
  books: readonly LibraryBook[],
  key: SortKey,
  dir: SortDir,
): readonly LibraryBook[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...books].sort((a, b) => {
    if (key === 'progress') {
      const left = a.progress ?? -1
      const right = b.progress ?? -1
      if (left < 0 || right < 0) {
        if (left < 0 && right < 0) return 0
        return left < 0 ? 1 : -1
      }
      return (left - right) * sign
    }
    switch (key) {
      case 'title':
        return shelfTitle(a).localeCompare(shelfTitle(b), 'zh') * sign
      case 'size':
        return (a.size - b.size) * sign
      case 'added':
      default:
        return a.addedAt.localeCompare(b.addedAt) * sign
    }
  })
}

/** 没有存过方向时,回落到该排序键的自然方向(而不是一律降序)。 */
export const sortDirFromStorage = (fallback: SortDir): SortDir => {
  const stored = localStorage.getItem('deepread.shelf.sortDir')
  return stored === 'asc' || stored === 'desc' ? stored : fallback
}

/** 侧栏/工具栏的视图分组:书架是「我的书」,笔记与统计是另外两个目的地。 */
export type LibraryView = 'shelf' | 'notes' | 'stats'

/** 标签下拉的「不筛选」哨兵值(自绘下拉需要一个真实值)。 */
export const ALL_TAGS = '__all__'
/** 整批移出的待确认哨兵(单本待确认用的是真实 hash)。 */
export const BULK_CONFIRM = '__bulk__'

/**
 * 收藏就是标签 —— 不新增字段、不加迁移,`library.tag.set` 本来就能存它。
 * 侧栏与工具栏的标签筛选会自动带上它,不需要另开一条路径。
 */
export const FAVORITE_TAG = '收藏'

/** Rust 侧 `set_tags` 的上限,前端保持一致,免得用户输入被静默截断。 */
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 32

export function isFavorite(book: Pick<LibraryBook, 'tags'>): boolean {
  return book.tags.includes(FAVORITE_TAG)
}

/** 切换收藏,返回新的标签数组(纯函数,顺序稳定)。 */
export function toggleFavoriteTag(tags: readonly string[]): readonly string[] {
  return tags.includes(FAVORITE_TAG)
    ? tags.filter((tag) => tag !== FAVORITE_TAG)
    : [...tags, FAVORITE_TAG]
}

/**
 * 解析标签输入框:中英文逗号 / 分号 / 斜杠 / 顿号 / 空白都算分隔符。
 * 规则与 Rust 端 `set_tags` 对齐(trim、丢空、单标签上限、去重、总量上限),
 * 这样前端显示的结果与真正落库的结果一致。
 */
export function parseTagInput(raw: string): readonly string[] {
  const parsed: string[] = []
  for (const piece of raw.split(/[,，;；/、\s]+/)) {
    const tag = piece.trim()
    if (tag === '' || tag.length > MAX_TAG_LENGTH) continue
    if (parsed.includes(tag)) continue
    parsed.push(tag)
    if (parsed.length >= MAX_TAGS) break
  }
  return parsed
}
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

/**
 * 编辑面板里一键可加的常用标签。
 *
 * 只是个"起手式":用户大多在这几个类别里挑,让人从零开始敲一遍中文标签没必要。
 * 不含「收藏」—— 它是卡片上的星标,不该在标签列表里出现两次。
 */
export const SUGGESTED_TAGS: readonly string[] = [
  '文学',
  '小说',
  '历史',
  '科幻',
  '社科',
  '哲学',
  '技术',
  '科普',
  '传记',
  '推理',
  '艺术',
  '心理学',
  '经济',
  '待读',
] as const

/**
 * Stable per-book color pair — the same book always looks the same.
 *
 * 末尾那次雪崩混合不是装饰:直接把累加和取模会让**相似字符串撞进同一个
 * 调色板** —— 而 SHA-256 的十六进制串相邻两位恰恰就是"相似"(实测 'a'×64、
 * 'b'×64、'c'×64 全落在第 0 个)。混一轮之后 800 个真实 hash 在 8 个色板上
 * 的分布是 92~110,肉眼看得出的差别。
 */
export function coverPalette(hash: string): readonly [string, string] {
  let value = 0
  for (const char of hash) value = (value * 31 + char.charCodeAt(0)) | 0
  value ^= value >>> 15
  value = Math.imul(value, 0x2c1b3c6d)
  value ^= value >>> 12
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

/**
 * 书架标题:有书籍自带元数据就用它,否则回退到清洗过的文件名。
 * 参数放宽成子集而不是整本 `LibraryBook` —— 笔记页的条目只要这两个字段,
 * 免得为了复用一条规则去伪造一整本书。
 */
export function shelfTitle(book: Pick<LibraryBook, 'displayName' | 'fileName'>): string {
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

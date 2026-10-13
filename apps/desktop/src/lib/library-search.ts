/**
 * 跨书搜索的**书目匹配规则**(web 端与 dev demo 书架用)。
 *
 * 桌面端这条规则在 Rust 的 `search_library` 里(SQLite LIKE,字段一样);浏览器
 * 没有 SQLite,但书架数据全在内存里,同一套字段、同一种大小写行为在这里用 TS
 * 复述一遍。两个实现必须一起改 —— 只改一个,同一个查询在两个平台上会给出不同
 * 的书。
 */

import type { LibraryBook } from '@deepread/shared'

/** 正文命中上限,与 Rust `MAX_SEARCH_HITS` 一致(UI 要显示"已达上限")。 */
export const MAX_SEARCH_HITS = 30

/** 与 Rust 的 WHERE 子句同字段:题名 / 作者 / 副题 / 文件名 / 标签。 */
export function matchesBookQuery(book: LibraryBook, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const fields: readonly (string | null)[] = [
    book.fileName,
    book.displayName,
    book.author,
    book.subtitle,
    ...book.tags,
  ]
  return fields.some((field) => field !== null && field.toLowerCase().includes(q))
}

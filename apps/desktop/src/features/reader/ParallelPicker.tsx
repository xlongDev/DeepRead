/**
 * 对照阅读的第二本书选择器:阅读中想并排看另一本时弹出。
 *
 * 只在单本阅读时出现(并排后一栏没有第三栏可开),所以定位沿用排版面板
 * 那一套玻璃卡片,读者不用学新的位置 —— 同一个右上角,同一个尺寸感。
 *
 * 书单自己拉(`library.list`):阅读器不该为了这个面板去背一份书架状态,
 * 那会在导入/移除后不同步。挑中的书在这里就解析成 `OpenedBook`(桌面端
 * 走 asset 协议、浏览器端从 IndexedDB 取 object URL),阅读器只负责渲染。
 */

import { useEffect, useMemo, useState } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import type { LibraryBook } from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { browserBookUrl, openedBookFromLibrary, type OpenedBook } from '../../lib/book-import'

interface ParallelPickerProps {
  /** 当前这本书的 hash:它已经在读了,不该出现在候选里。 */
  readonly excludeHash: string
  readonly onPick: (other: OpenedBook) => void
  readonly onClose: () => void
}

/** 架上书名的口径与书架一致:元数据标题优先,没有就退回文件名。 */
function shelfTitle(book: LibraryBook): string {
  return book.displayName ?? book.fileName
}

export function ParallelPicker({ excludeHash, onPick, onClose }: ParallelPickerProps) {
  const [books, setBooks] = useState<readonly LibraryBook[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void invokeCommand('library.list', undefined)
      .then((response) => {
        if (!cancelled) setBooks(response.books)
      })
      .catch(() => {
        if (!cancelled) {
          setBooks([])
          setError('书架没有读出来,暂时选不了对照的书。')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const candidates = useMemo(() => {
    const list = (books ?? []).filter((book) => book.hash !== excludeHash)
    const needle = query.trim().toLowerCase()
    if (needle === '') return list
    return list.filter((book) => shelfTitle(book).toLowerCase().includes(needle))
  }, [books, excludeHash, query])

  const pick = (book: LibraryBook): void => {
    void (async () => {
      const url = isTauriRuntime() ? undefined : await browserBookUrl(book.hash)
      onPick(openedBookFromLibrary(book, url))
    })()
  }

  return (
    <section className="reader-settings reader-pick" aria-label="选择对照的书">
      <div className="reader-pick-head">
        <span className="settings-label">并排阅读</span>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={12} weight="regular" aria-hidden />
        </button>
      </div>

      <div className="reader-search reader-pick-search">
        <MagnifyingGlass size={13} weight="regular" aria-hidden />
        <input
          type="search"
          className="reader-search-input"
          value={query}
          placeholder="搜索书名"
          aria-label="搜索要对照的书"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error !== null && <p className="lookup-empty">{error}</p>}
      {books === null && <p className="lookup-empty">正在读书架…</p>}
      {books !== null && candidates.length === 0 && (
        <p className="lookup-empty">
          {books.length <= 1 ? '书架上只有这一本,先导入第二本来对照。' : '没有匹配的书。'}
        </p>
      )}

      <ul className="reader-pick-list">
        {candidates.map((book) => (
          <li key={book.hash}>
            <button type="button" className="reader-pick-row" onClick={() => pick(book)}>
              <span className="reader-pick-name">{shelfTitle(book)}</span>
              <span className="reader-pick-meta">
                {book.format.toUpperCase()}
                {book.author === null || book.author === '' ? '' : ` · ${book.author}`}
                {book.progress === null ? '' : ` · 已读 ${Math.round(book.progress * 100)}%`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

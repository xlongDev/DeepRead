/**
 * 笔记视图:跨书聚合的批注。
 *
 * 数据只来自桌面端的 SQLite(`reader.notes.list`);每条都能点回原文 —— 靠的是
 * 批注里记着的 CFI 与那本书的 hash,所以「回到这本书」不需要用户自己找位置。
 *
 * 导出落成「复制为 Markdown」而不是下载文件:桌面端写文件要先装 fs 插件或加
 * 一条 IPC,那属于批注导出自己的一档事,做半个下载按钮比没有更糟。
 */

import { useEffect, useRef, useState } from 'react'
import { BookOpen, Copy, NoteBlank } from '@phosphor-icons/react'
import type { NoteEntry } from '@deepread/shared'
import {
  excerptPreview,
  formatNoteTime,
  groupNotesByBook,
  notesToMarkdown,
  onlyWithNotes,
} from './notes-view'
import { coverPalette } from './shelf-view'

export interface NotesViewProps {
  readonly notes: readonly NoteEntry[]
  readonly loading: boolean
  readonly error: string | null
  /** 打开这本书并落到这条批注的位置。 */
  readonly onOpenNote: (entry: NoteEntry) => void
  /** 打开这本书,从上次读到的位置继续。 */
  readonly onOpenBook: (bookHash: string) => void
}

export function NotesView({ notes, loading, error, onOpenNote, onOpenBook }: NotesViewProps) {
  const [onlyNotes, setOnlyNotes] = useState(false)
  /** 刚复制的是哪一项(条目 id 或整页用 '__all__'),1.6 秒后自动复位。 */
  const [copied, setCopied] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const shown = onlyNotes ? onlyWithNotes(notes) : notes
  const groups = groupNotesByBook(shown)

  const copy = async (key: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 剪贴板可能被权限挡住;这时不做任何假装成功的提示。
      return
    }
    setCopied(key)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setCopied(null), 1600)
  }

  const copyAll = (): void => {
    void copy('__all__', notesToMarkdown(groups))
  }

  const copyOne = (entry: NoteEntry): void => {
    const parts = [entry.excerpt?.trim(), entry.note?.trim()].filter(
      (part): part is string => part !== undefined && part !== '',
    )
    void copy(entry.id, parts.join('\n\n'))
  }

  return (
    <section className="notes-page" aria-label="笔记">
      <div className="notes-toolbar">
        <h1 className="shelf-title">
          笔记 <span className="shelf-count">{shown.length}</span>
        </h1>
        <button
          type="button"
          className={`shelf-manage${onlyNotes ? ' is-active' : ''}`}
          aria-pressed={onlyNotes}
          onClick={() => setOnlyNotes((current) => !current)}
        >
          仅有笔记
        </button>
        <button
          type="button"
          className="shelf-import"
          onClick={copyAll}
          disabled={shown.length === 0}
        >
          <Copy size={15} weight="regular" aria-hidden />
          {copied === '__all__' ? '已复制' : '复制为 Markdown'}
        </button>
      </div>

      {loading ? (
        <p className="library-note">正在读批注…</p>
      ) : error !== null ? (
        <p className="library-error" role="alert">
          {error}
        </p>
      ) : groups.length === 0 ? (
        <div className="notes-empty">
          <NoteBlank size={40} weight="light" aria-hidden />
          <p className="notes-empty-title">{onlyNotes ? '没有写了自己话的批注' : '还没有批注'}</p>
          <p className="notes-empty-hint">
            在阅读器里选中一句话就能划线或写批注,它们会自动聚到这里;点任意一条可以跳回原文。
          </p>
        </div>
      ) : (
        <div className="notes-groups">
          {groups.map((group) => {
            // 色条按「书」分色,而不是照搬批注自己的高亮色 —— 同一本书里的批注本来
            // 就同色,一屏全是同一条黄线时根本分不出哪条属于哪本。取调色板的深色
            // 那端:浅色端在浅底上做竖条几乎看不见。
            const swatch = coverPalette(group.bookHash)[1]
            return (
              <section key={group.bookHash} className="note-group" aria-label={group.title}>
                <header className="note-group-head">
                  <h2 className="note-group-title">{group.title}</h2>
                  <span className="note-group-count">{group.notes.length} 条</span>
                  <button
                    type="button"
                    className="note-open-book"
                    onClick={() => onOpenBook(group.bookHash)}
                  >
                    <BookOpen size={14} weight="regular" aria-hidden />
                    回到这本书
                  </button>
                </header>
                <ul className="note-list">
                  {group.notes.map((entry) => {
                    const excerpt = excerptPreview(entry.excerpt)
                    const when = formatNoteTime(entry.updatedAt)
                    return (
                      <li key={entry.id} className="note-card">
                        <span className="note-swatch" style={{ background: swatch }} aria-hidden />
                        <div className="note-body">
                          {excerpt !== null && <p className="note-excerpt">{excerpt}</p>}
                          {entry.note !== null && entry.note.trim() !== '' && (
                            <p className="note-own">{entry.note}</p>
                          )}
                          <div className="note-foot">
                            {when !== null && <span>{when}</span>}
                            <span className="note-actions">
                              <button
                                type="button"
                                className="note-action"
                                onClick={() => onOpenNote(entry)}
                              >
                                跳到原文
                              </button>
                              <button
                                type="button"
                                className="note-action"
                                onClick={() => copyOne(entry)}
                              >
                                {copied === entry.id ? '已复制' : '复制'}
                              </button>
                            </span>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * 笔记视图(W4):跨书聚合的批注。
 *
 * 数据只来自桌面端的 SQLite(`reader.notes.list`);每条都能点回原文 —— 靠的是
 * 批注里记着的 CFI 与那本书的 hash,所以「回到这本书」不需要用户自己找位置。
 */

import { NoteBlank } from '@phosphor-icons/react'
import type { NoteEntry } from '@deepread/shared'
import { excerptPreview, formatNoteTime, groupNotesByBook } from './notes-view'

export interface NotesViewProps {
  readonly notes: readonly NoteEntry[]
  readonly loading: boolean
  readonly error: string | null
  /** 打开这本书并落到这条批注的位置。 */
  readonly onOpenNote: (entry: NoteEntry) => void
}

export function NotesView({ notes, loading, error, onOpenNote }: NotesViewProps) {
  const groups = groupNotesByBook(notes)

  return (
    <section className="notes-page" aria-label="笔记">
      <h1 className="shelf-title">
        笔记 <span className="shelf-count">{notes.length}</span>
      </h1>

      {loading ? (
        <p className="library-note">正在读批注…</p>
      ) : error !== null ? (
        <p className="library-error" role="alert">
          {error}
        </p>
      ) : groups.length === 0 ? (
        <div className="notes-empty">
          <NoteBlank size={40} weight="light" aria-hidden />
          <p className="notes-empty-title">还没有批注</p>
          <p className="notes-empty-hint">
            在阅读器里选中一句话就能划线或写批注,它们会自动聚到这里;点任意一条可以跳回原文。
          </p>
        </div>
      ) : (
        <div className="notes-groups">
          {groups.map((group) => (
            <section key={group.bookHash} className="note-group" aria-label={group.title}>
              <header className="note-group-head">
                <h2 className="note-group-title">{group.title}</h2>
                <span className="note-group-count">{group.notes.length} 条</span>
              </header>
              <ul className="note-list">
                {group.notes.map((entry) => {
                  const excerpt = excerptPreview(entry.excerpt)
                  const when = formatNoteTime(entry.updatedAt)
                  return (
                    <li key={entry.id} className="note-card">
                      <span
                        className="note-swatch"
                        style={{ background: entry.color }}
                        aria-hidden
                      />
                      <div className="note-body">
                        {excerpt !== null && <p className="note-excerpt">{excerpt}</p>}
                        {entry.note !== null && entry.note.trim() !== '' && (
                          <p className="note-own">{entry.note}</p>
                        )}
                        <div className="note-foot">
                          {when !== null && <span>{when}</span>}
                          <button
                            type="button"
                            className="note-jump"
                            onClick={() => onOpenNote(entry)}
                          >
                            回到原文
                          </button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}

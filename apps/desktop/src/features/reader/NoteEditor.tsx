/**
 * 批注笔记编辑器:墨水色托盘 + 文本域(⌘/Ctrl+Enter 保存)。
 * 从 ReaderScreen 拆出的共享件 —— 选区旁的就地编辑与目录批注列表的
 * 「写笔记」走同一个编辑器、同一份 NoteDraft。
 */

import type { AnnotationStyle } from '@deepread/reader-core'
import { HIGHLIGHT_PALETTE } from './reader-options'

export interface NoteDraft {
  readonly id?: string
  readonly cfi: string
  readonly excerpt: string
  readonly color: string
  readonly style: AnnotationStyle
  readonly note: string
}

/** 与 `reader.note.update` 的上限对齐(shared 协议里那条 zod)。 */
const NOTE_MAX_CHARS = 4000

interface NoteEditorProps {
  readonly draft: NoteDraft
  readonly onChange: (draft: NoteDraft) => void
  readonly onSave: () => void
  readonly onCancel: () => void
}

export function NoteEditor({ draft, onChange, onSave, onCancel }: NoteEditorProps) {
  return (
    <div className="note-editor">
      <p className="annotation-excerpt note-editor-quote">{draft.excerpt}</p>
      <div className="highlight-palette">
        {HIGHLIGHT_PALETTE.map((option) => (
          <button
            key={option.color}
            type="button"
            className={`highlight-swatch${draft.color === option.color ? ' is-active' : ''}`}
            style={{ background: option.color }}
            onClick={() => onChange({ ...draft, color: option.color })}
            aria-label={`${option.label}划线`}
            aria-pressed={draft.color === option.color}
            title={option.label}
          />
        ))}
      </div>
      <textarea
        className="note-input"
        rows={3}
        maxLength={NOTE_MAX_CHARS}
        value={draft.note}
        placeholder="写下你的想法…(留空保存 = 只要划线)"
        aria-label="笔记内容"
        onChange={(event) => onChange({ ...draft, note: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave()
        }}
      />
      <div className="note-editor-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave}>
          保存
        </button>
      </div>
    </div>
  )
}

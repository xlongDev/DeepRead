/**
 * 卡片上的「打标签」浮层。
 *
 * 第 2 个悬浮图标点开的必须是**这一步**:加/去掉几个标签。之前它打开的是整张
 * 元数据表单 —— 用户点「打标签」却看到一个书名、作者、出版社的表格,那是错的入口。
 *
 * 每次点击立即提交(不设保存按钮):标签是增量的、可撤销的,值得为它省掉一次确认。
 *
 * 预设标签铺满整套 `SUGGESTED_TAGS`,与批量加标签对齐 —— 一次能看到所有常用
 * 选项,而不是只挑 6 个让人误以为"还有别的"。
 */

import { useEffect, useRef, useState } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { MAX_TAGS, MAX_TAG_LENGTH, SUGGESTED_TAGS } from './shelf-view'

export interface TagPopoverProps {
  readonly label: string
  readonly tags: readonly string[]
  readonly onChange: (tags: readonly string[]) => void
  readonly onClose: () => void
}

export function TagPopover({ label, tags, onChange, onClose }: TagPopoverProps) {
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const toggle = (tag: string): void => {
    onChange(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag])
  }

  const commit = (): void => {
    const tag = draft.trim().slice(0, MAX_TAG_LENGTH)
    if (tag === '' || tags.includes(tag) || tags.length >= MAX_TAGS) {
      setDraft('')
      return
    }
    onChange([...tags, tag])
    setDraft('')
  }

  // 与批量对齐:全部展示,已加的隐藏(避免和"已加上"那一排视觉重复)。
  const suggestions = SUGGESTED_TAGS.filter((tag) => !tags.includes(tag))

  return (
    /* 用真的 <dialog>(open,非模态)而不是 div[role=dialog]:语义自带,少一条 lint。
       UA 的居中/margin 由 CSS 的 inset: auto + 具体定位覆盖掉。 */
    <dialog ref={rootRef} open className="tag-popover" aria-label={label}>
      <div className="tag-popover-head">
        <span>标签</span>
        <span className="tag-popover-count">
          {tags.length}/{MAX_TAGS}
        </span>
      </div>

      {tags.length > 0 && (
        <div className="tag-popover-chips">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="book-info-tag is-removable"
              aria-label={`去掉标签 ${tag}`}
              onClick={() => toggle(tag)}
            >
              {tag}
              <X size={10} weight="bold" aria-hidden />
            </button>
          ))}
        </div>
      )}

      <div className="tag-popover-input">
        <input
          type="text"
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          placeholder="新标签…"
          aria-label="新标签"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
        <button type="button" aria-label="添加标签" disabled={draft.trim() === ''} onClick={commit}>
          <Plus size={13} weight="bold" aria-hidden />
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="tag-popover-suggest">
          {suggestions.map((tag) => (
            <button key={tag} type="button" className="tag-chip" onClick={() => toggle(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}
    </dialog>
  )
}

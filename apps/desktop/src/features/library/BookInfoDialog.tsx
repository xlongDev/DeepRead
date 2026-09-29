/**
 * 编辑书籍信息(W2)。
 *
 * 只编辑**真的有展示位置**的字段:标题(书架卡片显示它)与标签(侧栏分组用它)。
 * 作者 / 系列 / 出版年这些字段数据库里没有,书架也不显示 —— 先不加,等它们
 * 有地方显示时再加(YAGNI)。
 *
 * 保存走两条既有命令:`library.rename`(标题)与 `library.tag.set`(标签),
 * 因此这一版不需要任何新 IPC、不需要数据库迁移。
 */

import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { MAX_TAGS, parseTagInput, shelfTitle, SUGGESTED_TAGS, type ShelfBook } from './shelf-view'

export interface BookInfoDraft {
  readonly title: string
  readonly author: string
  readonly subtitle: string
  readonly publisher: string
  readonly language: string
  readonly tags: readonly string[]
}

export interface BookInfoDialogProps {
  readonly book: ShelfBook
  readonly busy: boolean
  readonly error: string | null
  readonly onSave: (draft: BookInfoDraft) => void
  readonly onClose: () => void
}

export function BookInfoDialog({ book, busy, error, onSave, onClose }: BookInfoDialogProps) {
  const [title, setTitle] = useState(() => shelfTitle(book))
  const [author, setAuthor] = useState(() => book.author ?? '')
  const [subtitle, setSubtitle] = useState(() => book.subtitle ?? '')
  const [publisher, setPublisher] = useState(() => book.publisher ?? '')
  const [language, setLanguage] = useState(() => book.language ?? '')
  const [tagText, setTagText] = useState(() => book.tags.join(', '))
  const titleRef = useRef<HTMLInputElement>(null)

  // 打开就把光标放在书名上并全选 —— 这是最常改的一项。
  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  /** 一键加常用标签:已有的不再加,满了就不再塞。 */
  const addSuggestedTag = (tag: string): void => {
    if (tags.includes(tag) || tags.length >= MAX_TAGS) return
    setTagText((current) =>
      current.trim() === '' ? tag : `${current.replace(/[,,\s]+$/, '')}, ${tag}`,
    )
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tags = parseTagInput(tagText)
  const trimmedTitle = title.trim()
  const info = {
    title: trimmedTitle,
    author: author.trim(),
    subtitle: subtitle.trim(),
    publisher: publisher.trim(),
    language: language.trim(),
  }
  const infoChanged =
    (trimmedTitle !== '' && trimmedTitle !== shelfTitle(book)) ||
    info.author !== (book.author ?? '') ||
    info.subtitle !== (book.subtitle ?? '') ||
    info.publisher !== (book.publisher ?? '') ||
    info.language !== (book.language ?? '')
  const tagsChanged = tags.join('\u0000') !== book.tags.join('\u0000')

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-dismiss" aria-label="关闭书籍信息" onClick={onClose} />
      <dialog className="modal-panel" open aria-label="书籍信息">
        <header className="modal-head">
          <strong className="modal-title">书籍信息</strong>
          <button type="button" className="chrome-button" onClick={onClose} title="关闭">
            <X size={14} weight="regular" aria-hidden />
          </button>
        </header>

        <section className="modal-section">
          <label className="book-info-field">
            <span className="modal-section-label">标题</span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) onSave({ ...info, tags })
              }}
              placeholder={shelfTitle(book)}
              aria-label="书名"
            />
          </label>
          <p className="library-note">留空不会保存;标题只影响书架显示,不改动书里的内容。</p>
        </section>

        <section className="modal-section">
          <p className="modal-section-label">出版信息</p>
          <div className="book-info-grid">
            <label className="book-info-field">
              <span className="modal-section-label">作者</span>
              <input
                type="text"
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder="书里没写就留空"
                aria-label="作者"
              />
            </label>
            <label className="book-info-field">
              <span className="modal-section-label">出版社</span>
              <input
                type="text"
                value={publisher}
                onChange={(event) => setPublisher(event.target.value)}
                placeholder="可选"
                aria-label="出版社"
              />
            </label>
            <label className="book-info-field">
              <span className="modal-section-label">副标题</span>
              <input
                type="text"
                value={subtitle}
                onChange={(event) => setSubtitle(event.target.value)}
                placeholder="可选"
                aria-label="副标题"
              />
            </label>
            <label className="book-info-field">
              <span className="modal-section-label">语言</span>
              <input
                type="text"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="如 zh / en"
                aria-label="语言"
              />
            </label>
          </div>
          <p className="library-note">
            导入时会先读书里自带的元数据填一遍;这里改的只存在本地书架,不写回书文件。
          </p>
        </section>

        <section className="modal-section">
          <label className="book-info-field">
            <span className="modal-section-label">标签</span>
            <input
              type="text"
              list="deepread-tag-options"
              value={tagText}
              onChange={(event) => setTagText(event.target.value)}
              placeholder="文学, 在读"
              aria-label="标签"
            />
          </label>
          <p className="library-note">
            用逗号分隔,最多 {MAX_TAGS} 个。标签决定侧栏里的分组,「收藏」也是一个标签。
          </p>
          {/* 常用标签一键加上,省得每次从零敲中文。已经有的不再出现在这里。 */}
          <div className="book-info-suggest">
            {SUGGESTED_TAGS.filter((tag) => !tags.includes(tag))
              .slice(0, 8)
              .map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="tag-chip"
                  onClick={() => addSuggestedTag(tag)}
                  disabled={busy || tags.length >= MAX_TAGS}
                >
                  {tag}
                </button>
              ))}
          </div>
          {tags.length > 0 && (
            <p className="book-info-tags">
              {tags.map((tag) => (
                <span key={tag} className="book-info-tag">
                  {tag}
                </span>
              ))}
            </p>
          )}
        </section>

        {error !== null && (
          <p className="library-error" role="alert">
            {error}
          </p>
        )}

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || (!infoChanged && !tagsChanged)}
            onClick={() => onSave({ ...info, tags })}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </dialog>
    </div>
  )
}

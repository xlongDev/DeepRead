/**
 * 库侧栏(W1):三个目的地 + 标签分组。
 *
 * 刻意不做「图书馆 / 书架 / 书柜」三层 —— 图书馆与书架是同一个集合,书柜由
 * 标签承担(标签系统已经存在,再发明一层分组只会制造两套真相)。侧栏只属于
 * 书架这一层;阅读器保持全屏沉浸,它有自己的抽屉。
 */

import { BookOpenText, ChartLineUp, NoteBlank } from '@phosphor-icons/react'
import { coverPalette, type LibraryView } from './shelf-view'

export interface LibrarySidebarProps {
  readonly view: LibraryView
  readonly onView: (view: LibraryView) => void
  readonly shelfCount: number
  readonly tags: readonly string[]
  readonly activeTag: string | null
  /** 点当前已选中的标签 = 取消筛选。 */
  readonly onTag: (tag: string | null) => void
  /** 已经打开的标签筛选下拉:让侧栏与工具栏显示同一份真相。 */
  readonly filtered: boolean
}

export function LibrarySidebar({
  view,
  onView,
  shelfCount,
  tags,
  activeTag,
  onTag,
  filtered,
}: LibrarySidebarProps) {
  return (
    <aside className="lib-sidebar" aria-label="主导航">
      <nav className="lib-sidebar-nav" aria-label="视图">
        <button
          type="button"
          className="lib-sidebar-item"
          aria-current={view === 'shelf' ? 'page' : undefined}
          onClick={() => onView('shelf')}
        >
          <BookOpenText size={16} weight="regular" aria-hidden />
          书架
          <span className="lib-sidebar-count">{shelfCount}</span>
        </button>
        <button
          type="button"
          className="lib-sidebar-item"
          aria-current={view === 'notes' ? 'page' : undefined}
          onClick={() => onView('notes')}
        >
          <NoteBlank size={16} weight="regular" aria-hidden />
          笔记
        </button>
        <button
          type="button"
          className="lib-sidebar-item"
          aria-current={view === 'stats' ? 'page' : undefined}
          onClick={() => onView('stats')}
        >
          <ChartLineUp size={16} weight="regular" aria-hidden />
          统计
        </button>
      </nav>

      {tags.length > 0 && (
        <>
          <p className="lib-sidebar-label">
            标签
            {filtered && (
              <button type="button" className="lib-sidebar-clear" onClick={() => onTag(null)}>
                清除
              </button>
            )}
          </p>
          <div className="lib-sidebar-tags">
            {tags.map((tag) => {
              // 与封面同一套确定性配色:同一个标签永远是同一个颜色。
              const [tint] = coverPalette(tag)
              const active = activeTag === tag
              return (
                <button
                  key={tag}
                  type="button"
                  className="lib-sidebar-item is-tag"
                  aria-pressed={active}
                  onClick={() => onTag(active ? null : tag)}
                >
                  <span className="lib-sidebar-dot" style={{ background: tint }} aria-hidden />
                  {tag}
                </button>
              )
            })}
          </div>
        </>
      )}
    </aside>
  )
}

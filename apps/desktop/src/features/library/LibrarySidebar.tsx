/**
 * 库侧栏:三个目的地 + 我的分组 + 标签。
 *
 * 刻意不做「图书馆 / 书架 / 书柜」三层 —— 图书馆与书架是同一个集合,书柜由
 * 标签承担(标签系统已经存在,再发明一层分组只会制造两套真相)。侧栏只属于
 * 书架这一层;阅读器保持全屏沉浸,它有自己的抽屉。
 *
 * 「我的分组」是按进度与标签**现算**的视图,不需要用户维护任何东西;它与标签
 * 筛选可以叠加(两个条件同时满足才显示)。
 */

import { BookOpenText, ChartLineUp, Cloud, Gear, NoteBlank } from '@phosphor-icons/react'
import { coverPalette, SMART_FILTERS, type LibraryView, type SmartFilter } from './shelf-view'

export interface LibrarySidebarProps {
  readonly view: LibraryView
  readonly onView: (view: LibraryView) => void
  readonly shelfCount: number
  /** 没加载过就是 null:与其显示一个猜的数字,不如不显示。 */
  readonly notesCount: number | null
  readonly smartFilter: SmartFilter
  readonly onSmartFilter: (filter: SmartFilter) => void
  readonly smartCounts: Readonly<Record<SmartFilter, number>>
  readonly tags: readonly string[]
  readonly activeTag: string | null
  /** 点当前已选中的标签 = 取消筛选。 */
  readonly onTag: (tag: string | null) => void
  readonly onOpenSync: () => void
  readonly onOpenSettings: () => void
}

export function LibrarySidebar({
  view,
  onView,
  shelfCount,
  notesCount,
  smartFilter,
  onSmartFilter,
  smartCounts,
  tags,
  activeTag,
  onTag,
  onOpenSync,
  onOpenSettings,
}: LibrarySidebarProps) {
  return (
    <aside className="lib-sidebar" aria-label="主导航">
      {/* 顶部留一条与交通灯等高的空档:交通灯是原生控件,浮在这一块上,
          品牌因此落在它下面。拖窗口由 .window-drag 统一负责(侧栏收起时也在)。 */}
      <div className="lib-sidebar-top" aria-hidden />
      <div className="lib-brand" data-tauri-drag-region>
        <span className="library-mark" aria-hidden>
          <BookOpenText size={17} weight="fill" />
        </span>
        <span className="library-brand">Deepread</span>
      </div>
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
          {notesCount !== null && <span className="lib-sidebar-count">{notesCount}</span>}
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

      <p className="lib-sidebar-label">我的分组</p>
      <div className="lib-sidebar-nav">
        {SMART_FILTERS.map((filter) => {
          const active = filter.id === smartFilter
          return (
            <button
              key={filter.id}
              type="button"
              className="lib-sidebar-item"
              aria-pressed={active}
              onClick={() => onSmartFilter(filter.id)}
            >
              {filter.label}
              <span className="lib-sidebar-count">{smartCounts[filter.id]}</span>
            </button>
          )
        })}
      </div>

      {tags.length > 0 && (
        <>
          <p className="lib-sidebar-label">
            标签
            {activeTag !== null && (
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

      <div className="lib-sidebar-foot">
        <button type="button" className="lib-sidebar-item" onClick={onOpenSync}>
          <Cloud size={16} weight="regular" aria-hidden />
          云同步
        </button>
        <button type="button" className="lib-sidebar-item" onClick={onOpenSettings}>
          <Gear size={16} weight="regular" aria-hidden />
          设置
        </button>
      </div>
    </aside>
  )
}

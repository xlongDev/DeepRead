/**
 * 书架视图(W1 拆屏第一块)。
 *
 * 纯渲染 + 直白的 props:排序、筛选、封面缓存、选中集合全部由外壳算好传进来。
 * 这样拆出来的不是「另一个有状态的大组件」,而是一层可以单独渲染、单独测试的
 * 视图 —— 状态仍然只有一个归属地(LibraryScreen)。
 */

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  CheckSquare,
  ChartLineUp,
  DotsThree,
  ListBullets,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SquaresFour,
  Star,
  Trash,
  X,
} from '@phosphor-icons/react'
import { DropdownMenu } from '../../components/DropdownMenu'
import {
  ALL_TAGS,
  BULK_CONFIRM,
  coverPalette,
  formatBytes,
  isFavorite,
  shelfTitle,
  SORT_LABELS,
  type ShelfBook,
  type SortDir,
  type SortKey,
  type ViewMode,
} from './shelf-view'

export interface ShelfViewProps {
  readonly books: readonly ShelfBook[]
  readonly total: number
  readonly covers: ReadonlyMap<string, string>
  readonly query: string
  readonly onQuery: (value: string) => void
  readonly view: ViewMode
  readonly onView: (value: ViewMode) => void
  readonly sort: SortKey
  readonly onSort: (value: SortKey) => void
  readonly sortDir: SortDir
  readonly onToggleSortDir: () => void
  readonly tags: readonly string[]
  readonly tagFilter: string | null
  readonly onTagFilter: (value: string | null) => void
  readonly selecting: boolean
  readonly selected: ReadonlySet<string>
  readonly onToggleSelecting: () => void
  readonly onToggleSelected: (hash: string) => void
  readonly onOpenBook: (book: ShelfBook) => void
  readonly onToggleFavorite: (book: ShelfBook) => void
  readonly onEditInfo: (book: ShelfBook) => void
  readonly onImport: () => void
  /** 工具栏上的统计快捷入口:侧栏之外再给一条直达路径,高频动作不吃灰。 */
  readonly onOpenStats: () => void
  /** 已进入待确认态的书籍 hash(单本移除与整批移出共用)。 */
  readonly confirmRemove: string | null
  readonly onRemoveClick: (hash: string) => void
  readonly tagDraft: string
  readonly onTagDraft: (value: string) => void
  readonly onTagSelected: () => void
  readonly onSelectAll: () => void
  readonly onRemoveSelected: () => void
  readonly bulkBusy: boolean
  /** 标签筛选或搜索导致零结果时,用来还原用户输入的原话。 */
  readonly emptyHint: string
}

export function ShelfView({
  books,
  total,
  covers,
  query,
  onQuery,
  view,
  onView,
  sort,
  onSort,
  sortDir,
  onToggleSortDir,
  tags,
  tagFilter,
  onTagFilter,
  selecting,
  selected,
  onToggleSelecting,
  onToggleSelected,
  onOpenBook,
  onToggleFavorite,
  onEditInfo,
  onImport,
  onOpenStats,
  confirmRemove,
  onRemoveClick,
  tagDraft,
  onTagDraft,
  onTagSelected,
  onSelectAll,
  onRemoveSelected,
  bulkBusy,
  emptyHint,
}: ShelfViewProps) {
  /**
   * 卡片操作菜单。hover 只是**最快**的入口,不是唯一入口:同一个菜单必须
   * 能被右键与键盘(Shift+F10 / 菜单键)唤起,否则触屏和键盘用户够不到
   * 这些动作 —— 那是无障碍红线,不是体验偏好。
   */
  const [menuHash, setMenuHash] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (menuHash === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuHash(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuHash(null)
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      )
      if (items.length === 0) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[current === -1 ? 0 : (current + delta + items.length) % items.length]?.focus()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuHash])

  const openMenu = (hash: string): void => {
    setMenuHash(hash)
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    })
  }

  /** 键盘唤起:Shift+F10 与菜单键是桌面平台约定俗成的右键替代。 */
  const menuKeyHandler =
    (hash: string) =>
    (event: React.KeyboardEvent): void => {
      if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return
      event.preventDefault()
      openMenu(hash)
    }

  const renderMenu = (book: ShelfBook, extraClass: string): React.JSX.Element | null => {
    if (menuHash !== book.hash) return null
    const pendingRemove = confirmRemove === book.hash
    return (
      <div
        ref={menuRef}
        className={`card-menu ${extraClass}`}
        role="menu"
        aria-label={`${shelfTitle(book)} 的操作`}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenuHash(null)
            onEditInfo(book)
          }}
        >
          <PencilSimple size={14} weight="regular" aria-hidden />
          编辑书籍信息
        </button>
        <button
          type="button"
          role="menuitem"
          className={pendingRemove ? 'is-danger' : ''}
          onClick={() => {
            // 移除始终是两次点击:第一次进待确认态,菜单留着让用户看清后果。
            onRemoveClick(book.hash)
            if (pendingRemove) setMenuHash(null)
          }}
        >
          <Trash size={14} weight="regular" aria-hidden />
          {pendingRemove ? '确认移除(进度与批注一并删除)' : '从书架移除'}
        </button>
      </div>
    )
  }

  const pending = (hash: string): boolean => confirmRemove === hash

  const removeButton = (book: ShelfBook, extraClass?: string): React.JSX.Element => {
    const isPending = pending(book.hash)
    const label = shelfTitle(book)
    return (
      <button
        type="button"
        className={`book-remove${isPending ? ' is-confirm' : ''}${extraClass ? ` ${extraClass}` : ''}`}
        onClick={() => onRemoveClick(book.hash)}
        title={isPending ? '再次点击确认:进度与批注将一并移除' : '从书架移除(不删除原文件)'}
        aria-label={isPending ? `确认移除 ${label}` : `从书架移除 ${label}`}
      >
        {isPending ? (
          <Trash size={13} weight="fill" aria-hidden />
        ) : (
          <X size={13} weight="regular" aria-hidden />
        )}
      </button>
    )
  }

  return (
    <>
      <div className="shelf-toolbar">
        <h1 className="shelf-title">
          书架 <span className="shelf-count">{total}</span>
        </h1>
        <div className="shelf-search">
          <MagnifyingGlass size={15} weight="regular" aria-hidden />
          <input
            type="search"
            placeholder="搜索书名…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onQuery('')
            }}
            aria-label="搜索书名"
          />
        </div>
        <div className="shelf-view-toggle" role="toolbar" aria-label="视图切换">
          <button
            type="button"
            className={view === 'grid' ? 'is-active' : ''}
            onClick={() => onView('grid')}
            title="网格视图"
          >
            <SquaresFour size={15} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={view === 'list' ? 'is-active' : ''}
            onClick={() => onView('list')}
            title="列表视图"
          >
            <ListBullets size={15} weight="regular" aria-hidden />
          </button>
        </div>
        <DropdownMenu
          ariaLabel="排序方式"
          value={sort}
          options={Object.entries(SORT_LABELS).map(([key, label]) => ({
            value: key as SortKey,
            label,
          }))}
          onChange={onSort}
          className="dropdown-shelf-sort"
        />
        <button
          type="button"
          className={`shelf-sort-dir${sortDir === 'desc' ? ' is-desc' : ''}`}
          onClick={onToggleSortDir}
          title={sortDir === 'asc' ? '升序,点击改为降序' : '降序,点击改为升序'}
          aria-label={`切换排序方向(当前${sortDir === 'asc' ? '升序' : '降序'})`}
        >
          <ArrowUp size={15} weight="bold" aria-hidden />
        </button>
        {tags.length > 0 && (
          <DropdownMenu
            ariaLabel="按标签筛选"
            value={tagFilter ?? ALL_TAGS}
            options={[
              { value: ALL_TAGS, label: '全部标签' },
              ...tags.map((tag) => ({ value: tag, label: tag })),
            ]}
            onChange={(next) => onTagFilter(next === ALL_TAGS ? null : next)}
            className="dropdown-shelf-tags"
          />
        )}
        <button type="button" className="shelf-manage" onClick={onOpenStats} title="阅读统计">
          <ChartLineUp size={15} weight="regular" aria-hidden />
          统计
        </button>
        <button
          type="button"
          className="shelf-manage"
          onClick={() => onToggleSelecting()}
          title={selecting ? '退出批量管理' : '批量管理'}
          aria-pressed={selecting}
        >
          <CheckSquare size={15} weight={selecting ? 'fill' : 'regular'} aria-hidden />
          {selecting ? '完成' : '管理'}
        </button>
        <button type="button" className="shelf-import" onClick={onImport} aria-label="导入书籍">
          <Plus size={15} weight="bold" aria-hidden /> 导入
        </button>
      </div>

      {books.length === 0 ? (
        <p className="shelf-none">没有匹配“{emptyHint}”的书。</p>
      ) : view === 'grid' ? (
        <ul className="shelf-grid" aria-label="书架">
          {books.map((book, index) => {
            const palette = coverPalette(book.hash)
            const title = shelfTitle(book)
            const progress = book.progress
            const coverUrl = covers.get(book.hash) ?? null
            const isSelected = selected.has(book.hash)
            return (
              <li
                key={book.hash}
                className={`book-card${isSelected ? ' is-selected' : ''}`}
                style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
              >
                <div className="book-cover-shell">
                  <button
                    type="button"
                    className="book-cover"
                    onContextMenu={(event) => {
                      if (selecting) return
                      event.preventDefault()
                      openMenu(book.hash)
                    }}
                    onKeyDown={menuKeyHandler(book.hash)}
                    style={
                      coverUrl
                        ? undefined
                        : {
                            background: `linear-gradient(160deg, ${palette[0]}, ${palette[1]})`,
                          }
                    }
                    onClick={
                      selecting
                        ? () => onToggleSelected(book.hash)
                        : book.format === 'unknown'
                          ? undefined
                          : () => onOpenBook(book)
                    }
                    aria-pressed={selecting ? isSelected : undefined}
                    title={
                      selecting
                        ? isSelected
                          ? '取消选择'
                          : '选择这本书'
                        : book.format === 'unknown'
                          ? '重新导入同一文件即可恢复此书的进度与批注'
                          : `打开《${title}》`
                    }
                  >
                    {book.format === 'unknown' ? (
                      <span className="book-cover-missing">待重新导入</span>
                    ) : coverUrl ? (
                      <img src={coverUrl} alt="" className="book-cover-img" loading="lazy" />
                    ) : (
                      <>
                        <span className="book-cover-char">{title.charAt(0)}</span>
                        <span className="book-cover-title">{title}</span>
                      </>
                    )}
                    {book.format !== 'unknown' && (
                      <span className="book-format">{book.format.toUpperCase()}</span>
                    )}
                    {progress !== null && progress > 0 && (
                      <span className="book-progress" aria-hidden>
                        <span
                          className="book-progress-fill"
                          style={{ width: `${progress * 100}%` }}
                        />
                      </span>
                    )}
                    {selecting && (
                      <span className="book-select" aria-hidden>
                        {isSelected && <Check size={13} weight="bold" />}
                      </span>
                    )}
                  </button>
                  {!selecting && (
                    <div className="card-actions">
                      <button
                        type="button"
                        className="card-action-go"
                        onClick={() => onOpenBook(book)}
                      >
                        {progress !== null && progress > 0 ? '继续阅读' : '开始阅读'}
                      </button>
                      <button
                        type="button"
                        className={`card-action-icon${isFavorite(book) ? ' is-on' : ''}`}
                        aria-pressed={isFavorite(book)}
                        aria-label={isFavorite(book) ? `取消收藏 ${title}` : `收藏 ${title}`}
                        onClick={() => onToggleFavorite(book)}
                      >
                        <Star
                          size={15}
                          weight={isFavorite(book) ? 'fill' : 'regular'}
                          aria-hidden
                        />
                      </button>
                      <button
                        type="button"
                        className="card-action-icon"
                        aria-haspopup="menu"
                        aria-expanded={menuHash === book.hash}
                        aria-label={`更多操作 ${title}`}
                        onClick={() =>
                          menuHash === book.hash ? setMenuHash(null) : openMenu(book.hash)
                        }
                      >
                        <DotsThree size={16} weight="bold" aria-hidden />
                      </button>
                    </div>
                  )}
                  {renderMenu(book, 'is-card')}
                </div>
                <div className="book-meta">
                  <span className="book-meta-title" title={title}>
                    {title}
                  </span>
                  <span className="book-meta-sub">
                    {book.tags.length > 0 ? `${book.tags.join(' / ')} · ` : ''}
                    {book.format === 'unknown'
                      ? '重新导入同一文件即可恢复'
                      : progress !== null && progress > 0
                        ? `读到 ${Math.round(progress * 100)}% · ${formatBytes(book.size)}`
                        : formatBytes(book.size)}
                  </span>
                </div>
                {!selecting && removeButton(book)}
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="shelf-list" aria-label="书架">
          {books.map((book, index) => {
            const title = shelfTitle(book)
            const progress = book.progress
            const coverUrl = covers.get(book.hash) ?? null
            const palette = coverPalette(book.hash)
            const isSelected = selected.has(book.hash)
            return (
              <li
                key={book.hash}
                className={`book-row${isSelected ? ' is-selected' : ''}`}
                style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
              >
                <button
                  type="button"
                  className="book-row-open"
                  onContextMenu={(event) => {
                    if (selecting) return
                    event.preventDefault()
                    openMenu(book.hash)
                  }}
                  onKeyDown={menuKeyHandler(book.hash)}
                  onClick={() => (selecting ? onToggleSelected(book.hash) : onOpenBook(book))}
                  aria-pressed={selecting ? isSelected : undefined}
                >
                  {selecting && (
                    <span
                      className={`book-select is-inline${isSelected ? ' is-checked' : ''}`}
                      aria-hidden
                    >
                      {isSelected && <Check size={12} weight="bold" />}
                    </span>
                  )}
                  <span
                    className="book-row-cover"
                    style={
                      coverUrl
                        ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover' }
                        : {
                            background: `linear-gradient(160deg, ${palette[0]}, ${palette[1]})`,
                          }
                    }
                  >
                    {!coverUrl && <span className="book-cover-char">{title.charAt(0)}</span>}
                  </span>
                  <span className="book-row-main">
                    <span className="book-row-title">{title}</span>
                    <span className="book-row-sub">
                      {book.format.toUpperCase()} · {formatBytes(book.size)}
                      {progress !== null && progress > 0
                        ? ` · 读到 ${Math.round(progress * 100)}%`
                        : ''}
                      {book.tags.length > 0 ? ` · ${book.tags.join(' / ')}` : ''}
                    </span>
                  </span>
                  {progress !== null && progress > 0 && (
                    <span className="book-row-progress">
                      <span
                        className="book-progress-fill"
                        style={{ width: `${progress * 100}%` }}
                      />
                    </span>
                  )}
                </button>
                {!selecting && (
                  <div className="book-row-actions">
                    <button
                      type="button"
                      className={`card-action-icon${isFavorite(book) ? ' is-on' : ''}`}
                      aria-pressed={isFavorite(book)}
                      aria-label={isFavorite(book) ? `取消收藏 ${title}` : `收藏 ${title}`}
                      onClick={() => onToggleFavorite(book)}
                    >
                      <Star size={15} weight={isFavorite(book) ? 'fill' : 'regular'} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="card-action-icon"
                      aria-haspopup="menu"
                      aria-expanded={menuHash === book.hash}
                      aria-label={`更多操作 ${title}`}
                      onClick={() =>
                        menuHash === book.hash ? setMenuHash(null) : openMenu(book.hash)
                      }
                    >
                      <DotsThree size={16} weight="bold" aria-hidden />
                    </button>
                  </div>
                )}
                {!selecting && removeButton(book, 'book-row-remove')}
                {renderMenu(book, 'is-row')}
              </li>
            )
          })}
        </ul>
      )}

      {selecting && (
        <div className="shelf-bulk" role="toolbar" aria-label="批量操作">
          <span className="shelf-bulk-count">已选 {selected.size} 本</span>
          <button type="button" className="btn btn-ghost" onClick={onSelectAll}>
            {selected.size === books.length ? '取消全选' : '全选'}
          </button>
          <input
            className="shelf-bulk-tag"
            list="deepread-tag-options"
            placeholder="加标签…"
            value={tagDraft}
            onChange={(event) => onTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onTagSelected()
            }}
            aria-label="给选中的书加标签"
          />
          <button
            type="button"
            className="btn"
            disabled={bulkBusy || tagDraft.trim() === '' || selected.size === 0}
            onClick={onTagSelected}
          >
            打标签
          </button>
          <button
            type="button"
            className={`btn${confirmRemove === BULK_CONFIRM ? ' is-danger' : ''}`}
            disabled={bulkBusy || selected.size === 0}
            onClick={onRemoveSelected}
          >
            {confirmRemove === BULK_CONFIRM ? `确认移除 ${selected.size} 本?` : '移出书架'}
          </button>
        </div>
      )}

      <datalist id="deepread-tag-options">
        {tags.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </datalist>
    </>
  )
}

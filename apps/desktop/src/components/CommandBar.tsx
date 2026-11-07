import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { APP_THEMES, type AppTheme } from '@deepread/design-system'
import { useModalFocus } from '../lib/modal-dialog'
import { shelfTitle, type LibraryView, type ShelfBook } from '../features/library/shelf-view'

interface Command {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly group: string
  readonly run: () => void
}

interface CommandBarProps {
  readonly books: readonly ShelfBook[]
  readonly onClose: () => void
  readonly onOpenBook: (hash: string) => void
  readonly onView: (view: LibraryView) => void
  readonly onImport: () => void
  readonly onSettings: () => void
  readonly onSync: () => void
  readonly onTheme: (theme: AppTheme) => void
}

/**
 * ⌘K 命令栏:一个输入框同时回答「找哪本书」和「要做什么」。
 *
 * 刻意不用 combobox/ARIA 自动补全那一套:结果就是一组可读、可 Tab、可点击的
 * 按钮,读屏与键盘都走原生语义;↑↓ 只是把 active 移到下一个按钮。焦点圈与
 * 归还复用 useModalFocus,与两个设置弹窗同一套模态契约。
 */
export function CommandBar({
  books,
  onClose,
  onOpenBook,
  onView,
  onImport,
  onSettings,
  onSync,
  onTheme,
}: CommandBarProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useModalFocus(panelRef, { initialFocusRef: inputRef })

  const commands = useMemo<readonly Command[]>(() => {
    const items: Command[] = [
      {
        id: 'view-shelf',
        label: '打开书架',
        hint: '切换视图',
        group: '跳转',
        run: () => onView('shelf'),
      },
      {
        id: 'view-notes',
        label: '打开笔记',
        hint: '切换视图',
        group: '跳转',
        run: () => onView('notes'),
      },
      {
        id: 'view-stats',
        label: '阅读统计',
        hint: '切换视图',
        group: '跳转',
        run: () => onView('stats'),
      },
      { id: 'import', label: '导入书籍', hint: '从本地文件', group: '操作', run: onImport },
      {
        id: 'settings',
        label: '打开设置',
        hint: '外观 / 快捷键 / AI',
        group: '操作',
        run: onSettings,
      },
      { id: 'sync', label: '云同步', hint: 'WebDAV', group: '操作', run: onSync },
      ...APP_THEMES.map((theme) => ({
        id: `theme-${theme.id}`,
        label: `外观:${theme.label}`,
        hint: '切换主题',
        group: '外观',
        run: () => onTheme(theme.id),
      })),
    ]
    const needle = query.trim().toLocaleLowerCase()
    if (needle !== '') {
      for (const book of books) {
        const title = shelfTitle(book)
        if (!title.toLocaleLowerCase().includes(needle)) continue
        items.push({
          id: `book-${book.hash}`,
          label: title,
          hint: '打开这本书',
          group: '藏书',
          run: () => onOpenBook(book.hash),
        })
      }
    }
    return needle === ''
      ? items
      : items.filter(
          (item) => item.group === '藏书' || item.label.toLocaleLowerCase().includes(needle),
        )
  }, [books, query, onImport, onOpenBook, onSettings, onSync, onTheme, onView])

  const choose = (command: Command): void => {
    command.run()
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (commands.length === 0 ? 0 : (index + 1) % commands.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) =>
        commands.length === 0 ? 0 : (index - 1 + commands.length) % commands.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = commands[active]
      if (command !== undefined) choose(command)
    }
  }

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-dismiss" aria-label="关闭命令栏" onClick={onClose} />
      <dialog
        ref={panelRef}
        className="modal-panel command-panel"
        open
        aria-modal="true"
        aria-label="命令栏"
        onKeyDown={onKeyDown}
      >
        <div className="command-search">
          <MagnifyingGlass size={16} weight="regular" aria-hidden />
          <input
            ref={inputRef}
            className="command-input"
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder="搜索书名或输入命令…"
            aria-label="搜索书名或命令"
            autoComplete="off"
          />
          <kbd className="command-esc">Esc</kbd>
        </div>
        <div className="command-results">
          {commands.length === 0 ? (
            <p className="command-empty">没有匹配的命令或书名。</p>
          ) : (
            commands.map((command, index) => (
              <div key={command.id}>
                {(index === 0 || commands[index - 1]?.group !== command.group) && (
                  <p className="command-group-label">{command.group}</p>
                )}
                <button
                  type="button"
                  className={`command-item${index === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(command)}
                >
                  <span className="command-item-label">{command.label}</span>
                  <span className="command-item-hint">{command.hint}</span>
                </button>
              </div>
            ))
          )}
        </div>
        <p className="command-footnote" aria-live="polite">
          {commands.length} 个结果 · ↑↓ 选择 · Enter 执行
        </p>
      </dialog>
    </div>
  )
}

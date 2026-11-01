import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from '@phosphor-icons/react'
import { useMenuPosition } from './use-menu-position'

/** 一条动作,或一条分组线。分组线只在视觉上分开「同类动作」,不可聚焦。 */
export type ActionMenuItem =
  | {
      readonly label: string
      readonly hint?: string
      readonly icon?: React.ReactNode
      readonly onSelect: () => void
      readonly disabled?: boolean
      /** 开关型动作(全屏、阅读尺):勾选态由调用方给。 */
      readonly active?: boolean
      readonly title?: string
      /** 让调用方在打开面板后自己关菜单;默认点击即关。 */
      readonly keepOpen?: boolean
    }
  | { readonly separator: true }

interface ActionMenuProps {
  readonly ariaLabel: string
  readonly items: readonly ActionMenuItem[]
  /** 触发器内容(图标)。外层容器与交互由本组件给。 */
  readonly trigger: React.ReactNode
  readonly triggerTitle?: string
  /** 触发器自身处于「开着」状态时高亮。 */
  readonly triggerActive?: boolean
  /**
   * 菜单开合通知。宿主用它把「菜单开着」也算作一层浮层 —— ⋯ 在阅读器里
   * 时,菜单一开顶栏就不能再自动隐藏,否则菜单会孤零零悬在原处。
   */
  readonly onOpenChange?: (open: boolean) => void
  readonly className?: string
  /**
   * 阅读场景传 readerVars:portal 到 body 后菜单离开 `.reader` 作用域,
   * 主题变量全部失配,菜单会回落全局暗色(与 DropdownMenu 同款处置)。
   */
  readonly themeVars?: React.CSSProperties
}

/** 与 DropdownMenu 同级:压在一切 chrome 之上。 */
const MENU_Z_INDEX = 60

const isSeparator = (item: ActionMenuItem): item is { readonly separator: true } =>
  'separator' in item

/**
 * 动作菜单(⋯):与 DropdownMenu 的分工是 **选值 vs 执行**。
 * 语义用 `role="menu"` + `role="menuitem"`,开关型动作带 `aria-checked`。
 *
 * 为什么要抽成组件而不是继续平铺按钮:阅读器顶栏一度平铺了 12 颗同权图标,
 * 一次扫描要在 12 个位置里找一个 —— 收进菜单的低频动作换来的是剩下那颗
 * 高频动作能被一眼找到。
 */
export function ActionMenu({
  ariaLabel,
  items,
  trigger,
  triggerTitle,
  triggerActive,
  onOpenChange,
  className,
  themeVars,
}: ActionMenuProps) {
  const [open, setOpenState] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 开合只有这一个出口:否则「点开」通知了宿主、「点外面关掉」没通知,
  // 顶栏会以为菜单还开着,再也不肯自动隐藏。
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  useMenuPosition(open, triggerRef, menuRef, 208, 'auto')

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      // 菜单已 portal 出去:两个容器都要查,否则点选项会先被外面点击关掉。
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 只收自己的菜单,不 preventDefault —— 阅读器还要用 Esc 退出其它模式。
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const entries = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
      ).filter((button) => !button.disabled)
      if (entries.length === 0) return
      event.preventDefault()
      const at = entries.indexOf(document.activeElement as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next =
        at === -1
          ? delta === 1
            ? 0
            : entries.length - 1
          : (at + delta + entries.length) % entries.length
      entries[next]?.focus()
    }
    // 容器滚动 / 窗口缩放时菜单不跟着走会脱节,直接收。
    const onScrollOrResize = (): void => setOpen(false)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, setOpen])

  const menu = (
    <div
      ref={menuRef}
      className="action-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ position: 'fixed', zIndex: MENU_Z_INDEX }}
    >
      {items.map((item, index) =>
        isSeparator(item) ? (
          // 分隔线用 aria-hidden 的 div:菜单里插 <hr> 会让 role=menu 的
          // 直接子元素混进非 menuitem,读屏报「2 of 7」时数字对不上。
          <div key={`sep-${index}`} className="action-menu-sep" aria-hidden />
        ) : (
          <button
            key={item.label}
            type="button"
            /* 开关型动作(全屏/阅读尺)用 menuitemcheckbox:aria-checked 只有
               checkbox/radio 两种 menuitem 认,挂在裸 menuitem 上是无效属性。 */
            role={item.active === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.active}
            className={`action-option${item.active === true ? ' is-active' : ''}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              if (item.keepOpen !== true) setOpen(false)
              item.onSelect()
            }}
          >
            <span className="action-option-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="action-option-label">{item.label}</span>
            {item.hint !== undefined && <span className="action-option-hint">{item.hint}</span>}
            {item.active === true && <Check size={14} weight="bold" aria-hidden />}
          </button>
        ),
      )}
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={className === undefined ? 'action-menu-root' : `action-menu-root ${className}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`chrome-button${triggerActive === true ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={triggerTitle ?? ariaLabel}
        onClick={() => (open ? setOpen(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
            requestAnimationFrame(() => {
              menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
            })
          }
        }}
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            themeVars === undefined ? (
              menu
            ) : (
              <div className="reader-scope" style={themeVars}>
                {menu}
              </div>
            ),
            document.body,
          )
        : null}
    </div>
  )
}

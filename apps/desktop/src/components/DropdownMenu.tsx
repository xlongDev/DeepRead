import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretDown, Check } from '@phosphor-icons/react'

export interface DropdownOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly hint?: string
}

interface DropdownMenuProps<T extends string> {
  readonly value: T
  readonly options: readonly DropdownOption<T>[]
  readonly onChange: (value: T) => void
  readonly ariaLabel: string
  readonly className?: string
  /** 触发器上的原生 title:补充说明(生效时机等),不占视觉。 */
  readonly title?: string
  /** 自定义触发器内容(默认渲染当前值 + 箭头)。 */
  readonly children?: React.ReactNode
  /**
   * 调用方主题变量(阅读场景传 readerVars):portal 到 body 后菜单就离开了
   * 调用方的 CSS 作用域,`.reader .dropdown-menu` 那套主题规则全部失配,
   * 菜单会回落全局暗色 —— 在羊皮纸背景下就是一块深色补丁。带上变量壳,
   * 壳内重新挂上这些变量,规则照常命中(与 TTS 播放器 portal 同款做法)。
   */
  readonly themeVars?: React.CSSProperties
}

/** 菜单浮层的 z-index:压在一切 chrome(40)与设置面板(45)之上。 */
const MENU_Z_INDEX = 60

/**
 * 自绘下拉:原生 <select> 在玻璃面板里无法统一视觉,这里用按钮 + 弹层实现,
 * 键盘(Esc/方向键/点击外部)与 aria 语义保留。
 *
 * 弹层 portal 到 body 并用 fixed 定位:调用方容器(设置面板、抽屉)常带
 * overflow 与 backdrop-filter —— absolute 的菜单会被裁掉一半,fixed 也会
 * 被这些属性收编成相对容器定位。portal 出去两头都躲掉。
 */
export function DropdownMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  title,
  children,
  themeVars,
}: DropdownMenuProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const openMenu = (): void => {
    setOpen(true)
  }

  // 挂载后定位:下方不够且上方更宽裕时翻上去,右侧超出视口时左移。
  // 位置直接写 DOM(effect 的本职),不落 state —— layout effect 在绘制前
  // 跑完,portal 首帧即落位,不闪;React Compiler 也不用为它多渲染一轮。
  useLayoutEffect(() => {
    const menu = menuRef.current
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!open || !menu || !rect) return
    const below = window.innerHeight - rect.bottom - 8
    const flip = menu.offsetHeight + 8 > below && rect.top - 8 > below
    const top = flip ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))
    // 菜单至少与触发器同宽:portal 之后 CSS 的 100% 解析自 body,得手量。
    const minWidth = Math.max(200, Math.min(rect.width, window.innerWidth - 16))
    Object.assign(menu.style, {
      top: `${top}px`,
      left: `${left}px`,
      minWidth: `${minWidth}px`,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      // 菜单已 portal 出去,rootRef 不再包含它 —— 两个容器都要查,
      // 否则点选项时先被外面点击 logic 关掉,click 永远落不到选项上。
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      // 方向键在选项间移动焦点;端点处环绕,Home/End 跳首尾。
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
      )
      if (items.length === 0) return
      event.preventDefault()
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next =
        currentIndex === -1
          ? event.key === 'ArrowDown'
            ? 0
            : items.length - 1
          : (currentIndex + delta + items.length) % items.length
      items[next]?.focus()
    }
    // 容器滚动(设置面板自己可滚)时菜单不跟着走会脱节,直接收。
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
  }, [open])

  const current = options.find((option) => option.value === value)

  const menu = (
    <div
      ref={menuRef}
      className="dropdown-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        zIndex: MENU_Z_INDEX,
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={option.value === value}
          className={`dropdown-option${option.value === value ? ' is-active' : ''}`}
          onClick={() => {
            onChange(option.value)
            setOpen(false)
          }}
        >
          <span className="dropdown-option-label">
            {option.label}
            {option.hint && <span className="dropdown-hint">{option.hint}</span>}
          </span>
          {option.value === value && <Check size={13} weight="bold" aria-hidden />}
        </button>
      ))}
    </div>
  )

  return (
    <div ref={rootRef} className={`dropdown${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`dropdown-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          // 触发器上按 ↓ 直接打开并聚焦第一项。
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            openMenu()
            requestAnimationFrame(() => {
              menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
            })
          }
        }}
      >
        {children ?? (
          <span className="dropdown-value">{current?.label ?? options[0]?.label ?? ''}</span>
        )}
        <CaretDown size={11} weight="bold" aria-hidden />
      </button>
      {open
        ? createPortal(
            themeVars ? (
              <div className="reader-scope" style={themeVars}>
                {menu}
              </div>
            ) : (
              menu
            ),
            document.body,
          )
        : null}
    </div>
  )
}

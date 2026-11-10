import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretDown, Check } from '@phosphor-icons/react'
import { useMenuPosition } from './use-menu-position'

export interface DropdownOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly hint?: string
  /** 选项前的色样(任意 CSS background 值)。配色主题用它显示整套渐变。 */
  readonly swatch?: string
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

  // 落位逻辑与 ActionMenu 共用一份:同一个界面里的两个菜单必须遵守同一套
  // 翻转 / 夹边规则,否则一个向下弹、一个探出屏幕。
  useMenuPosition(open, triggerRef, menuRef)

  useEffect(() => {
    if (!open) return
    // 列表可滚(配色主题有 16 项、上限 260px):打开时把当前值带进视野,
    // 否则选了靠后的方案以后,每次点开都只看到前八项、勾在视野外。
    // jsdom 没有实现 scrollIntoView,守卫不能省。
    const checked = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (typeof checked?.scrollIntoView === 'function') {
      checked.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
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
    // 但菜单**自己**的滚动不算:配色主题有 16 项,列表一滚就关菜单的话,
    // 后面那几项永远够不到(max-height + overflow 等于白写)。
    const onScrollOrResize = (event: Event): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target) === true) {
        return
      }
      setOpen(false)
    }
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
            {option.swatch !== undefined && (
              <span
                className="dropdown-option-swatch"
                style={{ background: option.swatch }}
                aria-hidden
              />
            )}
            {option.label}
            {option.hint && <span className="dropdown-hint">{option.hint}</span>}
          </span>
          {option.value === value && <Check size={14} weight="bold" aria-hidden />}
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
        <CaretDown size={14} weight="bold" aria-hidden />
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

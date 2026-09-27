import { useEffect, useRef, useState } from 'react'
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
  /** 自定义触发器内容(默认渲染当前值 + 箭头)。 */
  readonly children?: React.ReactNode
}

/**
 * 自绘下拉:原生 <select> 在玻璃面板里无法统一视觉,这里用按钮 + 弹层实现,
 * 键盘(Esc/方向键/点击外部)与 aria 语义保留。
 */
export function DropdownMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  children,
}: DropdownMenuProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
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
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = options.find((option) => option.value === value)

  return (
    <div ref={rootRef} className={`dropdown${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`dropdown-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((openState) => !openState)}
        onKeyDown={(event) => {
          // 触发器上按 ↓ 直接打开并聚焦第一项。
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
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
      {open && (
        <div ref={menuRef} className="dropdown-menu" role="menu" aria-label={ariaLabel}>
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
      )}
    </div>
  )
}

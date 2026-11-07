import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { handleTablistKeys } from './tablist-keys'

const LABELS = ['外观', '快捷键', 'AI 服务', '备份与更新'] as const

/** 照抄真实形态:tablist 容器挂 handler,只有选中项留在 Tab 顺序里。 */
function Fixture({
  onSelect,
  initial = 0,
}: {
  readonly onSelect: (index: number) => void
  readonly initial?: number
}) {
  const [active, setActive] = useState(initial)
  return (
    <div
      role="tablist"
      aria-label="测试分区"
      tabIndex={-1}
      onKeyDown={(event) => {
        handleTablistKeys(event, (index) => {
          onSelect(index)
          setActive(index)
        })
      }}
    >
      {LABELS.map((label, index) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={active === index}
          tabIndex={active === index ? 0 : -1}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

describe('handleTablistKeys(WAI-ARIA tabs 键盘模式)', () => {
  it('→ 切到下一项,焦点与 aria-selected / roving tabindex 一起走', () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} />)
    const tabs = screen.getAllByRole('tab')
    tabs[0]!.focus()

    expect(fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })).toBe(false) // 已 preventDefault
    expect(onSelect).toHaveBeenLastCalledWith(1)
    expect(tabs[1]).toHaveFocus()
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('tabindex', '0')
  })

  it('← 从首项循环到末项', () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} />)
    const tabs = screen.getAllByRole('tab')
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith(3)
    expect(tabs[3]).toHaveFocus()
  })

  it('Home / End 直达首尾', () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} initial={1} />)
    const tabs = screen.getAllByRole('tab')

    fireEvent.keyDown(tabs[1]!, { key: 'End' })
    expect(onSelect).toHaveBeenLastCalledWith(3)
    expect(tabs[3]).toHaveFocus()

    fireEvent.keyDown(tabs[3]!, { key: 'Home' })
    expect(onSelect).toHaveBeenLastCalledWith(0)
    expect(tabs[0]).toHaveFocus()
  })

  it('其它键原样放行:不吞 Tab、不切页签', () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} />)
    const tabs = screen.getAllByRole('tab')
    expect(fireEvent.keyDown(tabs[0]!, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(tabs[0]!, { key: 'a' })).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('截断冒泡:window 上的方向键监听收不到(阅读器拿 ←→ 翻页)', () => {
    const onWindow = vi.fn()
    window.addEventListener('keydown', onWindow)
    try {
      render(<Fixture onSelect={vi.fn()} />)
      fireEvent.keyDown(screen.getAllByRole('tab')[0]!, { key: 'ArrowRight' })
      expect(onWindow).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindow)
    }
  })

  it('容器里没有页签时什么都不做', () => {
    const onSelect = vi.fn()
    render(
      <div
        role="tablist"
        tabIndex={-1}
        onKeyDown={(event) => handleTablistKeys(event, onSelect)}
      />,
    )
    expect(fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

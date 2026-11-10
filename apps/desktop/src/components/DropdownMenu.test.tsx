// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu } from './DropdownMenu'

afterEach(cleanup)

const OPTIONS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
] as const

const openMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: '测试下拉' }))
}

describe('DropdownMenu', () => {
  it('菜单自身滚动不收起,页面滚动才收起', () => {
    render(<DropdownMenu ariaLabel="测试下拉" value="a" options={OPTIONS} onChange={() => {}} />)
    openMenu()
    const menu = document.querySelector('.dropdown-menu')
    expect(menu).not.toBeNull()

    // 16 项配色主题靠菜单自己滚动才够得到后面的选项:内部滚动被当成
    // 「页面滚走了」而关掉菜单,等于把 max-height + overflow 白写。
    fireEvent.scroll(menu as Element)
    expect(document.querySelector('.dropdown-menu')).not.toBeNull()

    // 容器滚动时菜单会与触发器脱节,必须收起。
    fireEvent.scroll(window)
    expect(document.querySelector('.dropdown-menu')).toBeNull()
  })

  it('打开时把当前选中项滚进可视区', () => {
    // jsdom 没实现 scrollIntoView,打桩才能断言它被调用过。
    const spy = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = spy
    try {
      render(<DropdownMenu ariaLabel="测试下拉" value="b" options={OPTIONS} onChange={() => {}} />)
      openMenu()
      expect(spy).toHaveBeenCalled()
      // 滚的是选中项,不是菜单容器。
      const checked = document.querySelector('.dropdown-option[aria-checked="true"]')
      expect(spy.mock.contexts[0]).toBe(checked)
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('选项前的色标按 swatch 渲染,没给就不占位', () => {
    render(
      <DropdownMenu
        ariaLabel="测试下拉"
        value="a"
        options={[{ value: 'a', label: '甲', swatch: 'linear-gradient(90deg, #000, #fff)' }]}
        onChange={() => {}}
      />,
    )
    openMenu()
    expect(document.querySelectorAll('.dropdown-option-swatch')).toHaveLength(1)
  })
})

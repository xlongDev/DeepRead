// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FootnotePopup } from './FootnotePopup'

describe('FootnotePopup(脚注弹层)', () => {
  it('把内核二级视图挂进正文区,按类型给标题', () => {
    const view = document.createElement('foliate-view')
    render(<FootnotePopup view={view} type="endnote" onClose={vi.fn()} />)
    const host = document.querySelector('.footnote-popup-body')
    expect(host?.contains(view)).toBe(true)
    expect(screen.getByText('尾注')).toBeInTheDocument()
  })

  it('未知类型回落「脚注」,不显示英文标签', () => {
    const view = document.createElement('foliate-view')
    render(<FootnotePopup view={view} type={null} onClose={vi.fn()} />)
    expect(screen.getByText('脚注')).toBeInTheDocument()
  })

  it('Esc 与关闭按钮都会回调 onClose', async () => {
    const onClose = vi.fn()
    const view = document.createElement('foliate-view')
    render(<FootnotePopup view={view} type={null} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('卸载时把内核视图元素摘下来(不残留上次弹层的节点)', () => {
    const view = document.createElement('foliate-view')
    const { unmount } = render(<FootnotePopup view={view} type={null} onClose={vi.fn()} />)
    expect(document.querySelector('.footnote-popup-body')?.contains(view)).toBe(true)
    unmount()
    expect(view.parentElement).toBeNull()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandBar } from './CommandBar'

function setup() {
  const props = {
    books: [],
    onClose: vi.fn(),
    onOpenBook: vi.fn(),
    onView: vi.fn(),
    onImport: vi.fn(),
    onSettings: vi.fn(),
    onSync: vi.fn(),
    onTheme: vi.fn(),
  }
  render(<CommandBar {...props} />)
  return props
}

describe('CommandBar', () => {
  it('把焦点交给输入框,并列出跳转 / 操作 / 外观三组命令', () => {
    setup()
    expect(screen.getByLabelText('搜索书名或命令')).toHaveFocus()
    expect(screen.getByText('跳转')).toBeInTheDocument()
    expect(screen.getByText('操作')).toBeInTheDocument()
    expect(screen.getByText('外观')).toBeInTheDocument()
  })

  it('输入即过滤,Enter 执行当前命令并关闭', () => {
    const props = setup()
    fireEvent.change(screen.getByLabelText('搜索书名或命令'), { target: { value: '统计' } })
    expect(screen.queryByText('导入书籍')).toBeNull()
    fireEvent.keyDown(screen.getByLabelText('命令栏'), { key: 'Enter' })
    expect(props.onView).toHaveBeenCalledWith('stats')
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('Esc 只关闭,不执行任何命令', () => {
    const props = setup()
    fireEvent.keyDown(screen.getByLabelText('命令栏'), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onView).not.toHaveBeenCalled()
  })
})

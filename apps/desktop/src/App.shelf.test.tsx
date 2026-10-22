import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@deepread/shared'
import { App } from './App'
import { invokeCommand } from './lib/ipc'

/**
 * 回归:退到书架听书时窗口不能只剩一层空壳。
 *
 * 曾经的实现是「书架 / 阅读器」二选一 —— `book !== null` 就只渲染那个
 * `hidden` 的阅读器,于是「听书在播 → 返回书架」把阅读器藏起来的同时
 * 也把书架挡在了外面:整窗口一层内容都没有,深色下就是黑屏。
 *
 * 这里把两块屏幕都换成探针:书架是个「开书」按钮,阅读器是个能回报
 * 自己是否 hidden 的按钮 —— 断言的是 App 的渲染决策,不是两块的内部实现。
 */

vi.mock('./lib/ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriRuntime: vi.fn((): boolean => true),
}))

vi.mock('./features/library/LibraryScreen', () => ({
  LibraryScreen: ({ onOpenBook }: { onOpenBook: (book: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onOpenBook({ bookId: 'book-1', format: 'epub', hash: 'hash-1', name: '夜航书', url: '/b' })
      }
    >
      开书
    </button>
  ),
}))

vi.mock('./features/reader/ReaderScreen', () => ({
  ReaderScreen: ({
    onBack,
    hidden,
  }: {
    onBack: (ttsPlaying: boolean) => void
    hidden?: boolean
  }) => (
    <div data-testid="reader" data-hidden={String(hidden === true)}>
      <button type="button" onClick={() => onBack(true)}>
        返架(听书在播)
      </button>
      <button type="button" onClick={() => onBack(false)}>
        返架(没在播)
      </button>
    </div>
  ),
}))

const invokeCommandMock = vi.mocked(invokeCommand)

const appInfo: AppInfo = { appName: 'DeepRead', appVersion: '0.2.0', os: 'macos', arch: 'aarch64' }

beforeEach(() => {
  invokeCommandMock.mockReset()
  invokeCommandMock.mockResolvedValue(appInfo)
})

describe('App 书架与阅读器的叠加关系', () => {
  it('听书在播时退到书架:书架要在场,阅读器只是隐藏', () => {
    render(<App />)
    expect(screen.queryByTestId('reader')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '开书' }))
    expect(screen.getByTestId('reader')).toHaveAttribute('data-hidden', 'false')

    fireEvent.click(screen.getByRole('button', { name: '返架(听书在播)' }))
    // 关键断言:书架回来了,阅读器还活着(播放不中断)。
    expect(screen.getByRole('button', { name: '开书' })).toBeInTheDocument()
    expect(screen.getByTestId('reader')).toHaveAttribute('data-hidden', 'true')
  })

  it('没在播时退到书架:阅读器卸载,收掉整本书的内存', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '开书' }))
    fireEvent.click(screen.getByRole('button', { name: '返架(没在播)' }))

    expect(screen.queryByTestId('reader')).toBeNull()
    expect(screen.getByRole('button', { name: '开书' })).toBeInTheDocument()
  })
})

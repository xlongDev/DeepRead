// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('../../lib/ipc', () => ({ invokeCommand: (...args: unknown[]) => invokeMock(...args) }))

import { OpdsDrawer, downloadScore } from './OpdsDrawer'

beforeEach(() => {
  invokeMock.mockReset()
  localStorage.clear()
})
afterEach(cleanup)

describe('downloadScore', () => {
  it('epub 优先于 mobi,pdf 压纯文本,未知垫底', () => {
    expect(downloadScore('/a.epub', 'application/epub+zip')).toBeGreaterThan(
      downloadScore('/a.mobi', 'application/x-mobipocket-ebook'),
    )
    expect(downloadScore('/a.mobi', null)).toBeGreaterThan(
      downloadScore('/a.pdf', 'application/pdf'),
    )
    expect(downloadScore('/a.txt', 'text/plain')).toBeGreaterThan(downloadScore('/a', null))
  })
})

const CATALOG = {
  title: '夜航书源',
  entries: [
    {
      title: '夜航书',
      author: '北岛',
      summary: null,
      coverUrl: null,
      downloads: [
        { href: '/files/night.pdf', kind: 'application/pdf' },
        { href: '/files/night.epub', kind: 'application/epub+zip' },
      ],
    },
  ],
  nextUrl: null,
}

describe('OpdsDrawer', () => {
  it('浏览目录后条目上屏,导入选 epub(pdf 也在场)且走完 下载→导入 两跳', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'opds.fetch') return Promise.resolve(CATALOG)
      if (command === 'opds.download') return Promise.resolve({ path: '/tmp/night.epub' })
      if (command === 'library.import') return Promise.resolve({ book: {} })
      return Promise.resolve({})
    })
    const onImported = vi.fn()
    render(<OpdsDrawer onImported={onImported} onClose={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('https://example.com/opds'), {
      target: { value: 'https://example.com/opds' },
    })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))

    expect(await screen.findByText('夜航书源')).toBeDefined()
    expect(screen.getByText('夜航书')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '导入' }))

    await waitFor(() => expect(screen.getByText('《夜航书》已导入书架。')).toBeDefined())
    // 下载的是 epub(偏好最高),不是排在前面的 pdf。
    expect(invokeMock).toHaveBeenCalledWith('opds.download', { url: '/files/night.epub' })
    expect(invokeMock).toHaveBeenCalledWith('library.import', { path: '/tmp/night.epub' })
    expect(onImported).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '已导入' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('目录打不开时错误有终态,不留在「浏览中」', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'opds.fetch') return Promise.reject(new Error('连不上'))
      return Promise.resolve({})
    })
    render(<OpdsDrawer onImported={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('https://example.com/opds'), {
      target: { value: 'https://example.com/opds' },
    })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连不上'))
    expect((screen.getByRole('button', { name: '浏览目录' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

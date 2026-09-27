import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@deepread/shared'
import { App } from './App'
import { invokeCommand } from './lib/ipc'

vi.mock('./lib/ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriRuntime: vi.fn((): boolean => true),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (): Promise<() => void> => () => {}),
  }),
}))

const invokeCommandMock = vi.mocked(invokeCommand)

const appInfo: AppInfo = {
  appName: 'Deepread',
  appVersion: '0.2.0',
  os: 'macos',
  arch: 'aarch64',
}

const shelfBook = {
  hash: 'a'.repeat(64),
  fileName: '夜航书.epub',
  displayName: null,
  format: 'epub',
  path: '/books/夜航书.epub',
  size: 2391,
  addedAt: '2026-09-09T00:00:00Z',
}

beforeEach(() => {
  invokeCommandMock.mockReset()
  invokeCommandMock.mockImplementation((command) => {
    if (command === 'library.list') {
      return Promise.resolve({ books: [shelfBook] })
    }
    return Promise.resolve(appInfo)
  })
})

describe('App library screen', () => {
  it('shows the import action, shelf books and backend info', async () => {
    render(<App />)
    expect(await screen.findByRole('button', { name: '导入书籍' })).toBeInTheDocument()
    expect((await screen.findAllByText('夜航书')).length).toBeGreaterThan(0)
    expect(await screen.findByText(/Deepread 0\.2\.0/)).toBeInTheDocument()
    expect(invokeCommandMock).toHaveBeenCalledWith('library.list', undefined)
  })

  it('rejects unsupported files with an honest message instead of failing silently', async () => {
    render(<App />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'unknown.xyz', { type: 'application/octet-stream' })
    // fireEvent bypasses user-event's `accept` validation: the point of this
    // test is exactly that a file the accept list does not mention is rejected.
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时不认识这个文件格式')
  })
})

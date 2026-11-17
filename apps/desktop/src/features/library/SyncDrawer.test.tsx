// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('../../lib/ipc', () => ({ invokeCommand: (...args: unknown[]) => invokeMock(...args) }))
const runSyncMock = vi.fn()
vi.mock('../../lib/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sync')>()),
  runSync: (...args: unknown[]) => runSyncMock(...args),
}))

import { SyncDrawer } from './SyncDrawer'
import { AUTO_SYNC_STORAGE_KEY } from '../../lib/sync'

beforeEach(() => {
  invokeMock.mockReset()
  runSyncMock.mockReset()
  localStorage.clear()
  invokeMock.mockImplementation((command: string) => {
    if (command === 'cloud.config.get') {
      return Promise.resolve({
        config: { endpoint: 'https://dav.example.com', username: '阿岚' },
        deviceName: '书房',
        deviceId: 'device-uuid-1234',
      })
    }
    return Promise.resolve({ config: null })
  })
})
afterEach(cleanup)

const renderDrawer = (): ReturnType<typeof render> =>
  render(<SyncDrawer onRestored={vi.fn()} onClose={vi.fn()} />)

describe('SyncDrawer', () => {
  it('配置在场时展示设备身份与全部动作', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('阿岚 · https://dav.example.com')).toBeDefined())
    expect(screen.getByText(/书房/)).toBeDefined()
    expect(screen.getByRole('button', { name: '备份数据库' })).toBeDefined()
    expect(screen.getByRole('button', { name: '从云端恢复' })).toBeDefined()
    expect(screen.getByRole('button', { name: '退出' })).toBeDefined()
  })

  it('恢复是两击确认:首击不触发 cloud.restore,二击执行并回执书架', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cloud.config.get') {
        return Promise.resolve({
          config: { endpoint: 'https://dav.example.com', username: '阿岚' },
          deviceName: '书房',
          deviceId: 'device-uuid-1234',
        })
      }
      return Promise.resolve({})
    })
    const onRestored = vi.fn()
    render(<SyncDrawer onRestored={onRestored} onClose={vi.fn()} />)
    const restore = await screen.findByRole('button', { name: '从云端恢复' })
    fireEvent.click(restore)
    // 首击:进待确认态,不发命令。
    expect(screen.getByRole('button', { name: '确认覆盖本机?' })).toBeDefined()
    expect(invokeMock).not.toHaveBeenCalledWith('cloud.restore', undefined)
    fireEvent.click(screen.getByRole('button', { name: '确认覆盖本机?' }))
    await waitFor(() => expect(screen.getByText('已从云端备份恢复。')).toBeDefined())
    expect(invokeMock).toHaveBeenCalledWith('cloud.restore', undefined)
    expect(onRestored).toHaveBeenCalledTimes(1)
  })

  it('备份失败要有明确的错误终态,不吞进「还没有消息」', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cloud.config.get') {
        return Promise.resolve({
          config: { endpoint: 'https://dav.example.com', username: '阿岚' },
          deviceName: '书房',
          deviceId: 'device-uuid-1234',
        })
      }
      if (command === 'cloud.backup') return Promise.reject(new Error('磁盘满了'))
      return Promise.resolve({})
    })
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: '备份数据库' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('磁盘满了'))
    // busy 复位:动作按钮重新可点。
    expect((screen.getByRole('button', { name: '备份数据库' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('自动同步开关落 localStorage,与书架侧静默同步读同一个键', async () => {
    renderDrawer()
    const toggle = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(localStorage.getItem(AUTO_SYNC_STORAGE_KEY)).toBeNull()
    // 默认开启(isAutoSyncEnabled 对缺省键回 true),首击先关。
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(localStorage.getItem(AUTO_SYNC_STORAGE_KEY)).toBe('off')
    fireEvent.click(toggle)
    expect(localStorage.getItem(AUTO_SYNC_STORAGE_KEY)).toBe('on')
  })

  it('同步完成但带冲突时,消息要明说冲突数量', async () => {
    runSyncMock.mockResolvedValue({
      syncedAt: '2026-11-18T00:00:00Z',
      bookCount: 2,
      pushed: 1,
      pulled: 1,
      conflicts: [{ id: 'c1', entityType: 'progress', localVersion: 1, remoteVersion: 2 }],
    })
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    await waitFor(() => expect(screen.getByText('同步完成,有 1 处冲突需要留意。')).toBeDefined())
    expect(screen.getByText(/阅读进度\s*冲突/)).toBeDefined()
  })
})

import { useCallback, useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { toAppError, type CloudConfigGetResponse } from '@deepread/shared'
import { invokeCommand } from '../../lib/ipc'
import { runSync, type SyncReport } from '../../lib/sync'

interface SyncDrawerProps {
  /** Refresh the shelf after a WebDAV restore replaced the database. */
  readonly onRestored: () => void
  readonly onClose: () => void
}

export function SyncDrawer({ onRestored, onClose }: SyncDrawerProps) {
  const [config, setConfig] = useState<CloudConfigGetResponse | null>(null)
  const [form, setForm] = useState({ endpoint: '', username: '', password: '' })
  const [busy, setBusy] = useState<'test' | 'save' | 'sync' | 'backup' | 'restore' | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invokeCommand('cloud.config.get', undefined)
      .then((response) => {
        setConfig(response)
        setForm((current) => ({
          ...current,
          endpoint: response.config?.endpoint ?? '',
          username: response.config?.username ?? '',
        }))
      })
      .catch((loadError) => setError(toAppError(loadError).message))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const withBusy = useCallback(
    async (kind: NonNullable<typeof busy>, action: () => Promise<void>): Promise<void> => {
      setBusy(kind)
      setError(null)
      setMessage(null)
      try {
        await action()
      } catch (actionError) {
        setError(toAppError(actionError).message)
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const save = (): Promise<void> =>
    withBusy('save', async () => {
      const response = await invokeCommand('cloud.config.save', {
        endpoint: form.endpoint.trim(),
        username: form.username.trim(),
        password: form.password.trim(),
      })
      setConfig((current) => (current ? { ...current, config: response.config } : current))
      setForm((current) => ({ ...current, password: '' }))
      setMessage('已保存。密钥存入系统钥匙串。')
    })

  const test = (): Promise<void> =>
    withBusy('test', async () => {
      await invokeCommand('cloud.config.test', {
        endpoint: form.endpoint.trim(),
        username: form.username.trim(),
        password: form.password.trim(),
      })
      setMessage('连接成功。')
    })

  const syncNow = (): Promise<void> =>
    withBusy('sync', async () => {
      const result = await runSync()
      setReport(result)
      setMessage(
        result.conflicts.length > 0
          ? `同步完成,有 ${result.conflicts.length} 处冲突需要留意。`
          : '同步完成。',
      )
    })

  const backup = (): Promise<void> =>
    withBusy('backup', async () => {
      const response = await invokeCommand('cloud.backup', undefined)
      setMessage(`已备份(${(response.bytes / 1024 / 1024).toFixed(1)} MB)。`)
    })

  const restore = (): Promise<void> =>
    withBusy('restore', async () => {
      if (!window.confirm('将从云端备份恢复整个数据库,本机现有的进度与批注会被覆盖。继续?')) {
        return
      }
      await invokeCommand('cloud.restore', undefined)
      setMessage('已从云端备份恢复。')
      onRestored()
    })

  const logout = (): Promise<void> =>
    withBusy('save', async () => {
      await invokeCommand('cloud.config.clear', undefined)
      setConfig((current) => (current ? { ...current, config: null } : current))
      setReport(null)
      setMessage('已退出云同步(本机数据不受影响)。')
    })

  return (
    <aside className="ai-drawer sync-drawer" aria-label="云同步">
      <div className="lookup-head">
        <strong>云同步(WebDAV)</strong>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={16} weight="regular" aria-hidden />
        </button>
      </div>

      <div className="ai-drawer-body">
        <div className="ai-config">
          <input
            className="ai-input"
            placeholder="WebDAV 地址,如 https://dav.jianguoyun.com/dav"
            value={form.endpoint}
            onChange={(event) =>
              setForm((current) => ({ ...current, endpoint: event.target.value }))
            }
          />
          <input
            className="ai-input"
            placeholder="用户名"
            autoComplete="off"
            value={form.username}
            onChange={(event) =>
              setForm((current) => ({ ...current, username: event.target.value }))
            }
          />
          <input
            className="ai-input"
            type="password"
            placeholder={config?.config ? '密码(留空则沿用已存的)' : '密码(存入系统钥匙串)'}
            autoComplete="new-password"
            value={form.password}
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
          />
          <div className="segmented">
            <button type="button" disabled={busy !== null} onClick={() => void test()}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              disabled={busy !== null || form.endpoint.trim() === '' || form.username.trim() === ''}
              onClick={() => void save()}
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
          </div>
        </div>

        {config?.config && (
          <>
            <p className="ai-privacy">
              已登录 {config.config.username}({config.config.endpoint});本机设备:{config.deviceName}
              ({config.deviceId.slice(0, 11)}…)。
            </p>
            <div className="segmented">
              <button type="button" disabled={busy !== null} onClick={() => void syncNow()}>
                {busy === 'sync' ? '同步中…' : '立即同步'}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void backup()}>
                {busy === 'backup' ? '备份中…' : '备份数据库'}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void restore()}>
                {busy === 'restore' ? '恢复中…' : '从云端恢复'}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void logout()}>
                退出
              </button>
            </div>
            <p className="ai-privacy">
              同步内容:阅读进度、批注、书签与书架元数据;书籍文件不会上传。批注按记录合并,进度取最新;冲突保留双方并在此提示。
            </p>
            {report && (
              <div className="sync-report">
                <p className="settings-section-label">
                  上次同步 {new Date(report.syncedAt).toLocaleString()}
                </p>
                <p className="ai-privacy">
                  {report.bookCount} 本书 · 推送 {report.pushed} 项 · 拉取 {report.pulled} 项 · 冲突{' '}
                  {report.conflicts.length} 处
                </p>
                {report.conflicts.map((conflict) => (
                  <div key={conflict.id} className="conflict-item">
                    <p className="conflict-title">
                      {conflict.entityType === 'progress'
                        ? '阅读进度'
                        : conflict.entityType === 'bookmark'
                          ? '书签'
                          : '批注'}{' '}
                      冲突(已保留双方)
                    </p>
                    <p className="ai-privacy">
                      本机 {new Date(conflict.localVersion).toLocaleString()} · 云端{' '}
                      {new Date(conflict.remoteVersion).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {message !== null && <p className="ai-privacy">{message}</p>}
        {error !== null && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </aside>
  )
}

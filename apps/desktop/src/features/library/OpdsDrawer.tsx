import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { toAppError, type OpdsEntry } from '@deepread/shared'
import { invokeCommand } from '../../lib/ipc'
import { useDrawerFocus } from '../../lib/modal-dialog'

const SOURCE_URL_KEY = 'deepread.opds.source'

interface OpdsDrawerProps {
  /** A source was browsed and a book landed in the shelf; refresh it. */
  readonly onImported: () => void
  readonly onClose: () => void
}

type Busy = 'browse' | 'next' | 'import' | null

/** 下载格式偏好:epub 优先(封面/目录元数据最全),pdf 次之,纯文本垫底。 */
export function downloadScore(href: string, kind: string | null | undefined): number {
  const link = href.toLowerCase()
  const type = (kind ?? '').toLowerCase()
  if (type.includes('epub') || link.endsWith('.epub')) return 6
  if (type.includes('mobi') || link.endsWith('.mobi') || link.endsWith('.azw3')) return 5
  if (type.includes('fb2')) return 4
  if (type.includes('cbz')) return 3
  if (type.includes('pdf')) return 2
  if (type.includes('text') || link.endsWith('.txt') || link.endsWith('.md')) return 1
  return 0
}

export function OpdsDrawer({ onImported, onClose }: OpdsDrawerProps) {
  const [url, setUrl] = useState(() => localStorage.getItem(SOURCE_URL_KEY) ?? '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [title, setTitle] = useState<string | null>(null)
  const [entries, setEntries] = useState<readonly OpdsEntry[]>([])
  const [nextUrl, setNextUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<ReadonlySet<string>>(() => new Set())
  const panelRef = useRef<HTMLElement>(null)
  useDrawerFocus(panelRef)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const browse = useCallback(
    async (target: string, kind: Busy): Promise<void> => {
      if (target.trim() === '' || busy !== null) return
      setBusy(kind)
      setError(null)
      setMessage(null)
      try {
        const catalog = await invokeCommand('opds.fetch', {
          url: target.trim(),
          username: username.trim() === '' ? undefined : username.trim(),
          password: password === '' ? undefined : password,
        })
        setTitle(catalog.title)
        // 下一页是追加:同一个目录翻页,条目不互相覆盖。
        setEntries((current) =>
          kind === 'next' ? [...current, ...catalog.entries] : catalog.entries,
        )
        setNextUrl(catalog.nextUrl ?? null)
        localStorage.setItem(SOURCE_URL_KEY, url.trim())
        if (kind !== 'next' && catalog.entries.length === 0) {
          setMessage('目录能打开,但这一页没有可下载的条目。')
        }
      } catch (browseError) {
        setError(toAppError(browseError).message)
      } finally {
        setBusy(null)
      }
    },
    [busy, password, url, username],
  )

  const importEntry = useCallback(
    async (entry: OpdsEntry): Promise<void> => {
      if (busy !== null) return
      const best = [...entry.downloads].sort(
        (a, b) => downloadScore(b.href, b.kind) - downloadScore(a.href, a.kind),
      )[0]
      if (best === undefined) {
        setError(`《${entry.title}》没有可下载的文件链接。`)
        return
      }
      setBusy('import')
      setError(null)
      setMessage(null)
      try {
        const file = await invokeCommand('opds.download', {
          url: best.href,
          username: username.trim() === '' ? undefined : username.trim(),
          password: password === '' ? undefined : password,
        })
        await invokeCommand('library.import', { path: file.path })
        setImported((current) => new Set([...current, entry.title]))
        setMessage(`《${entry.title}》已导入书架。`)
        onImported()
      } catch (importError) {
        setError(toAppError(importError).message)
      } finally {
        setBusy(null)
      }
    },
    [busy, onImported, password, username],
  )

  return (
    <aside ref={panelRef} className="ai-drawer sync-drawer opds-drawer" aria-label="添加书源">
      <div className="lookup-head">
        <strong>添加书源(OPDS)</strong>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={16} weight="regular" aria-hidden />
        </button>
      </div>
      <div className="ai-drawer-body">
        <div className="sync-fields">
          <label className="field-label">
            目录地址
            <input
              className="field-input"
              placeholder="https://example.com/opds"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void browse(url, 'browse')
              }}
            />
          </label>
          <label className="field-label">
            账户(可选)
            <input
              className="field-input"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field-label">
            密码(可选)
            <input
              className="field-input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="sync-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || url.trim() === ''}
              onClick={() => void browse(url, 'browse')}
            >
              {busy === 'browse' ? '浏览中…' : '浏览目录'}
            </button>
          </div>
        </div>

        {title !== null && <p className="settings-section-label">{title}</p>}
        <div className="opds-entries">
          {entries.map((entry) => (
            <div key={`${entry.title}-${entry.downloads[0]?.href ?? ''}`} className="opds-entry">
              <div className="opds-entry-text">
                <span className="opds-entry-title">{entry.title}</span>
                <span className="opds-entry-meta">
                  {entry.author ?? '佚名'}
                  {entry.downloads.length > 0 && ` · ${entry.downloads.length} 个格式`}
                </span>
              </div>
              <button
                type="button"
                className="btn"
                disabled={busy !== null || imported.has(entry.title)}
                onClick={() => void importEntry(entry)}
              >
                {imported.has(entry.title) ? '已导入' : busy === 'import' ? '下载中…' : '导入'}
              </button>
            </div>
          ))}
          {entries.length > 0 && nextUrl !== null && (
            <button
              type="button"
              className="btn opds-next"
              disabled={busy !== null}
              onClick={() => void browse(nextUrl, 'next')}
            >
              {busy === 'next' ? '加载中…' : '加载下一页'}
            </button>
          )}
        </div>

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

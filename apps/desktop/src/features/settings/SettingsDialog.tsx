/**
 * 设置弹窗:外观 / AI 服务 / 备份与更新三个分区。
 *
 * 从 LibraryScreen 拆出 —— 它原来内联在书架组件里(约 250 行 JSX + 8 块
 * 状态),是书架单文件最大的块。主题值与「恢复后刷新书架」由宿主提供;
 * AI 服务、备份、更新器都是本弹窗私有,自给自足(含浏览器端恢复用的
 * 隐藏 file input —— 它只服务这里的「从备份恢复」)。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkle, X } from '@phosphor-icons/react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { toAppError } from '@deepread/shared'
import { convertFileSrc } from '../../lib/book-import'
import { downloadText } from '../../lib/download'
import { exportSnapshot, importSnapshot, readStorageEstimate } from '../../lib/web-store'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { DropdownMenu } from '../../components/DropdownMenu'
import { SlidingIndicator } from '../../components/SlidingIndicator'
import { AiProviderForm, useAiProviders } from './AiProviderSettings'
import { KeybindingsSettings } from './KeybindingsSettings'
import {
  APP_THEMES,
  formatBytes,
  SHELF_COLUMN_OPTIONS,
  type AppTheme,
  type ShelfColumns,
} from '../library/shelf-view'

/** 设置弹窗的分区。顺序即左右位置,切换动画的方向由它推出来。
 *  阅读目标不住这里 —— 它住统计页(目标与进度是同一件事)。 */
const SETTINGS_TABS = ['appearance', 'keys', 'ai', 'data'] as const
type SettingsTab = (typeof SETTINGS_TABS)[number]

/** 已忽略的更新版本:同一版本不再提示。 */
const IGNORED_VERSION_KEY = 'deepread.update.ignored'

interface SettingsDialogProps {
  readonly appTheme: AppTheme
  readonly onThemeChange: (theme: AppTheme) => void
  /** 网格一行几本;状态归宿主(书架),这里只是它的设置入口。 */
  readonly shelfColumns: ShelfColumns
  readonly onShelfColumns: (value: ShelfColumns) => void
  /** 恢复备份动了本地库之后,宿主要重读书架。 */
  readonly onRestored: () => void
  readonly onClose: () => void
}

export function SettingsDialog({
  appTheme,
  onThemeChange,
  shelfColumns,
  onShelfColumns,
  onRestored,
  onClose,
}: SettingsDialogProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance')
  /** 分区切换方向:滑入动画从哪边进来(SlidingIndicator 的 key 重建配合)。 */
  const [settingsDir, setSettingsDir] = useState<'forward' | 'back'>('forward')
  const changeSettingsTab = (next: SettingsTab): void => {
    if (next === settingsTab) return
    setSettingsDir(
      SETTINGS_TABS.indexOf(next) > SETTINGS_TABS.indexOf(settingsTab) ? 'forward' : 'back',
    )
    setSettingsTab(next)
  }

  const {
    providers,
    loaded: aiLoaded,
    activeId: aiActiveId,
    configForm: aiConfigForm,
    setConfigForm: setAiConfigForm,
    saveProvider: saveAiProvider,
    removeProvider: removeAiProvider,
    error: aiProviderError,
  } = useAiProviders()

  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  /** 浏览器端「从备份恢复」没有对话框可用,走隐藏 file input。 */
  const restoreInputRef = useRef<HTMLInputElement>(null)

  /** 浏览器存储用量;桌面端没有这个概念(书留在用户自己的磁盘上)。 */
  const [storageUsage, setStorageUsage] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    if (isTauriRuntime()) return
    void readStorageEstimate().then(setStorageUsage)
  }, [])

  const runBackup = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      setBackupBusy(true)
      try {
        const { text, bytes, checksum } = await exportSnapshot()
        downloadText(
          `deepread-backup-${new Date().toISOString().slice(0, 10)}.json`,
          text,
          'application/json',
        )
        setBackupMsg(
          `已备份 ${formatBytes(bytes)} · 校验和 ${checksum.slice(0, 12)}…(校验和已写进备份文件)`,
        )
      } catch (backupError) {
        setBackupMsg(toAppError(backupError).message)
      } finally {
        setBackupBusy(false)
      }
      return
    }
    const path = await save({
      defaultPath: `deepread-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite 备份', extensions: ['db'] }],
    })
    if (!path) return
    setBackupBusy(true)
    try {
      const response = await invokeCommand('storage.backup', { path })
      setBackupMsg(
        `已备份 ${formatBytes(response.bytes)} · 校验和 ${response.checksum.slice(0, 12)}…`,
      )
    } catch (backupError) {
      setBackupMsg(toAppError(backupError).message)
    } finally {
      setBackupBusy(false)
    }
  }, [])

  /**
   * 恢复一份 web 端备份。
   *
   * 桌面端要旁路读一个 `.sha256` 文件;浏览器端没这回事 —— 校验和就写在备份
   * 文件里(`exportSnapshot` 放进去的),`importSnapshot` 会先对上再动库。
   */
  const restoreBackupFile = useCallback(async (file: File, reload: () => void): Promise<void> => {
    setBackupBusy(true)
    try {
      await importSnapshot(await file.text())
      setBackupMsg('恢复完成:书架、进度与批注已还原。')
      reload()
    } catch (restoreError) {
      setBackupMsg(toAppError(restoreError).message)
    } finally {
      setBackupBusy(false)
    }
  }, [])

  const runRestore = useCallback(async (reload: () => void): Promise<void> => {
    // 浏览器端没有 `open()` 对话框,走隐藏的 file input。
    if (!isTauriRuntime()) {
      restoreInputRef.current?.click()
      return
    }
    const backupPath = await open({
      multiple: false,
      directory: false,
      // .db 是本机 SQLite 快照,.json 是浏览器端导出的那份 —— 后者能被收下,
      // 于是"在浏览器里读的书"可以接着在桌面版读。
      filters: [{ name: '备份文件', extensions: ['db', 'json'] }],
    })
    if (!backupPath || typeof backupPath !== 'string') return
    // JSON 备份没有旁路的 .sha256 文件:它的校验和是内联在文件里的,而 Rust
    // 那边靠 serde 的严格解析兜底(见 import_json_snapshot 的说明)。
    const isBrowserBackup = backupPath.toLowerCase().endsWith('.json')
    let checksum = ''
    if (!isBrowserBackup) {
      const checksumPath = `${backupPath}.sha256`
      try {
        const response = await fetch(convertFileSrc(checksumPath))
        if (response.ok) checksum = (await response.text()).trim()
      } catch {
        // checksum file optional; Rust validates integrity regardless
      }
      if (!checksum) {
        setBackupMsg('未找到校验和文件(.sha256),无法确认备份完整性。')
        return
      }
    }
    setBackupBusy(true)
    try {
      await invokeCommand('storage.restore', { path: backupPath, checksum })
      setBackupMsg('恢复完成:书架、进度与批注已还原。')
      reload()
    } catch (restoreError) {
      setBackupMsg(toAppError(restoreError).message)
    } finally {
      setBackupBusy(false)
    }
  }, [])

  const [update, setUpdate] = useState<Update | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  const checkForUpdates = useCallback(async (): Promise<void> => {
    setUpdateBusy(true)
    setUpdateMsg(null)
    try {
      const ignored = localStorage.getItem(IGNORED_VERSION_KEY)
      const found = await check()
      if (found === null) {
        setUpdate(null)
        setUpdateMsg('当前已是最新版本。')
      } else if (found.version === ignored) {
        setUpdate(null)
        setUpdateMsg(`已忽略版本 ${ignored},同一版本不再提示。`)
      } else {
        setUpdate(found)
        setUpdateMsg(`发现新版本 ${found.version}。`)
      }
    } catch (checkError) {
      // Honest failure (spec §132): no update source configured or offline.
      setUpdateMsg(toAppError(checkError).message)
    } finally {
      setUpdateBusy(false)
    }
  }, [])

  const installUpdate = useCallback(async (): Promise<void> => {
    const found = update
    if (!found) return
    setUpdateBusy(true)
    setUpdateMsg('正在下载并安装,完成后将自动重启…')
    try {
      await found.downloadAndInstall()
      await relaunch()
    } catch (installError) {
      setUpdateMsg(toAppError(installError).message)
      setUpdateBusy(false)
    }
  }, [update])

  const ignoreUpdate = useCallback((): void => {
    if (update) localStorage.setItem(IGNORED_VERSION_KEY, update.version)
    setUpdate(null)
    setUpdateMsg(`已忽略版本 ${update?.version}。`)
  }, [update])

  // Esc 关闭;遮罩不可点,关闭走铺满背景的 dismiss 按钮(键盘可达)。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay">
      {/* 遮罩本身不可点:关闭走这个铺满背景的按钮(键盘可达),面板在上层。 */}
      <button type="button" className="modal-dismiss" aria-label="关闭设置" onClick={onClose} />
      <dialog className="modal-panel" open aria-label="设置">
        <header className="modal-head">
          <strong className="modal-title">设置</strong>
          <button type="button" className="chrome-button" onClick={onClose} title="关闭">
            <X size={14} weight="regular" aria-hidden />
          </button>
        </header>
        <SlidingIndicator
          activeKey={settingsTab}
          className="settings-tabs"
          role="tablist"
          ariaLabel="设置分区"
          activeSelector="button.is-active"
        >
          <button
            type="button"
            className={settingsTab === 'appearance' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('appearance')}
            role="tab"
            aria-selected={settingsTab === 'appearance'}
          >
            外观
          </button>
          <button
            type="button"
            className={settingsTab === 'keys' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('keys')}
            role="tab"
            aria-selected={settingsTab === 'keys'}
          >
            快捷键
          </button>
          <button
            type="button"
            className={settingsTab === 'ai' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('ai')}
            role="tab"
            aria-selected={settingsTab === 'ai'}
          >
            <Sparkle size={13} weight="fill" aria-hidden /> AI 服务
          </button>
          <button
            type="button"
            className={settingsTab === 'data' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('data')}
            role="tab"
            aria-selected={settingsTab === 'data'}
          >
            备份与更新
          </button>
        </SlidingIndicator>

        {/* 分区内容。`key` 让它在换页时重建,滑入动画才会重播;方向跟着
            tab 的相对位置走(往右切 = 从右边进来)。 */}
        <div key={settingsTab} className="settings-body" data-dir={settingsDir}>
          {settingsTab === 'appearance' && (
            <>
              <section className="modal-section">
                <p className="modal-section-label">界面主题</p>
                <div className="theme-grid">
                  {APP_THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      className={`theme-swatch${appTheme === theme.id ? ' is-active' : ''}`}
                      onClick={() => onThemeChange(theme.id)}
                      aria-pressed={appTheme === theme.id}
                    >
                      <span
                        className="theme-swatch-color"
                        style={{ background: theme.swatch, color: theme.ink }}
                      >
                        <span
                          className="theme-swatch-line"
                          style={{ background: theme.ink, opacity: 0.85 }}
                        />
                        <span
                          className="theme-swatch-line"
                          style={{ background: theme.ink, opacity: 0.55 }}
                        />
                        <span
                          className="theme-swatch-line"
                          style={{ background: theme.ink, opacity: 0.35 }}
                        />
                        <span className="theme-swatch-dot" style={{ background: theme.accent }} />
                      </span>
                      {theme.label}
                    </button>
                  ))}
                </div>
              </section>
              <section className="modal-section">
                <p className="modal-section-label">书架偏好(自动保存)</p>
                <div className="settings-shelf-columns">
                  <span className="settings-shelf-columns-label">网格每行书本数</span>
                  <DropdownMenu
                    ariaLabel="每行显示的书本数"
                    value={shelfColumns === 'auto' ? 'auto' : String(shelfColumns)}
                    options={SHELF_COLUMN_OPTIONS}
                    onChange={(value) =>
                      onShelfColumns(value === 'auto' ? 'auto' : (Number(value) as ShelfColumns))
                    }
                    title="自适应按窗口宽度自动安排;固定列数在窄窗口会回落自适应"
                  />
                </div>
                <p className="ai-privacy">
                  排序、视图与列数自动记忆;阅读排版(字号、行距、翻页方式)在阅读器内的 Aa 面板设置。
                </p>
              </section>
            </>
          )}

          {settingsTab === 'keys' && <KeybindingsSettings />}

          {settingsTab === 'ai' && (
            <section className="modal-section">
              <p className="modal-section-label">AI 服务(OpenAI 兼容)</p>
              {/*
               * 浏览器端不给表单。填了也存不下 —— 密钥在那边没有安全的地方
               * 放(IndexedDB 是明文的),而且直连各家 API 会被 CORS 拦下。
               * 与其让用户填完再撞一句「Tauri 运行时不可用」,不如一开始就
               * 说清楚;那也是「点了没反应」和「明确说没有」的区别。
               */}
              {!isTauriRuntime() ? (
                <p className="ai-privacy">
                  AI 助手与云端朗读仅在桌面版提供。浏览器里没有安全存放 API
                  密钥的地方(本地存储是明文的),直连各家服务也会被跨域策略拦下。
                </p>
              ) : (
                <>
                  <AiProviderForm
                    providers={providers}
                    configForm={aiConfigForm}
                    onFormChange={setAiConfigForm}
                    onSave={() => saveAiProvider()}
                    onRemove={removeAiProvider}
                    onApplyPreset={(preset) => {
                      setAiConfigForm((form) => ({
                        ...form,
                        name: preset.label,
                        baseUrl: preset.baseUrl,
                        model: preset.model,
                      }))
                    }}
                    error={aiProviderError}
                  />
                  {aiLoaded && providers.length > 0 && (
                    <p className="ai-privacy">
                      配置好的服务会自动出现在阅读器 AI 助手与云端朗读里;当前生效:{' '}
                      {providers.find((provider) => provider.id === aiActiveId)?.name ?? '未选择'}。
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {settingsTab === 'data' && (
            <>
              <section className="modal-section">
                <p className="modal-section-label">备份与恢复</p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void runBackup()}
                    disabled={backupBusy}
                  >
                    {/* 桌面端要选存到哪;浏览器端直接下载,没有"到哪"这一步。 */}
                    {backupBusy ? '备份中…' : isTauriRuntime() ? '备份到…' : '导出备份'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void runRestore(onRestored)}
                    disabled={backupBusy}
                  >
                    {backupBusy ? '恢复中…' : '从备份恢复…'}
                  </button>
                </div>
                {backupMsg !== null && <p className="library-note">{backupMsg}</p>}
                {/* 浏览器里书是自己存下来的,空间有上限 —— 在"备份"这一格
                    顺带如实告诉用户还剩多少,别等写满了才发现。 */}
                {!isTauriRuntime() && storageUsage !== null && storageUsage.quota > 0 && (
                  <p className="library-note">
                    浏览器已用 {formatBytes(storageUsage.usage)},配额约{' '}
                    {formatBytes(storageUsage.quota)}。
                  </p>
                )}
              </section>
              <section className="modal-section">
                <p className="modal-section-label">更新</p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void checkForUpdates()}
                    disabled={updateBusy}
                  >
                    {updateBusy ? '检查中…' : '检查更新'}
                  </button>
                  {update !== null && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void installUpdate()}
                      disabled={updateBusy}
                    >
                      下载并安装
                    </button>
                  )}
                  {update !== null && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={ignoreUpdate}
                      disabled={updateBusy}
                    >
                      忽略此版本
                    </button>
                  )}
                </div>
                {updateMsg !== null && <p className="library-note">{updateMsg}</p>}
              </section>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn-primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </dialog>

      <input
        ref={restoreInputRef}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void restoreBackupFile(file, onRestored)
        }}
      />
    </div>
  )
}

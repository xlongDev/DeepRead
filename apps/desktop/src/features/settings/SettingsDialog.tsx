/**
 * 设置弹窗:外观 / AI 服务 / 备份与更新三个分区。
 *
 * 从 LibraryScreen 拆出 —— 它原来内联在书架组件里(约 250 行 JSX + 8 块
 * 状态),是书架单文件最大的块。主题值与「恢复后刷新书架」由宿主提供;
 * AI 服务、备份、更新器都是本弹窗私有,自给自足(含浏览器端恢复用的
 * 隐藏 file input —— 它只服务这里的「从备份恢复」)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkle, X } from '@phosphor-icons/react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { toAppError, type OcFerryDiscovery } from '@deepread/shared'
import { convertFileSrc } from '../../lib/book-import'
import { downloadText } from '../../lib/download'
import { exportSnapshot, importSnapshot, readStorageEstimate } from '../../lib/web-store'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { useModalFocus } from '../../lib/modal-dialog'
import { handleTablistKeys } from '../../lib/tablist-keys'
import { DropdownMenu, type DropdownOption } from '../../components/DropdownMenu'
import { SlidingIndicator } from '../../components/SlidingIndicator'
import {
  ACCENT_DEFAULT,
  ACCENT_PRESETS,
  BACKGROUND_SCHEMES,
  accentPreview,
  backgroundAccent,
  backgroundSwatch,
  MOTION_PREFERENCE_OPTIONS,
  type AccentChoice,
  type BackgroundChoice,
  type MotionPreference,
} from '@deepread/design-system'
import { AiProviderForm, useAiProviders } from './AiProviderSettings'
import { KeybindingsSettings } from './KeybindingsSettings'
import {
  APP_THEMES,
  formatBytes,
  SHELF_COLUMN_OPTIONS,
  SHELF_DENSITY_OPTIONS,
  type AppTheme,
  type ShelfColumns,
  type ShelfDensity,
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
  readonly accent: AccentChoice
  readonly onAccentChange: (choice: AccentChoice) => void
  /** 网格一行几本;状态归宿主(书架),这里只是它的设置入口。 */
  readonly shelfColumns: ShelfColumns
  readonly onShelfColumns: (value: ShelfColumns) => void
  readonly shelfDensity: ShelfDensity
  readonly onShelfDensity: (value: ShelfDensity) => void
  /** 界面动效:用户意图(system/reduce);系统偏好不在这里,由原生 @media 判定。 */
  readonly motionPreference: MotionPreference
  readonly onMotionChange: (value: MotionPreference) => void
  /** 界面背景(壁纸):与三世界并列的独立轴,状态归宿主。 */
  readonly background: BackgroundChoice
  readonly onBackgroundChange: (value: BackgroundChoice) => void
  /** 恢复备份动了本地库之后,宿主要重读书架。 */
  readonly onRestored: () => void
  readonly onClose: () => void
}

export function SettingsDialog({
  appTheme,
  onThemeChange,
  accent,
  onAccentChange,
  shelfColumns,
  onShelfColumns,
  shelfDensity,
  onShelfDensity,
  motionPreference,
  onMotionChange,
  background,
  onBackgroundChange,
  onRestored,
  onClose,
}: SettingsDialogProps) {
  const dark = appTheme !== 'pure-white'
  /**
   * 配色主题下拉。首项是纯色桌面:不装主题是默认,15 套渐变都是可选方案。
   * 每项带自己的色标 —— 十四个中文名字读下来记不住谁是青绿谁是靛蓝,
   * 一条渐变直接说清楚,也顺手把「选主题 = 整套换色」这件事说出来。
   * 色标按明暗换一套:深色浮层上浅色档会亮成一排小灯。
   */
  const backgroundOptions = useMemo<readonly DropdownOption<BackgroundChoice>[]>(
    () => [
      { value: 'none', label: '纯色桌面', swatch: 'var(--surface-card)' },
      ...BACKGROUND_SCHEMES.map((scheme) => ({
        value: scheme.id,
        label: scheme.label,
        swatch: backgroundSwatch(scheme.id, dark) ?? 'var(--surface-card)',
      })),
    ],
    [dark],
  )
  /** 「跟随主题」那颗圆就是主题会给出的强调色本身。 */
  const themeAccent = backgroundAccent(background, dark)
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
    detectOcFerry,
    adoptOcFerryModel,
    error: aiProviderError,
  } = useAiProviders()

  /** OC Ferry 是本机转发口:探测只拿模型清单,采用由 Rust 落库并存密钥。 */
  const [ocFerry, setOcFerry] = useState<OcFerryDiscovery | null>(null)
  const [ocFerryModel, setOcFerryModel] = useState('')
  const [ocFerryBusy, setOcFerryBusy] = useState(false)
  const [ocFerryMsg, setOcFerryMsg] = useState<string | null>(null)

  const runDetectOcFerry = async (): Promise<void> => {
    setOcFerryBusy(true)
    setOcFerryMsg(null)
    setOcFerry(null)
    const found = await detectOcFerry()
    if (found !== null) {
      setOcFerry(found)
      setOcFerryModel(found.models[0] ?? '')
      setOcFerryMsg(`已连上 OC Ferry，检测到 ${found.models.length} 个可用模型。`)
    }
    setOcFerryBusy(false)
  }

  const runUseOcFerry = async (): Promise<void> => {
    if (ocFerryModel === '') return
    setOcFerryBusy(true)
    const adopted = await adoptOcFerryModel(ocFerryModel)
    setOcFerryMsg(adopted ? `已启用「${ocFerryModel}」，AI 助手与云端朗读即刻生效。` : null)
    setOcFerryBusy(false)
  }

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

  const panelRef = useRef<HTMLDialogElement>(null)
  useModalFocus(panelRef)

  return (
    <div className="modal-overlay">
      {/* 遮罩本身不可点:关闭走这个铺满背景的按钮(键盘可达),面板在上层。 */}
      <button type="button" className="modal-dismiss" aria-label="关闭设置" onClick={onClose} />
      <dialog ref={panelRef} className="modal-panel" open aria-modal="true" aria-label="设置">
        {/* 不用 <header>/<footer>:它们在 <dialog> 里会被 AX 映射成无名的
            banner / contentinfo landmark,读屏的 landmark 列表多两个空条目。 */}
        <div className="modal-head">
          <strong className="modal-title">设置</strong>
          <button
            type="button"
            className="chrome-button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X size={14} weight="regular" aria-hidden />
          </button>
        </div>
        <SlidingIndicator
          activeKey={settingsTab}
          className="settings-tabs"
          role="tablist"
          ariaLabel="设置分区"
          activeSelector="button.is-active"
          onKeyDown={(event) => {
            handleTablistKeys(event, (index) => {
              const next = SETTINGS_TABS[index]
              if (next !== undefined) changeSettingsTab(next)
            })
          }}
        >
          <button
            type="button"
            className={settingsTab === 'appearance' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('appearance')}
            role="tab"
            id="settings-tab-appearance"
            aria-controls="settings-panel"
            aria-selected={settingsTab === 'appearance'}
            tabIndex={settingsTab === 'appearance' ? 0 : -1}
          >
            外观
          </button>
          <button
            type="button"
            className={settingsTab === 'keys' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('keys')}
            role="tab"
            id="settings-tab-keys"
            aria-controls="settings-panel"
            aria-selected={settingsTab === 'keys'}
            tabIndex={settingsTab === 'keys' ? 0 : -1}
          >
            快捷键
          </button>
          <button
            type="button"
            className={settingsTab === 'ai' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('ai')}
            role="tab"
            id="settings-tab-ai"
            aria-controls="settings-panel"
            aria-selected={settingsTab === 'ai'}
            tabIndex={settingsTab === 'ai' ? 0 : -1}
          >
            <Sparkle size={14} weight="fill" aria-hidden /> AI 服务
          </button>
          <button
            type="button"
            className={settingsTab === 'data' ? 'is-active' : ''}
            onClick={() => changeSettingsTab('data')}
            role="tab"
            id="settings-tab-data"
            aria-controls="settings-panel"
            aria-selected={settingsTab === 'data'}
            tabIndex={settingsTab === 'data' ? 0 : -1}
          >
            备份与更新
          </button>
        </SlidingIndicator>

        {/* 分区内容。`key` 让它在换页时重建,滑入动画才会重播;方向跟着
            tab 的相对位置走(往右切 = 从右边进来)。 */}
        <div
          key={settingsTab}
          className="settings-body"
          data-dir={settingsDir}
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${settingsTab}`}
        >
          {settingsTab === 'appearance' && (
            <>
              <section className="modal-section">
                <p className="modal-section-label">界面主题</p>
                {/* 明暗与配色是同一件事的两半(色相 + 明度),放同一张卡里
                    两行。分成首尾两处时,用户滚到底才发现另一半。 */}
                <div className="settings-group">
                  <div className="settings-theme-block">
                    <span className="settings-shelf-columns-label">明暗</span>
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
                            {/* 曾经这里有一颗强调色小圆点。十二个主题的强调色
                                几乎全是同一档蓝,于是十二颗一模一样的点既没
                                传达「这个主题的强调色」,又因为排在预览页的
                                视觉重心上,被读成「每张都被选中了」—— 而真正
                                的选中信号是边框。没有信息量的装饰就是噪声。 */}
                          </span>
                          {theme.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-shelf-columns">
                    <span className="settings-shelf-columns-label">配色</span>
                    <DropdownMenu
                      ariaLabel="配色主题"
                      value={background}
                      options={backgroundOptions}
                      onChange={onBackgroundChange}
                      title="配色决定页面底色与强调色,明暗由上面的界面主题给"
                    >
                      <span className="dropdown-value">
                        <span
                          className="background-preview"
                          style={{ background: backgroundSwatch(background, dark) ?? undefined }}
                          aria-hidden="true"
                        />
                        {backgroundOptions.find((option) => option.value === background)?.label ??
                          '纯色桌面'}
                      </span>
                    </DropdownMenu>
                  </div>
                </div>
                <p className="settings-hint">
                  配色同时决定页面底色与强调色;书页仍用阅读背景,纸色与文字不受影响。
                </p>
              </section>
              <section className="modal-section">
                <p className="modal-section-label">强调色</p>
                <div className="accent-row">
                  {/* 「跟随主题」只在装了配色主题时出现:纯色桌面上它和品牌蓝
                      一模一样,两颗同样的圆只会让人猜哪个才是默认。它的色块
                      就是当前主题的渐变 —— 全行唯一一颗带渐变的圆,点它即
                      把颜色交回主题。 */}
                  {background !== 'none' && (
                    <button
                      type="button"
                      className={`accent-swatch accent-auto${accent.kind === 'auto' ? ' is-active' : ''}`}
                      style={{ background: accentPreview(themeAccent.h, themeAccent.c) }}
                      onClick={() => onAccentChange({ kind: 'auto' })}
                      aria-pressed={accent.kind === 'auto'}
                      aria-label="强调色跟随配色主题"
                      title="跟随配色主题"
                    />
                  )}
                  {ACCENT_PRESETS.map((preset) => {
                    // 纯色桌面下 auto 就等于品牌蓝,那颗要显示成选中 ——
                    // 否则整行没有任何选中项,读成「强调色丢了」。
                    const active =
                      accent.kind === 'preset'
                        ? accent.id === preset.id
                        : accent.kind === 'auto' &&
                          background === 'none' &&
                          preset.id === ACCENT_DEFAULT
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`accent-swatch${active ? ' is-active' : ''}`}
                        style={{ background: accentPreview(preset.hue, preset.chroma) }}
                        onClick={() => onAccentChange({ kind: 'preset', id: preset.id })}
                        aria-pressed={active}
                        aria-label={`强调色 ${preset.label}`}
                        title={preset.label}
                      />
                    )
                  })}
                  <label className={`accent-custom${accent.kind === 'custom' ? ' is-active' : ''}`}>
                    <input
                      type="color"
                      value={accent.kind === 'custom' ? accent.hex : '#2f6470'}
                      onChange={(event) =>
                        onAccentChange({ kind: 'custom', hex: event.target.value })
                      }
                      aria-label="自定义强调色"
                    />
                    <span>自定义</span>
                  </label>
                </div>
                <p className="settings-hint">
                  作用于按钮、进度与选中标记;换配色主题会一并更新,自定义色除外。
                </p>
              </section>
              <section className="modal-section">
                <p className="modal-section-label">书架偏好(自动保存)</p>
                <div className="settings-group">
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
                  <div className="settings-shelf-columns">
                    <span className="settings-shelf-columns-label">书籍密度</span>
                    <DropdownMenu
                      ariaLabel="书籍密度"
                      value={shelfDensity}
                      options={SHELF_DENSITY_OPTIONS}
                      onChange={(value) =>
                        onShelfDensity(
                          value === 'comfortable' || value === 'compact' ? value : 'standard',
                        )
                      }
                      title="只改每排本数与间距;封面 3/4 比例与文字层级不变"
                    />
                  </div>
                  <p className="ai-privacy">
                    排序、视图、列数与密度自动记忆;阅读排版(字号、行距、翻页方式)在阅读器内的 Aa
                    面板设置。
                  </p>
                </div>
              </section>
              {/* 低频项压在最后:它若排在前面,会把常用的「书架偏好」挤出首屏。 */}
              <section className="modal-section">
                <p className="modal-section-label">界面动效</p>
                <div className="settings-group">
                  <div className="settings-shelf-columns">
                    <span className="settings-shelf-columns-label">动态效果</span>
                    <DropdownMenu
                      ariaLabel="界面动效"
                      value={motionPreference}
                      options={MOTION_PREFERENCE_OPTIONS}
                      onChange={onMotionChange}
                      title="跟随系统会在系统开启「减少动态效果」时自动生效;减少动效始终关闭过渡"
                    />
                  </div>
                  <p className="settings-hint">
                    关闭后按钮、面板与视图切换不再渐变;书的内容与排版不受影响。
                  </p>
                </div>
              </section>
            </>
          )}

          {settingsTab === 'keys' && <KeybindingsSettings />}

          {settingsTab === 'ai' && (
            <section className="modal-section">
              <p className="modal-section-label">AI 服务(OpenAI 兼容)</p>
              <div className="settings-group">
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
                    <div className="ai-section ai-oc-ferry">
                      <p className="ai-section-title">本机免费模型 · OC Ferry</p>
                      <div className="ai-oc-ferry-row">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void runDetectOcFerry()}
                          disabled={ocFerryBusy}
                        >
                          {ocFerryBusy ? '检测中…' : '检测本地 OC Ferry'}
                        </button>
                        {ocFerry !== null && (
                          <>
                            <DropdownMenu
                              value={ocFerryModel}
                              options={ocFerry.models.map((model) => ({
                                value: model,
                                label: model,
                              }))}
                              onChange={setOcFerryModel}
                              ariaLabel="OC Ferry 可用模型"
                              title="OC Ferry 已判定可用的免费模型，模型名会原样发给本机转发口"
                            >
                              <span className="dropdown-value">{ocFerryModel || '选择模型…'}</span>
                            </DropdownMenu>
                            <button
                              type="button"
                              className="btn-primary"
                              onClick={() => void runUseOcFerry()}
                              disabled={ocFerryBusy || ocFerryModel === ''}
                            >
                              使用此模型
                            </button>
                          </>
                        )}
                      </div>
                      {ocFerryMsg !== null && <p className="ai-privacy">{ocFerryMsg}</p>}
                      <p className="ai-privacy">
                        需先启动 OC Ferry 托盘程序；密钥由 Rust 在本机读取，不会进入页面。
                      </p>
                    </div>
                    {aiLoaded && providers.length > 0 && (
                      <p className="ai-privacy">
                        配置好的服务会自动出现在阅读器 AI 助手与云端朗读里;当前生效:{' '}
                        {providers.find((provider) => provider.id === aiActiveId)?.name ?? '未选择'}
                        。
                      </p>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {settingsTab === 'data' && (
            <>
              <section className="modal-section">
                <p className="modal-section-label">备份与恢复</p>
                <div className="settings-group">
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
                </div>
              </section>
              <section className="modal-section">
                <p className="modal-section-label">更新</p>
                <div className="settings-group">
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
                </div>
              </section>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </dialog>

      <input
        ref={restoreInputRef}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void restoreBackupFile(file, onRestored)
        }}
      />
    </div>
  )
}

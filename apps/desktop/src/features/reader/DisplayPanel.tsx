/**
 * 显示设置面板:底栏信息开关(进度/字数/时间)、翻页动画档、版式(单页/
 * 双页/滚动)与阅读尺。从 ReaderScreen 拆出的纯展示件;开关的落库与
 * 尺的内核下发都在宿主回调里。
 */

import { Segmented } from './Segmented'
import type {
  TypographySettings,
  LayoutPatch,
  StatsSettings,
  PageTurnStyle,
  ReadingRulerSettings,
} from './reader-options'
import {
  PAGE_TURN_OPTIONS,
  RULER_DIM_OPTIONS,
  RULER_FOCUS_LINES,
  VIEW_MODE_OPTIONS,
} from './reader-options'

interface DisplayPanelProps {
  readonly typography: TypographySettings
  readonly updateLayout: (patch: LayoutPatch) => void
  /** 滚动版式仅重排格式可用(PDF/CBZ 等固定排版没有滚动流)。 */
  readonly scrollModeSupported: boolean
  readonly statsSettings: StatsSettings
  readonly onStatsToggle: (key: 'progress' | 'words' | 'time') => void
  readonly pageTurnStyle: PageTurnStyle
  readonly onPageTurnChange: (style: PageTurnStyle) => void
  readonly rulerActive: boolean
  readonly rulerSupported: boolean
  readonly rulerSettings: ReadingRulerSettings
  readonly updateRuler: (patch: Partial<ReadingRulerSettings>) => void
  readonly toggleRuler: () => void
  readonly wakeLockEnabled: boolean
  readonly wakeLockSupported: boolean
  readonly onWakeLockChange: (enabled: boolean) => void
}

export function DisplayPanel({
  typography,
  updateLayout,
  scrollModeSupported,
  statsSettings,
  onStatsToggle,
  pageTurnStyle,
  onPageTurnChange,
  rulerActive,
  rulerSupported,
  rulerSettings,
  updateRuler,
  toggleRuler,
  wakeLockEnabled,
  wakeLockSupported,
  onWakeLockChange,
}: DisplayPanelProps) {
  return (
    <section className="reader-settings reader-display" aria-label="显示设置">
      <div className="settings-group">
        <span className="settings-group-label">显示</span>
        <div className="stats-toggles">
          {(
            [
              { key: 'progress', label: '进度条与页码' },
              { key: 'words', label: '字数' },
              { key: 'time', label: '预计时间' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              className={`stats-toggle${statsSettings[item.key] ? ' is-on' : ''}`}
              role="switch"
              aria-checked={statsSettings[item.key]}
              onClick={() => onStatsToggle(item.key)}
            >
              <span className="stats-toggle-label">{item.label}</span>
              <span className="stats-toggle-track" aria-hidden>
                <span className="stats-toggle-thumb" />
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-group">
        <span className="settings-group-label">翻页动画</span>
        <Segmented>
          {PAGE_TURN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={pageTurnStyle === option.value ? 'is-active' : ''}
              onClick={() => onPageTurnChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </Segmented>
      </div>
      <div className="settings-row">
        <span className="settings-label">方式</span>
        <Segmented>
          {VIEW_MODE_OPTIONS.filter(
            (option) => option.value !== 'scroll' || scrollModeSupported,
          ).map((option) => (
            <button
              key={option.label}
              type="button"
              className={typography.viewMode === option.value ? 'is-active' : ''}
              onClick={() => updateLayout({ viewMode: option.value })}
            >
              {option.label}
            </button>
          ))}
        </Segmented>
      </div>
      <div className="settings-group">
        <span className="settings-group-label">阅读尺</span>
        <div className="stats-toggles">
          <button
            type="button"
            className={`stats-toggle${rulerActive ? ' is-on' : ''}`}
            role="switch"
            aria-checked={rulerActive}
            disabled={!rulerSupported}
            onClick={toggleRuler}
          >
            <span className="stats-toggle-label">聚焦当前行,淡化其他行</span>
            <span className="stats-toggle-track" aria-hidden>
              <span className="stats-toggle-thumb" />
            </span>
          </button>
        </div>
      </div>
      {rulerActive && (
        <>
          <div className="settings-row">
            <span className="settings-label">聚焦行数</span>
            <Segmented>
              {RULER_FOCUS_LINES.map((count) => (
                <button
                  key={count}
                  type="button"
                  className={rulerSettings.focusLines === count ? 'is-active' : ''}
                  onClick={() => updateRuler({ focusLines: count })}
                >
                  {count}
                </button>
              ))}
            </Segmented>
          </div>
          <div className="settings-row">
            <span className="settings-label">淡化</span>
            <Segmented>
              {RULER_DIM_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={rulerSettings.dimOpacity === option.value ? 'is-active' : ''}
                  onClick={() => updateRuler({ dimOpacity: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </Segmented>
          </div>
        </>
      )}
      <p className="ai-privacy">
        {!rulerSupported
          ? '阅读尺暂不支持固定排版(PDF / 漫画)与竖排正文。'
          : '滚轮与 ↑↓ 移动聚焦行,走到页尾自动翻页;当前排版是滚动时,移动后当前行会回到视口中间。分页排版只高亮、不滚动页面。'}
      </p>
      <div className="settings-row">
        <span className="settings-label">屏幕常亮</span>
        <div className="stats-toggles">
          <button
            type="button"
            className={`stats-toggle${wakeLockEnabled ? ' is-on' : ''}`}
            role="switch"
            aria-checked={wakeLockEnabled}
            disabled={!wakeLockSupported}
            onClick={() => onWakeLockChange(!wakeLockEnabled)}
          >
            <span className="stats-toggle-label">阅读时保持屏幕常亮</span>
            <span className="stats-toggle-track" aria-hidden>
              <span className="stats-toggle-thumb" />
            </span>
          </button>
        </div>
      </div>
      {!wakeLockSupported && (
        <p className="ai-privacy">当前环境不支持屏幕常亮(Wake Lock),开关仅在支持的设备上生效。</p>
      )}
    </section>
  )
}

/**
 * 划词翻译浮层卡:从 ReaderScreen 拆出的纯展示件 —— 译文、目标语言切换、
 * 成本披露(provider)与复制都在这里;翻译请求的发起/取消仍归宿主。
 * 定位约定:rect.top 已是避开划词工具算好的落点(见宿主 runTranslate),
 * 这里只做视口兜底;卡片 max-height 由 CSS 管,流式变高时自己滚。
 */

import { Copy, X } from '@phosphor-icons/react'
import { TRANSLATE_MAX_CHARS } from '@deepread/ai-core'
import { DropdownMenu } from '../../components/DropdownMenu'
import { TRANSLATE_TARGETS } from './reader-options'

export interface TranslationCardState {
  readonly rect: { readonly top: number; readonly left: number }
  readonly lang: string | null
  readonly body: string
  readonly provider: string
  readonly truncated: boolean
  readonly error: string | null
  readonly loading: boolean
}

interface TranslationCardProps {
  readonly translation: TranslationCardState
  readonly targetLanguage: string
  /** 阅读主题变量:转发给下拉菜单(portal 到 body 后要随身带)。 */
  readonly themeVars?: React.CSSProperties
  readonly onTargetLanguageChange: (target: string) => void
  readonly onClose: () => void
}

export function TranslationCard({
  translation,
  targetLanguage,
  themeVars,
  onTargetLanguageChange,
  onClose,
}: TranslationCardProps) {
  return (
    <div
      className="lookup-card translate-card"
      aria-label="翻译"
      style={{
        top: Math.min(Math.max(64, translation.rect.top ?? 100), window.innerHeight - 300),
        left: Math.max(12, Math.min(translation.rect.left ?? 100, window.innerWidth - 340)),
      }}
    >
      <div className="lookup-head">
        <strong>翻译 → {targetLanguage}</strong>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={12} weight="regular" aria-hidden />
        </button>
      </div>
      <DropdownMenu
        className="tts-card-dropdown"
        ariaLabel="翻译目标语言"
        themeVars={themeVars}
        value={targetLanguage}
        options={TRANSLATE_TARGETS.map((target) => ({ value: target, label: target }))}
        onChange={onTargetLanguageChange}
      >
        <span className="tts-card-value">{targetLanguage}</span>
        <span className="tts-card-label">目标语言</span>
      </DropdownMenu>
      {translation.truncated && (
        <p className="reader-toc-empty">
          选中内容超过 {TRANSLATE_MAX_CHARS} 字,只译了前 {TRANSLATE_MAX_CHARS} 字。
        </p>
      )}
      {translation.error !== null ? (
        <p className="ai-error" role="alert">
          {translation.error}
        </p>
      ) : (
        <p className="translate-body">
          {translation.body === ''
            ? translation.loading
              ? '翻译中…'
              : '没有返回译文。'
            : translation.body}
        </p>
      )}
      <div className="translate-foot">
        {/* 成本诚实:这译文是谁出的、用的哪个模型,直接写在卡片上。 */}
        <span className="translate-provider">{translation.provider}</span>
        <div className="translate-actions">
          {translation.lang !== null && (
            <span className="translate-provider">源语言 {translation.lang}</span>
          )}
          <button
            type="button"
            className="chrome-button"
            onClick={() => void navigator.clipboard?.writeText(translation.body)}
            title="复制译文"
          >
            <Copy size={12} weight="regular" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}

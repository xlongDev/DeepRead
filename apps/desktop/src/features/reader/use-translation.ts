import { useCallback, useState } from 'react'
import type { RefObject } from 'react'
import {
  buildTranslateMessages,
  parseTranslation,
  streamTranslationView,
  TRANSLATE_MAX_CHARS,
} from '@deepread/ai-core'
import type { EngineSelection } from '@deepread/reader-adapter'
import { toAppError, type AiProviderConfig } from '@deepread/shared'
import { collectChatText } from '../../lib/ai-chat'
import { anchorFromRect, placeCompanionCard, windowFrame } from './selection-place'
import { loadTranslateTarget, persistTranslateTarget } from './reader-options'
import type { TranslationCardState } from './TranslationCard'

/** 翻译卡的估计高度,同用于避让工具条(与词典卡同一套三级退让)。 */
const TRANSLATE_CARD_HEIGHT = 300

/**
 * 划词翻译域:卡片状态、目标语言(落 localStorage)与 ai.chat 流式调用
 * 收进一个 hook;AI 服务列表仍由 ReaderScreen 持有(规则推断等也用它)。
 */
export function useTranslation(
  selection: EngineSelection | null,
  aiProviders: readonly AiProviderConfig[],
  bookLanguage: string | undefined,
  hostRef: RefObject<HTMLDivElement | null>,
  onNotice: (notice: { text: string; danger: boolean } | null) => void,
) {
  const [translation, setTranslation] = useState<TranslationCardState | null>(null)
  const [translateTarget, setTranslateTarget] = useState<string | null>(loadTranslateTarget)
  /** 目标语言的实际取值:没手动选过时,中文书译英、其余译中。 */
  const effectiveTranslateTarget =
    translateTarget ?? (bookLanguage?.toLowerCase().startsWith('zh') ? 'English' : '中文')

  /** 目标语言改动:落库 + state(卡片里的下拉立即生效)。 */
  const changeTargetLanguage = useCallback((target: string): void => {
    setTranslateTarget(target)
    persistTranslateTarget(target)
  }, [])

  const closeTranslation = useCallback((): void => {
    setTranslation(null)
  }, [])

  /**
   * 划选翻译:走 ai.chat 流式通道,边收边渲染,收完 zod 校验。
   * 门槛是「有没有配 AI 服务」——没配就说清楚,不做假的翻译结果。
   */
  const runTranslate = useCallback(async (): Promise<void> => {
    const current = selection
    if (current === null) return
    const provider = aiProviders[0]
    if (provider === undefined) {
      onNotice({ text: '还没有配置 AI 服务:先在 AI 助手里添加一个,再回来翻译。', danger: false })
      return
    }
    const source = current.text
    const text = source.slice(0, TRANSLATE_MAX_CHARS)
    // 卡片落点避开还开着的划词工具:工具在选区下方,卡片去工具底下(见
    // selection-place 的三级退让),不再不管不顾地压在选区上。
    const frame =
      hostRef.current?.getBoundingClientRect() ?? windowFrame(window.innerWidth, window.innerHeight)
    const rect = {
      top: placeCompanionCard(frame, anchorFromRect(current.rect), TRANSLATE_CARD_HEIGHT).top,
      left: current.rect.left,
    }
    setTranslation({
      rect,
      lang: null,
      body: '',
      provider: `${provider.name} · ${provider.model}`,
      truncated: source.length > TRANSLATE_MAX_CHARS,
      error: null,
      loading: true,
    })
    let buffer = ''
    try {
      await collectChatText(
        provider.id,
        [
          ...buildTranslateMessages({
            text,
            targetLang: effectiveTranslateTarget,
            context: text,
          }),
        ],
        (delta) => {
          buffer += delta
          const view = streamTranslationView(buffer)
          setTranslation((state) =>
            state === null ? state : { ...state, lang: view.lang, body: view.body },
          )
        },
      )
      const parsed = parseTranslation(buffer)
      setTranslation((state) =>
        state === null
          ? state
          : { ...state, lang: parsed.detectedLang, body: parsed.translation, loading: false },
      )
    } catch (cause) {
      setTranslation((state) =>
        state === null ? state : { ...state, loading: false, error: toAppError(cause).message },
      )
    }
  }, [aiProviders, effectiveTranslateTarget, selection, hostRef, onNotice])

  return {
    translation,
    runTranslate,
    closeTranslation,
    translateTarget,
    effectiveTranslateTarget,
    changeTargetLanguage,
  }
}

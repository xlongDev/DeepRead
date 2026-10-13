/**
 * Selection translation (B5.2).
 *
 * 走现有 `ai.chat` 流式通道,输出用**换行分隔的两节**而不是 JSON ——
 * JSON 在流式中途是不可解析的(半截 `{"trans` 没法渐进渲染),而译文
 * 要的就是边收边看。收完再交给 zod 校验(spec §118:未校验的 AI 输出
 * 不进 UI 状态)。
 *
 * 协议:`LANG:<BCP-47>` → `---` → 译文 →(可选)`---` → 逐行备注。
 */

import { z } from 'zod'
import type { ChatMessage } from './types'

/** 单次翻译上限:再长就该分段,而不是让一次请求吃掉整章的 token。 */
export const TRANSLATE_MAX_CHARS = 2000

export const translationSchema = z.object({
  detectedLang: z.string().min(1).max(40),
  translation: z.string().min(1),
  notes: z.array(z.string().min(1).max(300)).max(10).optional(),
})

export type TranslationPayload = z.output<typeof translationSchema>

export interface TranslateRequest {
  readonly text: string
  /** 目标语言(用户可读的自然语言名,如「中文」「English」)。 */
  readonly targetLang: string
  /** 选中所在的整段:给模型语境,代词与术语才不会译错。 */
  readonly context?: string
  /** 可选术语表:专有名词按表走,避免同一本书里前后不一致。 */
  readonly glossary?: readonly { readonly from: string; readonly to: string }[]
}

export function buildTranslateMessages(request: TranslateRequest): readonly ChatMessage[] {
  const glossary =
    request.glossary !== undefined && request.glossary.length > 0
      ? `\n术语表(务必照用):\n${request.glossary.map((entry) => `${entry.from} → ${entry.to}`).join('\n')}`
      : ''
  const context =
    request.context !== undefined && request.context.trim() !== ''
      ? `【所在段落】\n${request.context}\n\n`
      : ''
  return [
    {
      role: 'system',
      content: [
        '你是翻译助手。把用户给出的【片段】译成【目标语言】。',
        '要求:保留原文的段落、列表与标点结构;不写任何前言或后记;不补译原文没有的内容;',
        '专有名词与术语保持统一,拿不准就在第二节里说明,不要自行发挥。',
        '输出格式(严格,不要 markdown 代码围栏):',
        'LANG:<检测到的源语言 BCP-47,如 zh-CN / en>',
        '---',
        '<译文>',
        '有需要提醒的取舍时,再起一行 --- 后逐行列出;没有就不写第二节。',
        glossary,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${context}【片段】\n${request.text}\n\n【目标语言】${request.targetLang}`,
    },
  ]
}

const SECTION = /\n?---\n?/

/**
 * 流式中间态:把已经收到的 buffer 拆成「检测到的语言 + 已可见的译文」。
 * 第一个分隔符之前是协议头(还没收全就当作没到),之后到下一个分隔符
 * 之间是译文正文 —— 边收边渲染的就是这一段。
 */
export function streamTranslationView(buffer: string): {
  readonly lang: string | null
  readonly body: string
} {
  const at = buffer.indexOf('---')
  if (at === -1) return { lang: null, body: '' }
  const lang = /LANG:\s*([^\n\r]+)/.exec(buffer.slice(0, at))?.[1]?.trim() ?? null
  const body = buffer.slice(at + 3).split(SECTION)[0] ?? ''
  return { lang, body: body.replace(/^\r?\n/, '') }
}

/** 收完整个流再校验:缺字段/空译文一律抛,UI 收到的是可信结构。 */
export function parseTranslation(text: string): TranslationPayload {
  const view = streamTranslationView(text)
  // 备注是第二节里的逐行文本:先按节切,再按行拆。
  const notes = text
    .split(SECTION)
    .slice(2)
    .flatMap((section) => section.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return translationSchema.parse({
    detectedLang: view.lang ?? 'unknown',
    translation: view.body.trim(),
    ...(notes.length > 0 ? { notes } : {}),
  })
}

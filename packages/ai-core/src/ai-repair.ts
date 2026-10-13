/**
 * AI-assisted text correction (spec §35 AI Book Processor, MVP scope).
 *
 * Safety model: the model never rewrites the book. It proposes *targeted*
 * find/replace corrections; every proposal is validated against the real
 * text (exact occurrence count) before it can be shown, and application
 * happens only for user-accepted items on verified-unique matches.
 * The shared plumbing lives in ./anchor.
 */

import {
  anchorFindReplace,
  applyAnchored,
  parseFindReplace,
  type IdentifiedProposal,
} from './anchor'

export type AiCorrection = IdentifiedProposal

/** Prompt asking the model for targeted corrections on a bounded excerpt. */
export function buildRepairMessages(
  excerpt: string,
  title: string,
): readonly { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        `你是中文电子书校对助手。以下是《${title}》的正文片段。`,
        '只找确定的错误:错别字、明显多余或缺失的标点、全半角混乱。不要改写风格,不要重写句子。',
        '输出严格 JSON(无其他文字):',
        '{"corrections":[{"find":"原文中连续的一段原文","replace":"替换后的文字","reason":"错误原因"}]}',
        'find 必须逐字出现在原文中且尽量短而唯一;没有错误就返回 {"corrections":[]}。',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Validate raw model output and anchor each correction in the real text. */
export function parseCorrections(text: string, source: string): readonly AiCorrection[] {
  const parsed = parseFindReplace(text)
  if (parsed === null) return []
  return anchorFindReplace(parsed.corrections, source, 'ai')
}

/** Apply only accepted corrections whose find is unique in the text. */
export function applyCorrections(
  text: string,
  corrections: readonly AiCorrection[],
  acceptedIds: readonly string[],
): ReturnType<typeof applyAnchored> {
  return applyAnchored(text, corrections, acceptedIds)
}

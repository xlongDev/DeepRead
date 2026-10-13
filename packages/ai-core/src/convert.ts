/**
 * 繁简转换(提案制,plan-v0.3 §B5.3)。
 *
 * 不做 OpenCC 内嵌(ADR-0001 依赖纪律:数据表体积):转换由当前 AI provider 生成,
 * 走与 AI 校对完全相同的"检测-应用分离"框架 —— 模型只给 find/replace 提案,每条
 * 都对照原文校验锚点,用户逐条接受后才落盘。调用方必须诚实标注"基于当前 AI 提供商"。
 *
 * 单次提案上限沿用 findReplaceSchema 的 100 条:长书一次覆盖不完,检查可重复跑,
 * 每跑一轮消耗一批,UI 要把这个上限说清楚。
 */

import {
  anchorFindReplace,
  applyAnchored,
  parseFindReplace,
  type IdentifiedProposal,
} from './anchor'

export type ConversionRule = 't2s' | 's2t'

export interface Conversion extends IdentifiedProposal {
  readonly rule: ConversionRule
}

const RULE_LABEL: Record<ConversionRule, string> = {
  t2s: '繁→简',
  s2t: '简→繁',
}

export function conversionRuleLabel(rule: ConversionRule): string {
  return RULE_LABEL[rule]
}

/** Prompt asking the model for character-level conversion pairs. */
export function buildConvertMessages(
  excerpt: string,
  rule: ConversionRule,
): readonly { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        `你是中文电子书用字转换助手,只做${RULE_LABEL[rule]}的单向转换。`,
        '只转换确有异体/繁简差异的字词(如 裏→里、著→着、乾→干、面→面),不要统一作者的用字习惯。',
        '不要改标点、数字、拉丁字母与日文假名,不要改写句子,不要增删内容。',
        '输出严格 JSON(无其他文字):',
        '{"corrections":[{"find":"原文中连续的一段原文","replace":"转换后的文字","reason":"转换"}]}',
        'find 必须逐字出现在原文中且尽量短而唯一;无需转换就返回 {"corrections":[]}。',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Validate raw model output and anchor each conversion in the real text. */
export function parseConversions(
  text: string,
  source: string,
  rule: ConversionRule,
): readonly Conversion[] {
  const parsed = parseFindReplace(text)
  if (parsed === null) return []
  // id 带方向前缀:同一次会话里两个方向的提案不会撞 id。
  return anchorFindReplace(
    parsed.corrections.map((item) => ({ ...item, rule })),
    source,
    rule,
  )
}

/** Apply only accepted conversions whose find is unique in the text. */
export function applyConversions(
  text: string,
  conversions: readonly Conversion[],
  acceptedIds: readonly string[],
): ReturnType<typeof applyAnchored> {
  return applyAnchored(text, conversions, acceptedIds)
}

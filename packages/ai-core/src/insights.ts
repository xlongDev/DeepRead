/**
 * AI book insights (spec §38): whole-book summary and structured outline.
 *
 * Honesty first: the model receives chapter starts (bounded), never the full
 * text — results are labeled 基于章节开头 so users know the coverage. Output
 * is requested as JSON and validated with zod before it can be persisted
 * (spec §118/§119: no unvalidated AI output reaches storage).
 */

import { z } from 'zod'
import type { ChatMessage } from './types'

export interface InsightChapter {
  readonly label: string
  readonly text: string
}

/**
 * How much of the book the model ever sees: the first N chapter starts, each
 * capped at M chars. Exported so the UI can state the send scope honestly
 * before generating (spec §40: AI output must be auditable).
 */
export const INSIGHT_MAX_CHAPTERS = 12
export const INSIGHT_EXCERPT_CHARS = 500

/** Assemble the summary request: per-chapter excerpts + JSON output rule. */
export function buildSummaryMessages(
  chapters: readonly InsightChapter[],
  title: string,
): readonly ChatMessage[] {
  const excerpt = chapters
    .slice(0, INSIGHT_MAX_CHAPTERS)
    .map((chapter) => `【${chapter.label}】\n${chapter.text.slice(0, INSIGHT_EXCERPT_CHARS)}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content: [
        `你是读书助手。以下是《${title}》各章节的开头(共 ${Math.min(chapters.length, INSIGHT_MAX_CHAPTERS)} 章,每章最多 ${INSIGHT_EXCERPT_CHARS} 字),并非全书内容。`,
        '请基于这些开头输出全书速览,严格按以下 JSON 结构返回,不要输出任何其他文字:',
        '{"overview": "三到五句的整体速览","themes": ["主题1", "主题2"],"coverage": "基于章节开头,未覆盖全部正文"}',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Assemble the outline request: chapter labels + starts → structured outline. */
export function buildOutlineMessages(
  chapters: readonly InsightChapter[],
  title: string,
): readonly ChatMessage[] {
  const excerpt = chapters
    .slice(0, INSIGHT_MAX_CHAPTERS)
    .map((chapter) => `【${chapter.label}】\n${chapter.text.slice(0, INSIGHT_EXCERPT_CHARS)}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content: [
        `你是读书助手。以下是《${title}》各章节的开头。`,
        '请推断全书结构,输出严格 JSON(不要输出其他文字):',
        '{"chapters": [{"title": "章节标题","gist": "一句话概括该章内容与作用"}]}',
        'chapters 必须覆盖给出的每一章,顺序一致。',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Strip code fences and extract the first JSON object from model output. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型输出中没有找到 JSON 对象')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

export const summaryInsightSchema = z.object({
  overview: z.string().min(1),
  themes: z.array(z.string().min(1)).max(20),
  coverage: z.string().min(1),
})

export const outlineInsightSchema = z.object({
  chapters: z
    .array(
      z.object({
        title: z.string().min(1),
        gist: z.string().min(1),
      }),
    )
    .min(1)
    .max(100),
})

export type SummaryInsight = z.output<typeof summaryInsightSchema>
export type OutlineInsight = z.output<typeof outlineInsightSchema>

/** Parse + validate a summary from raw model output; throws with context on failure. */
export function parseSummaryInsight(text: string): SummaryInsight {
  return summaryInsightSchema.parse(extractJsonObject(text))
}

/** Parse + validate an outline from raw model output. */
export function parseOutlineInsight(text: string): OutlineInsight {
  return outlineInsightSchema.parse(extractJsonObject(text))
}

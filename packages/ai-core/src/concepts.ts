/**
 * Concept extraction (spec §40, B7): aimed at non-fiction — the model proposes
 * key concepts, a plain explanation for each, and directed relations between
 * them. Output is zod-validated before it can be persisted (spec §118).
 */

import { z } from 'zod'
import {
  extractJsonObject,
  INSIGHT_EXCERPT_CHARS,
  INSIGHT_MAX_CHAPTERS,
  type InsightChapter,
} from './insights'

export type { InsightChapter }

export const conceptsSchema = z.object({
  concepts: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        /** One-or-two-sentence explanation in the book's own terms. */
        explanation: z.string().min(1).max(500),
        /** Directed relations to other concepts (by name). */
        relations: z
          .array(
            z.object({
              with: z.string().min(1).max(60),
              type: z.string().min(1).max(30),
            }),
          )
          .max(20)
          .default([]),
      }),
    )
    .max(50),
})

export type ConceptsPayload = z.output<typeof conceptsSchema>

/** Assemble the concepts request: per-chapter excerpts + JSON output rule. */
export function buildConceptsMessages(
  chapters: readonly InsightChapter[],
  title: string,
): readonly { role: 'system' | 'user'; content: string }[] {
  const excerpt = chapters
    .slice(0, INSIGHT_MAX_CHAPTERS)
    .map((chapter) => `【${chapter.label}】\n${chapter.text.slice(0, INSIGHT_EXCERPT_CHARS)}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content: [
        `你是读书助手。以下是《${title}》各章节的开头(并非全书内容)。`,
        '抽取其中的核心概念,输出严格 JSON(无其他文字):',
        '{"concepts":[{"name":"概念名","explanation":"基于片段的一句话解释,证据不足时注明","relations":[{"with":"另一个概念名","type":"关系类型"}]}]}',
        '只抽取片段中有依据的概念;没把握就省略,不要编造。',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Parse + validate concepts from raw model output. */
export function parseConcepts(text: string): ConceptsPayload {
  return conceptsSchema.parse(extractJsonObject(text))
}

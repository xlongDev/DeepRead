/**
 * Character extraction (spec §39): the model proposes character cards from
 * bounded chapter excerpts; output is zod-validated before persisting.
 */

import { z } from 'zod'
import { extractJsonObject, type InsightChapter } from './insights'

export type { InsightChapter }

const CHAPTER_EXCERPT_CHARS = 500
const MAX_CHAPTERS = 12

export const charactersSchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        aliases: z.array(z.string().min(1).max(60)).max(10),
        role: z.enum(['主角', '配角', '反派', '路人']),
        description: z.string().min(1).max(500),
        /** Directed relations to other characters (by name). */
        relationships: z
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

export type CharactersPayload = z.output<typeof charactersSchema>

export function buildCharactersMessages(
  chapters: readonly InsightChapter[],
  title: string,
): readonly { role: 'system' | 'user'; content: string }[] {
  const excerpt = chapters
    .slice(0, MAX_CHAPTERS)
    .map((chapter) => `【${chapter.label}】\n${chapter.text.slice(0, CHAPTER_EXCERPT_CHARS)}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content: [
        `你是读书助手。以下是《${title}》各章节的开头(并非全书内容)。`,
        '抽取其中出现的人物,输出严格 JSON(无其他文字):',
        '{"characters":[{"name":"姓名","aliases":["别名"],"role":"主角|配角|反派|路人","description":"基于片段的一句话描述,证据不足时注明"}]}',
        '只抽取片段中有依据的人物;没把握就省略,不要编造。',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Parse + validate characters from raw model output. */
export function parseCharacters(text: string): CharactersPayload {
  return charactersSchema.parse(extractJsonObject(text))
}

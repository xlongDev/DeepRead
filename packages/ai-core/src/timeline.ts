/**
 * Timeline extraction (spec §40, B7): the model proposes ordered events from
 * bounded chapter excerpts. Each event carries a chapterRef — the chapter
 * label it was read from — so fiction without dates still gets an axis (the
 * chapter axis) instead of an invented calendar. Output is zod-validated
 * before it can be persisted (spec §118).
 */

import { z } from 'zod'
import {
  extractJsonObject,
  INSIGHT_EXCERPT_CHARS,
  INSIGHT_MAX_CHAPTERS,
  type InsightChapter,
} from './insights'

export type { InsightChapter }

const MAX_EVENTS = 60

export const timelineSchema = z.object({
  events: z
    .array(
      z.object({
        /** Short event title, e.g. "守灯人第一次点亮灯塔". */
        event: z.string().min(1).max(120),
        /** Chapter label this event was read from (one of the input labels). */
        chapterRef: z.string().min(1).max(60),
        /** Supporting details condensed from the excerpt. */
        descriptions: z.array(z.string().min(1).max(300)).max(6).default([]),
      }),
    )
    .max(MAX_EVENTS),
})

export type TimelinePayload = z.output<typeof timelineSchema>

/** Assemble the timeline request: per-chapter excerpts + JSON output rule. */
export function buildTimelineMessages(
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
        '抽取其中的关键事件,按章节顺序输出严格 JSON(无其他文字):',
        '{"events":[{"event":"事件标题","chapterRef":"所属章节名(必须原样取自输入的章节名)","descriptions":["细节1","细节2"]}]}',
        '章节没有日期的,不要编造日期,用章节顺序体现先后;没把握的事件就省略。',
      ].join('\n'),
    },
    { role: 'user', content: excerpt },
  ]
}

/** Parse + validate a timeline from raw model output. */
export function parseTimeline(text: string): TimelinePayload {
  return timelineSchema.parse(extractJsonObject(text))
}

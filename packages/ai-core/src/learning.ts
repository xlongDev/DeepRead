/**
 * AI learning generation (Sprint 12): flashcards from highlights, quizzes
 * from chapter text. Same honesty rules as insights.ts — bounded input,
 * JSON-only output, zod-validated before anything is persisted.
 */

import { z } from 'zod'
import { extractJsonObject } from './insights'
import type { ChatMessage } from './types'

const EXCERPT_CHARS = 400
const MAX_ITEMS = 20

export const flashcardsSchema = z.object({
  cards: z
    .array(
      z.object({
        front: z.string().min(1).max(500),
        back: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(MAX_ITEMS),
})

export const quizSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(500),
        options: z.array(z.string().min(1).max(200)).min(2).max(6),
        /** Index into `options` of the single correct answer. */
        answer: z.number().int().min(0).max(5),
        explanation: z.string().max(1000).default(''),
      }),
    )
    .min(1)
    .max(10),
})

export type GeneratedFlashcards = z.output<typeof flashcardsSchema>
export type GeneratedQuiz = z.output<typeof quizSchema>

export interface HighlightInput {
  readonly excerpt: string
  readonly note?: string
}

/** Assemble the flashcard request from user highlights (bounded). */
export function buildFlashcardMessages(
  highlights: readonly HighlightInput[],
  title: string,
): readonly ChatMessage[] {
  const material = highlights
    .slice(0, MAX_ITEMS)
    .map(
      (h, index) =>
        `${index + 1}. ${h.excerpt.slice(0, EXCERPT_CHARS)}${h.note ? `(笔记:${h.note.slice(0, 200)})` : ''}`,
    )
    .join('\n')
  return [
    {
      role: 'system',
      content: [
        `你是学习助手。以下是《${title}》中用户的划线摘录。`,
        '把有记忆价值的摘录做成闪卡,输出严格 JSON(无其他文字):',
        '{"cards":[{"front":"问题或提示(不要直接暴露答案)","back":"答案,引用原文关键句"}]}',
        '没有记忆价值的摘录(如纯抒情感慨)可以丢弃;宁缺毋滥。',
      ].join('\n'),
    },
    { role: 'user', content: material },
  ]
}

/** Assemble the quiz request from chapter text (bounded). */
export function buildQuizMessages(
  chapterLabel: string,
  chapterText: string,
  count: number,
): readonly ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        `你是出题助手。以下章节是《${chapterLabel}》的内容(可能不完整)。`,
        `出 ${count} 道单选题检验对内容的理解,输出严格 JSON(无其他文字):`,
        '{"questions":[{"question":"题干","options":["A","B","C","D"],"answer":0,"explanation":"依据原文的一句话解释"}]}',
        '只依据给出的内容出题,不要编造文中没有的细节;answer 是正确选项的下标。',
      ].join('\n'),
    },
    { role: 'user', content: chapterText.slice(0, 6000) },
  ]
}

/** Parse + validate flashcards from raw model output. */
export function parseFlashcards(text: string): GeneratedFlashcards {
  return flashcardsSchema.parse(extractJsonObject(text))
}

/** Parse + validate a quiz from raw model output. */
export function parseQuiz(text: string): GeneratedQuiz {
  const parsed = quizSchema.parse(extractJsonObject(text))
  for (const question of parsed.questions) {
    if (question.answer >= question.options.length) {
      throw new Error('题目答案下标超出选项范围')
    }
  }
  return parsed
}

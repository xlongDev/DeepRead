import { describe, expect, it } from 'vitest'
import { buildFlashcardMessages, buildQuizMessages, parseFlashcards, parseQuiz } from './learning'

describe('buildFlashcardMessages', () => {
  it('includes bounded highlight material and the JSON rule', () => {
    const messages = buildFlashcardMessages(
      [
        { excerpt: '认知带宽决定决策质量。', note: '重要概念' },
        { excerpt: '随意的一段抒情文字。' },
      ],
      '认知觉醒',
    )
    const system = messages[0]!.content
    expect(system).toContain('{"cards"')
    expect(messages[1]!.content).toContain('认知带宽决定决策质量。')
    expect(messages[1]!.content).toContain('重要概念')
  })
})

describe('buildQuizMessages', () => {
  it('requests the requested count and bounds chapter text', () => {
    const messages = buildQuizMessages('第三章', '正文'.repeat(5000), 5)
    expect(messages[0]!.content).toContain('出 5 道')
    expect(messages[1]!.content.length).toBeLessThanOrEqual(6000)
  })
})

describe('parseFlashcards', () => {
  it('parses plain and fenced JSON', () => {
    const raw = '```json\n{"cards":[{"front":"Q","back":"A"}]}\n```'
    expect(parseFlashcards(raw).cards).toEqual([{ front: 'Q', back: 'A' }])
    expect(parseFlashcards('{"cards":[{"front":"Q","back":"A"}]}').cards.length).toBe(1)
  })

  it('rejects empty card lists', () => {
    expect(() => parseFlashcards('{"cards":[]}')).toThrow()
  })
})

describe('parseQuiz', () => {
  it('parses a quiz and validates the answer index', () => {
    const raw =
      '{"questions":[{"question":"灯象征什么?","options":["希望","黑暗"],"answer":0,"explanation":"文中明示"}]}'
    const quiz = parseQuiz(raw)
    expect(quiz.questions[0]!.options).toEqual(['希望', '黑暗'])
  })

  it('rejects an answer index outside the options', () => {
    const raw = '{"questions":[{"question":"Q","options":["A","B"],"answer":5}]}'
    expect(() => parseQuiz(raw)).toThrow()
  })
})

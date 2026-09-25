import { describe, expect, it } from 'vitest'
import { assignSpeakers, buildSpeechSegments, splitDialogue, splitSentences } from './tts'

describe('splitSentences', () => {
  it('splits CJK sentences keeping the terminator', () => {
    expect(splitSentences('灯亮了。他走了！真的吗？')).toEqual(['灯亮了。', '他走了！', '真的吗？'])
  })

  it('splits western sentences', () => {
    expect(splitSentences('First one. Second one!')).toEqual(['First one.', 'Second one!'])
  })

  it('splits on paragraph breaks', () => {
    expect(splitSentences('第一段。\n\n第二段。')).toEqual(['第一段。', '第二段。'])
  })

  it('cuts an unterminated run at a comma boundary', () => {
    const long = '很'.repeat(100) + '，' + '长'.repeat(300)
    const sentences = splitSentences(long)
    expect(sentences.length).toBeGreaterThan(1)
    for (const sentence of sentences) {
      expect(sentence.length).toBeLessThanOrEqual(220)
    }
  })

  it('returns empty for empty text', () => {
    expect(splitSentences('')).toEqual([])
  })
})

describe('splitDialogue', () => {
  it('separates quoted dialogue from narration', () => {
    const segments = splitDialogue('他推门进来。「你来了。」她头也不抬。')
    expect(segments.map((s) => s.speaker)).toEqual(['narrator', 'narrator', 'narrator'])
    expect(segments[1]!.text).toBe('「你来了。」')
  })

  it('handles western quotes', () => {
    const segments = splitDialogue('He said "Sit down." and left.')
    expect(segments.some((s) => s.text.includes('"Sit down."'))).toBe(true)
  })

  it('keeps plain narration intact', () => {
    expect(splitDialogue('没有对话的段落。')).toEqual([
      { text: '没有对话的段落。', speaker: 'narrator' },
    ])
  })
})

describe('assignSpeakers', () => {
  it('attributes dialogue to the single character named nearby', () => {
    const segments = splitDialogue('张三说：「走吧。」李四说：「去哪？」')
    const named = assignSpeakers(segments, ['张三', '李四'])
    expect(named[0]).toEqual({ text: '张三说：', speaker: 'narrator' })
    expect(named[1]!.speaker).toBe('张三')
    expect(named[3]!.speaker).toBe('李四')
  })

  it('keeps ambiguous dialogue with the narrator', () => {
    const segments = splitDialogue('张三和李四都说：「走吧。」')
    const named = assignSpeakers(segments, ['张三', '李四'])
    expect(named[0]!.speaker).toBe('narrator')
  })

  it('leaves everything alone without known names', () => {
    const segments = splitDialogue('「你来了。」')
    expect(assignSpeakers(segments, [])).toEqual(segments)
  })
})

describe('buildSpeechSegments sentence granularity', () => {
  it('splits both narration and dialogue into individual sentences', () => {
    // 回归:对话框曾整段成段(可能几百字),歌词页失去逐句高亮能力。
    const segments = buildSpeechSegments(
      '他推门进来。窗外正下着雨，很久都没有停。「你来了。」她头也不抬。',
    )
    expect(segments.map((s) => s.text)).toEqual([
      '他推门进来。',
      '窗外正下着雨，很久都没有停。',
      '「你来了。」',
      '她头也不抬。',
    ])
  })
})

describe('buildSpeechSegments', () => {
  it('runs the full pipeline', () => {
    const plan = buildSpeechSegments('夜里，张三低声道：「灯灭了。」', ['张三'])
    expect(plan.length).toBeGreaterThanOrEqual(2)
    expect(plan.some((s) => s.speaker === '张三')).toBe(true)
  })
})

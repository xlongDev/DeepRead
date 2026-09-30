import { describe, expect, it } from 'vitest'
import {
  assignSpeakers,
  buildSpeechSegments,
  splitDialogue,
  splitSentences,
  splitSentencesWithOffsets,
} from './tts'

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

  it('keeps CJK semicolon-joined sentences intact when short', () => {
    // 软 ender:短句里不切,读起来是同一句。
    const out = splitSentences(
      '黑麦威士忌流过食管进入胃，贝罕感到一阵轻微的灼烧感；而后，酒精迅速通过黏膜保护屏障弥散侵入上皮细胞，上百方细胞死亡。',
    )
    expect(out).toEqual([
      '黑麦威士忌流过食管进入胃，贝罕感到一阵轻微的灼烧感；而后，酒精迅速通过黏膜保护屏障弥散侵入上皮细胞，上百方细胞死亡。',
    ])
  })

  it('cuts CJK semicolon when the buffer grows past the soft threshold', () => {
    // 软 ender:超长就切,避免一句包到合成上限之后被硬切。
    const long = '很'.repeat(60) + '；' + '长'.repeat(60) + '。'
    const sentences = splitSentences(long)
    expect(sentences.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps western abbreviations intact', () => {
    // 西文 ender 只看 ender 后是否空白/末尾。Dr. (3 字符) 还会被
    // mergeShort 合回去。Prof. (5 字符) 不被合,可观察到切分。
    const prof = splitSentences('Prof. Smith arrived.')
    expect(prof).toEqual(['Prof.', 'Smith arrived.'])
    // 但纯文本里句子完整切。
    expect(splitSentences('First one. Second one!')).toEqual(['First one.', 'Second one!'])
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

describe('splitSentencesWithOffsets', () => {
  it('start 是原文下标 —— 空白计入后续句子的偏移', () => {
    const text = '标题\n正文第一句。正文第二句。'
    expect(splitSentencesWithOffsets(text)).toEqual([
      { text: '标题', start: 0 },
      { text: '正文第一句。', start: 3 },
      { text: '正文第二句。', start: 9 },
    ])
  })

  it('不合并短句 —— 短标题各自独立(高亮要的是「一句」,不是「一段」)', () => {
    expect(splitSentencesWithOffsets('甲\n乙\n丙').map((s) => s.text)).toEqual(['甲', '乙', '丙'])
  })

  it('每一片的切片在原文里确实位于自己的 start', () => {
    const text = '第一。\n\n第二句短。\n很长的一段没有标点'.repeat(3)
    for (const slice of splitSentencesWithOffsets(text)) {
      expect(text.slice(slice.start, slice.start + slice.text.length)).toBe(slice.text)
    }
  })

  it('连续空白不产出空句子', () => {
    const out = splitSentencesWithOffsets('甲。\n\n\n乙。')
    expect(out.map((s) => s.text)).toEqual(['甲。', '乙。'])
    expect(out[1]!.start).toBe(5)
  })

  it('与 splitSentences 对同一文本给出相同的句子集合(只是多了位置)', () => {
    const text = '灯亮了。他走了！真的吗？'
    expect(splitSentencesWithOffsets(text).map((s) => s.text)).toEqual(splitSentences(text))
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

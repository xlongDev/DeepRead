import { describe, expect, it, vi } from 'vitest'

import {
  buildSpeechUnits,
  queuePosition,
  speakerRoles,
  stepIndex,
  unitAtChar,
  washSpan,
  wordCues,
  type SpeechUnit,
} from './tts'

describe('buildSpeechUnits', () => {
  it('cuts sentences with chapter-absolute offsets', () => {
    const units = buildSpeechUnits('灯亮了。他走了。')
    expect(units.map((u) => u.text)).toEqual(['灯亮了。', '他走了。'])
    expect(units.map((u) => [u.start, u.end])).toEqual([
      [0, 4],
      [4, 8],
    ])
    expect(units.every((u) => u.speaker === 'narrator')).toBe(true)
  })

  it('keeps quotes inside their sentence — no cut at the quote boundary', () => {
    // 回归:旧模型按引号跨度切单元,一句话被切成好几段音频,段间缝隙听得见
    // (「遇到引号停顿一下」)。一句一呼吸:引号属于句子,不属于切点。
    const units = buildSpeechUnits('他说:“你好。”就走了。')
    expect(units.map((u) => u.text)).toEqual(['他说:“你好。”', '就走了。'])
    const quoted = buildSpeechUnits('「谢谢你。」雅子回答:「不用谢。」两人沉默了。')
    expect(quoted.map((u) => u.text)).toEqual([
      '「谢谢你。」',
      '雅子回答:「不用谢。」',
      '两人沉默了。',
    ])
  })

  it('leaves a standalone dialogue line as its own unit (multi-voice intact)', () => {
    // 多角色配音的常见写法:对白整句一句,后面跟叙述tag。
    const units = buildSpeechUnits('“你好。”他说,“我来了。”')
    expect(units.map((u) => u.text)).toEqual(['“你好。”', '他说,“我来了。”'])
  })

  it('every unit is a slice of the raw text (engine charIndex maps back 1:1)', () => {
    const text = '标题\n正文第一句。\n他说:“你好。”\n第二段完了。'
    const units = buildSpeechUnits(text)
    expect(units.length).toBeGreaterThan(1)
    for (const unit of units) {
      expect(text.slice(unit.start, unit.end)).toBe(unit.text)
      expect(unit.text).toBe(unit.text.trim())
    }
  })

  it('keeps offsets honest across block boundaries (virtual newline)', () => {
    // walkSectionText 在块级元素之间插 '\n':空白本身不产出单元,但计入 start。
    const units = buildSpeechUnits('标题\n正文一句。')
    expect(units.map((u) => u.text)).toEqual(['标题', '正文一句。'])
    expect(units[1]!.start).toBe(3)
    expect(units[1]!.end).toBe(8)
  })

  it('attributes a quote-carrying sentence to the single character named nearby', () => {
    const text = '青柳说:「谢谢你。」雅子回答:「不用谢。」两人沉默了。'
    const units = buildSpeechUnits(text, ['青柳', '雅子'])
    expect(units.map((u) => u.text)).toEqual([
      '青柳说:「谢谢你。」',
      '雅子回答:「不用谢。」',
      '两人沉默了。',
    ])
    expect(units.map((u) => u.speaker)).toEqual(['青柳', '雅子', 'narrator'])
    for (const unit of units) {
      expect(text.slice(unit.start, unit.end)).toBe(unit.text)
    }
  })

  it('keeps ambiguous dialogue with the narrator', () => {
    // 两个名字都提到 = 认领不了,不猜。
    const units = buildSpeechUnits('张三和李四都说:「走吧。」', ['张三', '李四'])
    expect(units[0]!.speaker).toBe('narrator')
  })

  it('leaves everything to the narrator without known names', () => {
    const units = buildSpeechUnits('青柳说:「谢谢你。」')
    expect(units.map((u) => u.speaker)).toEqual(['narrator'])
  })

  it('cuts an unterminated over-long run into bounded pieces (offsets preserved)', () => {
    // 安全网:一句没有任何终止符地跑过 220 字,按逗号切,每片仍是原文切片。
    const long = '很'.repeat(100) + '，' + '长'.repeat(300)
    const units = buildSpeechUnits(long)
    expect(units.length).toBeGreaterThan(1)
    for (const unit of units) {
      expect(unit.text.length).toBeLessThanOrEqual(220)
      expect(long.slice(unit.start, unit.end)).toBe(unit.text)
    }
    // 切片首尾相接,没有丢字。
    expect(units.map((u) => u.text).join('')).toBe(long)
  })

  it('returns empty for empty or whitespace-only text', () => {
    expect(buildSpeechUnits('')).toEqual([])
    expect(buildSpeechUnits('  \n\n ')).toEqual([])
  })

  it('falls back to the regex cutter where Intl.Segmenter is missing', async () => {
    const segmenter = (Intl as { Segmenter?: unknown }).Segmenter
    ;(Intl as { Segmenter?: unknown }).Segmenter = undefined
    vi.resetModules()
    try {
      const { buildSpeechUnits: build } = await import('./tts')
      const units = build('他说:“你好。”就走了。')
      // 回退正则同样把收尾引号挂在句末标点之后,不在引号边界切。
      expect(units.map((u) => u.text)).toEqual(['他说:“你好。”', '就走了。'])
    } finally {
      ;(Intl as { Segmenter?: unknown }).Segmenter = segmenter
      vi.resetModules()
    }
  })
})

describe('speakerRoles', () => {
  it('counts units per character, narrator excluded', () => {
    const units = buildSpeechUnits('青柳说:「谢谢你。」雅子回答:「不用谢。」', ['青柳', '雅子'])
    expect(speakerRoles(units)).toEqual([
      { name: '青柳', count: 1 },
      { name: '雅子', count: 1 },
    ])
  })
})

describe('wordCues', () => {
  it('maps timed words onto the text, in spoken order', () => {
    const cues = wordCues('你好世界', [
      { at: 0, text: '你好' },
      { at: 0.4, text: '世界' },
    ])
    expect(cues).toEqual([
      { at: 0, start: 0, end: 2 },
      { at: 0.4, start: 2, end: 4 },
    ])
  })

  it('resolves a repeated word to the occurrence being spoken', () => {
    const cues = wordCues('好的好的好的', [
      { at: 0, text: '好的' },
      { at: 0.3, text: '好的' },
    ])
    expect(cues.map((c) => c.start)).toEqual([0, 2])
  })

  it('drops words the text does not contain', () => {
    // 引擎会把数字规范化成读法 —— 那个词不在正文里,不能硬造偏移。
    const cues = wordCues('2024 年', [{ at: 0, text: '二零二四' }])
    expect(cues).toEqual([])
  })
})

describe('washSpan', () => {
  const unit: SpeechUnit = { text: '他走了。', source: 0, start: 4, end: 8, speaker: 'narrator' }

  it('sentence level washes the whole unit', () => {
    expect(washSpan(0, unit, null, 'sentence')).toEqual({ start: 4, end: 8 })
  })

  it('word level waits for the first boundary', () => {
    expect(washSpan(0, unit, null, 'word')).toBeNull()
  })

  it('word level washes the reported word, shifted into the chapter', () => {
    expect(washSpan(0, unit, { unit: 0, charIndex: 1, charLength: 2 }, 'word')).toEqual({
      start: 5,
      end: 7,
    })
  })

  it('ignores a boundary that belongs to another unit', () => {
    expect(washSpan(0, unit, { unit: 1, charIndex: 0, charLength: 2 }, 'word')).toBeNull()
  })

  it('falls back to the segmenter when the engine reports no length', () => {
    // Safari 的 boundary 事件只有 charIndex。
    const span = washSpan(0, unit, { unit: 0, charIndex: 0, charLength: 0 }, 'word')
    expect(span).not.toBeNull()
    expect(span!.start).toBe(4)
    expect(span!.end).toBeGreaterThan(4)
  })
})

describe('queuePosition / unitAtChar', () => {
  const units = buildSpeechUnits('一句。二句。三句。')

  it('counts spoken and total characters', () => {
    expect(queuePosition(units, null)).toEqual({ spoken: 0, total: 9 })
    expect(queuePosition(units, 1)).toEqual({ spoken: 3, total: 9 })
  })

  it('maps an accumulated character position back to its unit', () => {
    expect(unitAtChar(units, 0)).toBe(0)
    expect(unitAtChar(units, 4)).toBe(1)
    expect(unitAtChar(units, 999)).toBe(2)
  })

  it('counts utterance text, not raw offsets — newlines belong to no unit', () => {
    // 两个空间的文档化说明:unitAtChar/queuePosition 活在「累加字符」空间,
    // unit.start/end 活在「章节真实偏移」空间。块间 \n 只进后者。
    // 「声音在哪」永远由引擎报的单元下标回答;把真实偏移喂给 unitAtChar
    // 反推单元会随换行数漂移(词级高亮直接失效)。
    const withBreaks = buildSpeechUnits('甲甲。\n乙乙。')
    expect(withBreaks.map((u) => u.start)).toEqual([0, 4])
    expect(queuePosition(withBreaks, null).total).toBe(6)
  })

  it('steps one unit, clamped to the queue', () => {
    expect(stepIndex(units, 0, 1)).toBe(1)
    expect(stepIndex(units, 2, 1)).toBe(2)
    expect(stepIndex(units, 0, -1)).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import {
  blockSeekRatio,
  formatClock,
  locateBlock,
  nextRate,
  sentenceIndexAt,
  splitChapterBlocks,
  totalChars,
  voicesForLanguage,
  withOffsets,
} from './tts-plan'

/** 造句子列表 + 与之匹配的原文('a' 连续、无间隙)。 */
function sentencesOf(...lengths: readonly number[]): {
  readonly text: string
  readonly sentences: ReturnType<typeof withOffsets>
} {
  const sentences = withOffsets(lengths.map((n) => 'a'.repeat(n)))
  return { text: sentences.map((s) => s.text).join(''), sentences }
}

describe('withOffsets', () => {
  it('累加字符起点', () => {
    const list = withOffsets(['abc', 'de', 'f'])
    expect(list).toEqual([
      { text: 'abc', start: 0 },
      { text: 'de', start: 3 },
      { text: 'f', start: 5 },
    ])
  })

  it('空输入得到空列表', () => {
    expect(withOffsets([])).toEqual([])
  })
})

describe('splitChapterBlocks', () => {
  it('按 max 攒块,块起点是首句起点', () => {
    const { text, sentences } = sentencesOf(4, 4, 4)
    const blocks = splitChapterBlocks(text, sentences, 8)
    expect(blocks).toEqual([
      { text: 'aaaaaaaa', start: 0 },
      { text: 'aaaa', start: 8 },
    ])
  })

  it('单句超过 max 时自己成一块,不被切碎', () => {
    const { text, sentences } = sentencesOf(10, 2)
    const blocks = splitChapterBlocks(text, sentences, 8)
    expect(blocks).toEqual([
      { text: 'a'.repeat(10), start: 0 },
      { text: 'aa', start: 10 },
    ])
  })

  it('块文本是原文切片 —— 句间空白留在块内,块内推进才不偏格', () => {
    // 回归:块文本若只拼句子、丢掉句间的换行,块内 ratio*length 的换算
    // 每过一个句界就偏一格,高亮越读越偏。
    const text = '甲。\n乙。'
    const sentences = [
      { text: '甲。', start: 0 },
      { text: '乙。', start: 3 },
    ]
    const blocks = splitChapterBlocks(text, sentences, 100)
    expect(blocks).toEqual([{ text: '甲。\n乙。', start: 0 }])
  })

  it('空输入得到空列表', () => {
    expect(splitChapterBlocks('', [])).toEqual([])
  })
})

describe('locateBlock', () => {
  const blocks = [
    { text: 'aaaa', start: 0 },
    { text: 'bbbb', start: 4 },
    { text: 'cc', start: 8 },
  ]

  it('落在块内返回该块下标', () => {
    expect(locateBlock(blocks, 0)).toBe(0)
    expect(locateBlock(blocks, 3)).toBe(0)
    expect(locateBlock(blocks, 4)).toBe(1)
    expect(locateBlock(blocks, 9)).toBe(2)
  })

  it('恰好等于块尾(下一个块的首字)归下一块', () => {
    expect(locateBlock(blocks, 4)).toBe(1)
    expect(locateBlock(blocks, 8)).toBe(2)
  })

  it('越过章末返回 -1', () => {
    expect(locateBlock(blocks, 10)).toBe(-1)
  })

  it('空块列表返回 -1', () => {
    expect(locateBlock([], 0)).toBe(-1)
  })

  it('「块尾」可作下一块的入口(游标推进用)', () => {
    // 播完块 0(0..3)后从 4 进块 1;播完块 2 后从 10 越界。
    expect(locateBlock(blocks, blocks[0]!.start + blocks[0]!.text.length)).toBe(1)
    expect(locateBlock(blocks, blocks[2]!.start + blocks[2]!.text.length)).toBe(-1)
  })
})

describe('blockSeekRatio', () => {
  const block = { text: 'abcdefgh', start: 100 }

  it('起点等于块起始时不跳', () => {
    expect(blockSeekRatio(block, 100)).toBe(0)
  })

  it('起点在块起始之前时按 0 处理', () => {
    expect(blockSeekRatio(block, 50)).toBe(0)
  })

  it('句中续播换算成块内比例', () => {
    expect(blockSeekRatio(block, 104)).toBe(0.5)
    expect(blockSeekRatio(block, 102)).toBe(0.25)
  })
})

describe('sentenceIndexAt', () => {
  const sentences = withOffsets(['aa', 'bb', 'cc'])

  it('落在首句时返回 0', () => {
    expect(sentenceIndexAt(sentences, 0)).toBe(0)
    expect(sentenceIndexAt(sentences, 1)).toBe(0)
  })

  it('落在后续句时返回对应下标', () => {
    expect(sentenceIndexAt(sentences, 2)).toBe(1)
    expect(sentenceIndexAt(sentences, 4)).toBe(2)
  })

  it('超出总长时停在最后一句', () => {
    expect(sentenceIndexAt(sentences, 999)).toBe(2)
  })

  it('空列表返回 0', () => {
    expect(sentenceIndexAt([], 0)).toBe(0)
  })
})

describe('totalChars', () => {
  it('累加全部句长', () => {
    expect(totalChars(withOffsets(['abc', 'de']))).toBe(5)
  })

  it('空列表为 0', () => {
    expect(totalChars([])).toBe(0)
  })
})

describe('voicesForLanguage', () => {
  const voices = [
    { lang: 'zh-CN', name: 'A' },
    { lang: 'zh-TW', name: 'B' },
    { lang: 'en-US', name: 'C' },
  ]

  it('同语言前缀优先,下划线与横线等价', () => {
    const mixed = [
      { lang: 'zh_CN', name: 'A' },
      { lang: 'zh-TW', name: 'B' },
    ]
    expect(voicesForLanguage(mixed, 'zh-CN')).toEqual(mixed)
  })

  it('同语言不足两条时回退全部', () => {
    expect(voicesForLanguage(voices, 'en')).toEqual(voices)
  })

  it('无语言信息时返回原列表', () => {
    expect(voicesForLanguage(voices, undefined)).toEqual(voices)
  })

  it('语言大小写不敏感', () => {
    expect(voicesForLanguage(voices, 'ZH-cn')).toHaveLength(2)
  })
})

describe('formatClock', () => {
  it('按 m:ss 补零', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(5)).toBe('0:05')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(3600)).toBe('60:00')
  })

  it('四舍五入并压掉负值', () => {
    expect(formatClock(59.6)).toBe('1:00')
    expect(formatClock(-10)).toBe('0:00')
  })
})

describe('nextRate', () => {
  const rates = [0.75, 1, 1.25] as const

  it('循环到下一档', () => {
    expect(nextRate(rates, 0.75)).toBe(1)
    expect(nextRate(rates, 1.25)).toBe(0.75)
  })

  it('未收录的速率回落到第一档', () => {
    expect(nextRate(rates, 3)).toBe(0.75)
    expect(nextRate(rates, 0)).toBe(0.75)
  })
})

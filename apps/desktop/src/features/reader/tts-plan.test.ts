import { describe, expect, it } from 'vitest'
import { buildSpeechUnits } from '@deepread/reader-core'
import {
  formatClock,
  locateSpeechUnit,
  nextRate,
  sentencesOf,
  unitAtOffset,
  voicesForLanguage,
} from './tts-plan'

describe('sentencesOf', () => {
  it('单元 → 歌词页行,顺序与下标即队列顺序', () => {
    const units = buildSpeechUnits('灯亮了。他走了。')
    expect(sentencesOf(units)).toEqual([
      { text: '灯亮了。', start: 0 },
      { text: '他走了。', start: 4 },
    ])
  })

  it('空输入得到空列表', () => {
    expect(sentencesOf(buildSpeechUnits(''))).toEqual([])
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

describe('locateSpeechUnit', () => {
  const units = buildSpeechUnits('灯亮了。他走了。天亮了。')

  it('选区盖住整句:从第一句被选中的单元起播', () => {
    expect(locateSpeechUnit(units, '他走了。')).toBe(1)
  })

  it('选区跨多句:从最早被盖住的那句起播', () => {
    expect(locateSpeechUnit(units, '他走了。天亮了。')).toBe(1)
  })

  it('选区是句子中间一节:取包含选区开头的最早单元', () => {
    expect(locateSpeechUnit(units, '走了')).toBe(1)
  })

  it('从句中开始划、开头 8 字跨句界:缩短前缀也要落回起点那句', () => {
    const long = buildSpeechUnits('第一句话在这里。第二句话才是划线目标。第三句话接着念。')
    // 固定 8 字头跨句界(「才是划线目标。第」谁也不包含)→ 旧实现回 0(章首)。
    // 缩短到 7 字「才是划线目」唯第二句包含 → 下标 1。
    expect(locateSpeechUnit(long, '才是划线目标。第三句话')).toBe(1)
    // 单字选区:8 字头就是它本身,缩短循环不能把这个行为改丢。
    expect(locateSpeechUnit(long, '第')).toBe(0)
  })

  it('空白形态不一致也认得出(正文换行 vs 选区单空格)', () => {
    const wrapped = buildSpeechUnits('第一句。\n第二句在这里。\n第三句。')
    expect(locateSpeechUnit(wrapped, '第二句在这里。')).toBe(1)
  })

  it('空选区 / 空队列回 0', () => {
    expect(locateSpeechUnit(units, '   ')).toBe(0)
    expect(locateSpeechUnit([], '灯亮了。')).toBe(0)
  })

  it('完全对不上也回 0(从章首念,好过不念)', () => {
    expect(locateSpeechUnit(units, '这段话不在正文里')).toBe(0)
  })
})

describe('unitAtOffset', () => {
  const units = buildSpeechUnits('灯亮了。他走了。天亮了。')

  it('落在单元内:精确归位', () => {
    expect(unitAtOffset(units, 0)).toBe(0)
    expect(unitAtOffset(units, 4)).toBe(1)
    expect(unitAtOffset(units, 8)).toBe(2)
  })

  it('落在单元之间的块级空白里:归下一句(选区从段首开始划)', () => {
    // 「灯亮了。」占 [0,4),「他走了。」占 [4,8);offset 4 恰是下一句起点。
    expect(unitAtOffset(units, 3)).toBe(0)
    expect(unitAtOffset(units, 4)).toBe(1)
  })

  it('越过章末:钳到最后一句', () => {
    expect(unitAtOffset(units, 999)).toBe(units.length - 1)
    expect(unitAtOffset([], 5)).toBe(0)
  })
})

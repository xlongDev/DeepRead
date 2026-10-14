import { describe, expect, it } from 'vitest'
import { buildSpeechUnits } from '@deepread/reader-core'
import { formatClock, nextRate, sentencesOf, voicesForLanguage } from './tts-plan'

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

import { describe, expect, it } from 'vitest'
import {
  applyConversions,
  buildConvertMessages,
  conversionRuleLabel,
  parseConversions,
} from './convert'

const SOURCE = '燈芯偶爾響一聲,照着空房間。'
const SIMPLE = '灯芯偶尔响一声,照着空房间。'

describe('buildConvertMessages', () => {
  it('states the direction and keeps the verbatim-find contract', () => {
    const messages = buildConvertMessages(SOURCE, 't2s')
    expect(messages[0]?.content).toContain('繁→简')
    expect(messages[0]?.content).toContain('逐字出现')
    // 不许顺手改标点/改写句子 —— 那是校对,不是转换。
    expect(messages[0]?.content).toContain('不要改标点')
    expect(messages[1]?.content).toContain('燈芯')
  })

  it('flips the direction for s2t', () => {
    expect(conversionRuleLabel('s2t')).toBe('简→繁')
    expect(buildConvertMessages(SOURCE, 's2t')[0]?.content).toContain('简→繁')
  })
})

describe('parseConversions', () => {
  it('anchors valid conversions and tags the rule', () => {
    const conversions = parseConversions(
      '{"corrections":[{"find":"燈芯","replace":"灯芯","reason":"转换"},{"find":"響一聲","replace":"响一声","reason":"转换"}]}',
      SOURCE,
      't2s',
    )
    expect(conversions).toHaveLength(2)
    expect(conversions[0]).toMatchObject({
      find: '燈芯',
      replace: '灯芯',
      rule: 't2s',
      occurrences: 1,
    })
    // id 带方向:两个方向的提案在同一次评审里不会互相顶掉。
    expect(conversions[0]?.id.startsWith('t2s-')).toBe(true)
    const back = parseConversions(
      '{"corrections":[{"find":"灯芯","replace":"燈芯","reason":"转换"}]}',
      SIMPLE,
      's2t',
    )
    expect(back[0]?.id.startsWith('s2t-')).toBe(true)
  })

  it('drops conversions whose find is absent or unchanged', () => {
    const conversions = parseConversions(
      '{"corrections":[{"find":"不存在的字","replace":"x","reason":"转换"},{"find":"空房間","replace":"空房間","reason":"无变化"}]}',
      SOURCE,
      't2s',
    )
    expect(conversions).toHaveLength(0)
  })

  it('keeps multi-occurrence finds but marks the count', () => {
    const conversions = parseConversions(
      '{"corrections":[{"find":"一","replace":"一","reason":"转换"}]}',
      SOURCE,
      't2s',
    )
    expect(conversions).toHaveLength(0) // find === replace 直接被丢
    const real = parseConversions(
      '{"corrections":[{"find":"燈","replace":"灯","reason":"转换"}]}',
      SOURCE,
      't2s',
    )
    expect(real[0]?.occurrences).toBe(1)
  })

  it('returns empty for unparseable output', () => {
    expect(parseConversions('没有 JSON', SOURCE, 't2s')).toHaveLength(0)
    expect(
      parseConversions('{"corrections":[{"find":"","replace":"","reason":""}]}', SOURCE, 't2s'),
    ).toHaveLength(0)
  })
})

describe('applyConversions', () => {
  it('applies only accepted unique matches', () => {
    const conversions = parseConversions(
      '{"corrections":[{"find":"燈芯","replace":"灯芯","reason":"转换"},{"find":"房間","replace":"房间","reason":"转换"}]}',
      SOURCE,
      't2s',
    )
    const result = applyConversions(SOURCE, conversions, [conversions[0]!.id])
    expect(result).toEqual({ text: SOURCE.replace('燈芯', '灯芯'), applied: 1, skipped: 0 })
  })

  it('skips accepted conversions whose match is no longer unique', () => {
    const text = '乾 燥 的 乾 燥'
    const conversions = parseConversions(
      '{"corrections":[{"find":"乾","replace":"干","reason":"转换"}]}',
      text,
      't2s',
    )
    const result = applyConversions(text, conversions, [conversions[0]!.id])
    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.text).toBe(text)
  })

  it('is a no-op when nothing is accepted', () => {
    const conversions = parseConversions(
      '{"corrections":[{"find":"燈芯","replace":"灯芯","reason":"转换"}]}',
      SOURCE,
      't2s',
    )
    expect(applyConversions(SOURCE, conversions, []).text).toBe(SOURCE)
  })
})

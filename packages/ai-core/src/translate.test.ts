import { describe, expect, it } from 'vitest'
import {
  buildTranslateMessages,
  parseTranslation,
  streamTranslationView,
  TRANSLATE_MAX_CHARS,
} from './translate'

describe('buildTranslateMessages', () => {
  it('把片段、目标语言与所在段落一起交给模型', () => {
    const messages = buildTranslateMessages({
      text: '灯芯偶尔响一声。',
      targetLang: 'English',
      context: '化雪的时候,镇上的人把灯点了起来。灯芯偶尔响一声。',
    })
    expect(messages[1]?.content).toContain('灯芯偶尔响一声。')
    expect(messages[1]?.content).toContain('【目标语言】English')
    expect(messages[1]?.content).toContain('【所在段落】')
    // 输出协议写进 system:流式渲染靠它拆节。
    expect(messages[0]?.content).toContain('LANG:')
    expect(messages[0]?.content).toContain('---')
  })

  it('术语表可选:给了就一定进 prompt', () => {
    const withGlossary = buildTranslateMessages({
      text: '青柳站在门口。',
      targetLang: '中文',
      glossary: [{ from: 'Aoyagi', to: '青柳' }],
    })
    expect(withGlossary[0]?.content).toContain('Aoyagi → 青柳')
    const without = buildTranslateMessages({ text: '青柳站在门口。', targetLang: '中文' })
    expect(without[0]?.content).not.toContain('术语表')
    expect(without[1]?.content).not.toContain('【所在段落】')
  })
})

describe('streamTranslationView', () => {
  it('协议头没收全之前不给正文(避免渲染半截 LANG 行)', () => {
    expect(streamTranslationView('LANG:zh-CN')).toEqual({ lang: null, body: '' })
  })

  it('收到分隔符后就能边收边渲染译文', () => {
    const view = streamTranslationView('LANG:en\n---\nThe wick crackled')
    expect(view).toEqual({ lang: 'en', body: 'The wick crackled' })
  })

  it('第二节(备注)不进正文', () => {
    const view = streamTranslationView('LANG:en\n---\n译文\n---\n备注一行')
    expect(view.body).toBe('译文')
  })
})

describe('parseTranslation', () => {
  it('收完校验:语言 + 译文 + 可选备注', () => {
    expect(parseTranslation('LANG:zh-CN\n---\nThe wick crackled.')).toEqual({
      detectedLang: 'zh-CN',
      translation: 'The wick crackled.',
    })
    expect(parseTranslation('LANG:zh-CN\n---\n译文\n---\n专名按表\n语气偏书面')).toEqual({
      detectedLang: 'zh-CN',
      translation: '译文',
      notes: ['专名按表', '语气偏书面'],
    })
  })

  it('空译文与缺失语言都是报错,不让空壳进 UI', () => {
    expect(() => parseTranslation('LANG:zh-CN\n---\n   ')).toThrow()
    expect(() => parseTranslation('')).toThrow()
  })

  it('单次上限是 2000 字 —— 再长就该分段', () => {
    expect(TRANSLATE_MAX_CHARS).toBe(2000)
  })
})

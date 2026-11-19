import { describe, expect, it } from 'vitest'

import { quoteLayout, wrapLines } from './quote-card'

/** 量宽 = 字符数 × 10(CJK/西文同价),断言只关心结构不关心真排版。 */
const measure = (text: string): number => text.length * 10

describe('金句卡折行', () => {
  it('CJK 逐字断行,标点跟着字走', () => {
    const lines = wrapLines(measure, '春眠不觉晓，处处闻啼鸟。', 50)
    expect(lines).toEqual(['春眠不觉晓，', '处处闻啼鸟。'])
  })

  it('西文按词断行,不在词中间切', () => {
    const lines = wrapLines(measure, 'The quiet sea keeps every secret', 150)
    expect(lines.join(' ')).toBe('The quiet sea keeps every secret')
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(150)
    expect(lines).toEqual(['The quiet sea', 'keeps every', 'secret'])
  })

  it('超宽单词独占一行(再长也不丢字符)', () => {
    const lines = wrapLines(measure, 'short extraordinarylongword', 50)
    expect(lines).toEqual(['short', 'extraordinarylongword'])
  })

  it('多段落各自折行,空段丢弃', () => {
    const lines = wrapLines(measure, '第一段。\n\n第二段。', 50)
    expect(lines).toEqual(['第一段。', '第二段。'])
  })

  it('行尾空白与行首空白不进结果', () => {
    const lines = wrapLines(measure, '  开头  空白  结尾  ', 60)
    expect(lines[0]).not.toMatch(/^\s/)
    expect(lines.at(-1)).not.toMatch(/\s$/)
    expect(lines.join('')).toContain('开头')
    expect(lines.join('')).toContain('结尾')
  })
})

describe('分享卡排版决策(quoteLayout)', () => {
  // 假量宽:每个字符按 fontSize × 0.9 计(CJK 视觉宽近似),宽度随字号缩放。
  const measureAt = (fontSize: number, text: string): number => [...text].length * fontSize * 0.9

  it('短句给大字号,长句收敛到小字号', () => {
    const short = quoteLayout(measureAt, '雪落在灯塔上。', 900)
    expect(short.fontSize).toBe(58)
    const mid = quoteLayout(measureAt, '甲'.repeat(100), 900)
    expect(mid.fontSize).toBe(50)
    const long = quoteLayout(measureAt, '甲'.repeat(300), 900)
    expect(long.fontSize).toBe(44)
  })

  it('行数封顶:溢出在末行打省略号且如实上报 truncated', () => {
    const layout = quoteLayout(measureAt, '甲'.repeat(300), 900)
    expect(layout.lines).toHaveLength(12)
    expect(layout.lines[11]?.endsWith('…')).toBe(true)
    expect(layout.truncated).toBe(true)
  })

  it('版心装得下就不打省略号', () => {
    const layout = quoteLayout(measureAt, '雪落在灯塔上,像一封很长的信。守灯人把火拨旺。', 900)
    expect(layout.truncated).toBe(false)
    expect(layout.lines.at(-1)?.endsWith('…')).toBe(false)
  })

  it('码点截断:emoji 不会被切成半个代理对', () => {
    const layout = quoteLayout(measureAt, '⭐'.repeat(450), 900)
    expect(layout.truncated).toBe(true)
    // 450 个 ⭐ 截到 400:末行内容里不应出现乱码 replacement char。
    expect(layout.lines.join('').includes('\uFFFD')).toBe(false)
  })
})

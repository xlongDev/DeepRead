import { describe, expect, it } from 'vitest'

import { wrapLines } from './quote-card'

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

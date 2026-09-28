import { describe, expect, it } from 'vitest'
import { buildReadingStats, type ReadingIndicatorInput } from './reading-indicators'

/** 默认:中文书、内核未报页码、无字数统计 —— 等价于刚打开还没算完的状态。 */
function input(overrides: Partial<ReadingIndicatorInput> = {}): ReadingIndicatorInput {
  return {
    location: undefined,
    fraction: 0,
    bookLanguage: undefined,
    sectionChars: null,
    bookCharStats: null,
    wordsScope: 'section',
    ...overrides,
  }
}

describe('页码', () => {
  it('有合法页码时按 `当前 / 总数 页` 输出', () => {
    expect(buildReadingStats(input({ location: { current: 3, total: 10 } })).page).toBe('3 / 10 页')
  })

  it('总页数为 0 时不算页码(内核占位值,不是真的 0 页)', () => {
    expect(buildReadingStats(input({ location: { current: 0, total: 0 } })).page).toBeNull()
  })

  it('内核没报位置时为 null', () => {
    expect(buildReadingStats(input()).page).toBeNull()
  })
})

describe('预计剩余时间 · 有全书字数统计时', () => {
  it('按 CJK/西文加权估算', () => {
    // 4000 汉字,起点:4000/400 = 10 分钟
    const stats = buildReadingStats(
      input({ bookCharStats: { total: 4000, cjk: 4000 }, fraction: 0 }),
    )
    expect(stats.time).toBe('约剩 10 分钟')
  })

  it('读到一半时剩余时间减半', () => {
    const stats = buildReadingStats(
      input({ bookCharStats: { total: 4000, cjk: 4000 }, fraction: 0.5 }),
    )
    expect(stats.time).toBe('约剩 5 分钟')
  })

  it('中英混排按各自速率加权', () => {
    // 400 汉字(1 分钟) + 250 西文词(1 分钟) = 2 分钟
    const stats = buildReadingStats(input({ bookCharStats: { total: 650, cjk: 400 }, fraction: 0 }))
    expect(stats.time).toBe('约剩 2 分钟')
  })

  it('读完(fraction=1)时压到最少 1 分钟,不显示 0', () => {
    const stats = buildReadingStats(
      input({ bookCharStats: { total: 4000, cjk: 4000 }, fraction: 1 }),
    )
    expect(stats.time).toBe('约剩 1 分钟')
  })

  it('fraction 越界被夹住:大于 1 与小于 0 都不产生负时间', () => {
    const over = buildReadingStats(
      input({ bookCharStats: { total: 4000, cjk: 4000 }, fraction: 1.5 }),
    )
    expect(over.time).toBe('约剩 1 分钟')
    const under = buildReadingStats(
      input({ bookCharStats: { total: 4000, cjk: 4000 }, fraction: -0.5 }),
    )
    // 夹到 1 → 全量剩余 = 10 分钟
    expect(under.time).toBe('约剩 10 分钟')
  })

  it('长书用小时标签', () => {
    // 读一半,剩 30000 字 → 75 分钟 → 1 小时 15 分钟
    const stats = buildReadingStats(
      input({ bookCharStats: { total: 60000, cjk: 60000 }, fraction: 0.5 }),
    )
    expect(stats.time).toBe('约剩 1 小时 15 分钟')
  })

  it('统计里总字数为 0 时不算(空书 / 解析失败)', () => {
    const stats = buildReadingStats(
      input({
        bookCharStats: { total: 0, cjk: 0 },
        fraction: 0.5,
        location: { current: 1, total: 4 },
      }),
    )
    // 退回按页估算,而不是显示 0 分钟
    expect(stats.time).toBe('约剩 3 分钟')
  })
})

describe('预计剩余时间 · 无字数统计(固定排版)时按页估算', () => {
  const location = { current: 50, total: 100 }

  it('中文排版每页按 90 秒', () => {
    // (1-0.5) * 100 页 * 90s = 4500s = 75 分钟
    const stats = buildReadingStats(input({ location, fraction: 0.5, bookLanguage: 'zh-CN' }))
    expect(stats.time).toBe('约剩 1 小时 15 分钟')
  })

  it('西文排版每页按 45 秒', () => {
    // (1-0.5) * 100 * 45 = 2250s = 37.5 → 38 分钟
    const stats = buildReadingStats(input({ location, fraction: 0.5, bookLanguage: 'en-US' }))
    expect(stats.time).toBe('约剩 38 分钟')
  })

  it('语言未知时按中文算(每页 90 秒)', () => {
    const stats = buildReadingStats(input({ location, fraction: 0.5, bookLanguage: undefined }))
    expect(stats.time).toBe('约剩 1 小时 15 分钟')
  })

  it('日文 / 韩文也按 CJK 处理', () => {
    for (const language of ['ja', 'ko-KR']) {
      const stats = buildReadingStats(input({ location, fraction: 0.5, bookLanguage: language }))
      expect(stats.time).toBe('约剩 1 小时 15 分钟')
    }
  })

  it('尚未翻页(fraction=0)时不估时间 —— 起点估算会离谱', () => {
    const stats = buildReadingStats(input({ location, fraction: 0, bookLanguage: 'zh' }))
    expect(stats.time).toBeNull()
  })
})

describe('字数', () => {
  it('本章口径:当前章字数带千分位', () => {
    const stats = buildReadingStats(input({ sectionChars: 12345, wordsScope: 'section' }))
    expect(stats.chars).toBe('本章 12,345 字')
  })

  it('本章还没算出来时为 null', () => {
    expect(buildReadingStats(input({ sectionChars: null })).chars).toBeNull()
  })

  it('全书口径:大数用「万」缩写', () => {
    const stats = buildReadingStats(
      input({ bookCharStats: { total: 250_000, cjk: 250_000 }, wordsScope: 'book' }),
    )
    expect(stats.chars).toBe('全书 25万 字')
  })

  it('全书口径但统计不可用时为 null(不退回本章,避免口径混乱)', () => {
    const stats = buildReadingStats(
      input({ sectionChars: 500, bookCharStats: null, wordsScope: 'book' }),
    )
    expect(stats.chars).toBeNull()
  })

  it('本章口径下不受全书统计影响', () => {
    const stats = buildReadingStats(
      input({
        sectionChars: 999,
        bookCharStats: { total: 250_000, cjk: 250_000 },
        wordsScope: 'section',
      }),
    )
    expect(stats.chars).toBe('本章 999 字')
  })
})

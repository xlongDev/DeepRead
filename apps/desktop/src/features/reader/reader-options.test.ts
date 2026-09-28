import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_STATS_SETTINGS,
  loadPageTurnStyle,
  loadStatsSettings,
  persistPageTurnStyle,
  persistStatsSettings,
} from './reader-options'

beforeEach(() => {
  localStorage.clear()
})

describe('翻页动画偏好', () => {
  it('没有存储时回落默认档 slide', () => {
    expect(loadPageTurnStyle()).toBe('slide')
  })

  it('合法档位原样读回', () => {
    for (const style of ['none', 'slide', 'cover', 'flip', 'fade'] as const) {
      persistPageTurnStyle(style)
      expect(loadPageTurnStyle()).toBe(style)
    }
  })

  it('存储值非法时回落默认,而不是把坏值当档位用', () => {
    localStorage.setItem('deepread.reader.pageTurn', 'explode')
    expect(loadPageTurnStyle()).toBe('slide')
  })

  it('存储值是空串也回落默认', () => {
    localStorage.setItem('deepread.reader.pageTurn', '')
    expect(loadPageTurnStyle()).toBe('slide')
  })
})

describe('底栏显示偏好', () => {
  it('没有存储时返回全开的默认值', () => {
    expect(loadStatsSettings()).toEqual(DEFAULT_STATS_SETTINGS)
  })

  it('返回的是副本 —— 改它不会污染默认常量', () => {
    const loaded = loadStatsSettings()
    loaded.words = false
    expect(DEFAULT_STATS_SETTINGS.words).toBe(true)
  })

  it('写入后原样读回', () => {
    persistStatsSettings({ progress: false, words: true, time: false, wordsScope: 'book' })
    expect(loadStatsSettings()).toEqual({
      progress: false,
      words: true,
      time: false,
      wordsScope: 'book',
    })
  })

  it('坏 JSON 回落默认而不是抛错', () => {
    localStorage.setItem('deepread.reader.stats', '{ 这不是 json')
    expect(loadStatsSettings()).toEqual(DEFAULT_STATS_SETTINGS)
  })

  it('JSON 不是对象(数组 / null)回落默认', () => {
    localStorage.setItem('deepread.reader.stats', '[1,2,3]')
    expect(loadStatsSettings()).toEqual(DEFAULT_STATS_SETTINGS)
    localStorage.setItem('deepread.reader.stats', 'null')
    expect(loadStatsSettings()).toEqual(DEFAULT_STATS_SETTINGS)
  })

  it('逐字段校验:坏的那项回落,好的那项保留', () => {
    localStorage.setItem(
      'deepread.reader.stats',
      JSON.stringify({ progress: 'yes', words: false, time: 1, wordsScope: 'chapter' }),
    )
    expect(loadStatsSettings()).toEqual({
      progress: true, // 非 boolean → 默认 true
      words: false, // 合法 → 保留
      time: true, // 非 boolean → 默认 true
      wordsScope: 'section', // 只认 'book',其余一律 section
    })
  })

  it('缺失字段各自取默认', () => {
    localStorage.setItem('deepread.reader.stats', JSON.stringify({ words: false }))
    expect(loadStatsSettings()).toEqual({
      progress: true,
      words: false,
      time: true,
      wordsScope: 'section',
    })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CUSTOM_TYPOGRAPHY_DEFAULTS,
  DEFAULT_STATS_SETTINGS,
  layoutOverrides,
  loadPageTurnStyle,
  loadStatsSettings,
  loadTypography,
  materializeCustomDefaults,
  mergeTypography,
  PAGE_MARGIN_BLOCK_DEFAULT,
  PAGE_MARGIN_BLOCK_OPTIONS,
  PAGE_MARGIN_INLINE_DEFAULT,
  PAGE_MARGIN_INLINE_OPTIONS,
  persistPageTurnStyle,
  persistStatsSettings,
  persistTypography,
  TEXT_INDENT_OPTIONS,
  type TypographySettings,
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

describe('排版偏好持久化(书写方向 / 简繁转换)', () => {
  it('writingMode / zhConvert 写入后原样读回', () => {
    persistTypography({ writingMode: 'vertical-rl', zhConvert: 's2t' })
    const loaded = loadTypography()
    expect(loaded.writingMode).toBe('vertical-rl')
    expect(loaded.zhConvert).toBe('s2t')
  })

  it('显式 undefined 删键(选回「原书 / 不转换」不留旧值)', () => {
    persistTypography({ writingMode: 'vertical-rl', zhConvert: 's2t' })
    persistTypography({ writingMode: undefined, zhConvert: undefined })
    const raw = JSON.parse(localStorage.getItem('deepread.reader.typography') ?? '{}') as Record<
      string,
      unknown
    >
    expect('writingMode' in raw).toBe(false)
    expect('zhConvert' in raw).toBe(false)
  })

  it('两把边距标尺各自持久化:左右 / 上下分开存,互不覆盖', () => {
    persistTypography({ pageMargin: 24, pageMarginBlock: 120 })
    const loaded = loadTypography()
    expect(loaded.pageMargin).toBe(24)
    expect(loaded.pageMarginBlock).toBe(120)
  })
})

describe('原书排版总开关', () => {
  it('缺省开:一行偏好都没有过 → 书自己的排版赢(可覆盖项全不下发)', () => {
    expect(layoutOverrides({})).toEqual({
      lineHeight: undefined,
      fontFamily: undefined,
      fontWeight: undefined,
      paragraphMargin: undefined,
      textIndent: undefined,
      writingMode: undefined,
    })
  })

  it('关掉后按档位下发;某一行单独选回「原书」仍回到书自己的值', () => {
    const custom = { originalLayout: false, lineHeight: 1.9, fontWeight: undefined }
    expect(layoutOverrides(custom)).toMatchObject({
      lineHeight: 1.9,
      fontWeight: undefined,
    })
  })

  it('切到自定义:没选过的维度落到标准档 —— 否则关掉开关画面上一动不动', () => {
    const materialized = materializeCustomDefaults({ originalLayout: false })
    expect(materialized).toEqual(
      expect.objectContaining({
        fontSize: CUSTOM_TYPOGRAPHY_DEFAULTS.fontSize,
        lineHeight: CUSTOM_TYPOGRAPHY_DEFAULTS.lineHeight,
        fontFamily: CUSTOM_TYPOGRAPHY_DEFAULTS.fontFamily,
        fontWeight: CUSTOM_TYPOGRAPHY_DEFAULTS.fontWeight,
        paragraphMargin: CUSTOM_TYPOGRAPHY_DEFAULTS.paragraphMargin,
        textIndent: CUSTOM_TYPOGRAPHY_DEFAULTS.textIndent,
        writingMode: CUSTOM_TYPOGRAPHY_DEFAULTS.writingMode,
      }),
    )
  })

  it('已经选过的档位不被默认档盖掉', () => {
    const materialized = materializeCustomDefaults({
      originalLayout: false,
      lineHeight: 1.45,
      textIndent: 0,
      fontSize: 22,
    })
    expect(materialized.lineHeight).toBe(1.45)
    expect(materialized.textIndent).toBe(0)
    expect(materialized.fontSize).toBe(22)
  })

  it('切到自定义时字号落到 18px', () => {
    expect(CUSTOM_TYPOGRAPHY_DEFAULTS.fontSize).toBe(18)
    expect(materializeCustomDefaults({ originalLayout: false }).fontSize).toBe(18)
  })
})

describe('字体独立于原书排版总开关', () => {
  it('原书排版下选的字体照样下发 —— 读什么字体是读者口味,不是书的排版', () => {
    expect(layoutOverrides({ originalLayout: true, fontFamily: 'kaiti' })).toMatchObject({
      fontFamily: 'kaiti',
      lineHeight: undefined,
      textIndent: undefined,
    })
    // 缺省(没写过 originalLayout)也是同一个结论。
    expect(layoutOverrides({ fontFamily: 'songti' })).toMatchObject({
      fontFamily: 'songti',
      fontWeight: undefined,
    })
  })

  it('选回「原书」就是不再覆盖:undefined 一律不下发', () => {
    expect(layoutOverrides({ originalLayout: false, fontFamily: undefined })).toMatchObject({
      fontFamily: undefined,
    })
  })

  it('切到自定义不改写已经选过的字体(否则在原书模式下挑的字体会被冲掉)', () => {
    expect(
      materializeCustomDefaults({ originalLayout: false, fontFamily: 'wenkai' }).fontFamily,
    ).toBe('wenkai')
  })
})

describe('页边距与段首缩进档位表', () => {
  it('左右边距:标准 = 旧「特窄」那一档,四档按同一档差排开', () => {
    const values = PAGE_MARGIN_INLINE_OPTIONS.map((option) => option.value)
    expect(values).toEqual([24, 48, 72, 96])
    expect(PAGE_MARGIN_INLINE_DEFAULT).toBe(
      PAGE_MARGIN_INLINE_OPTIONS.find((option) => option.label === '标准')?.value,
    )
  })

  it('上下边距:标准沿用旧标准,档差与左右一致', () => {
    const values = PAGE_MARGIN_BLOCK_OPTIONS.map((option) => option.value)
    expect(values).toEqual([48, 72, 96, 120])
    expect(PAGE_MARGIN_BLOCK_DEFAULT).toBe(
      PAGE_MARGIN_BLOCK_OPTIONS.find((option) => option.label === '标准')?.value,
    )
  })

  it('段首缩进:不缩进 / 1 字符 / 2 字符', () => {
    expect(TEXT_INDENT_OPTIONS.map((option) => option.value)).toEqual([0, 1, 2])
  })
})

describe('mergeTypography(补丁合并)', () => {
  const base: TypographySettings = {
    originalLayout: false,
    fontSize: 18,
    fontFamily: 'kaiti',
    pageMargin: 96,
  }

  it('普通字段 ?? 合并,补丁未提到的保留现值', () => {
    expect(mergeTypography(base, { fontSize: 20 })).toMatchObject({
      fontSize: 20,
      fontFamily: 'kaiti',
      pageMargin: 96,
    })
  })

  it("显式 undefined = 复位到原书排版,必须赢过现值('in' 判定)", () => {
    expect(mergeTypography(base, { fontFamily: undefined }).fontFamily).toBeUndefined()
    // 没提 fontFamily 的补丁不能把现值冲掉。
    expect(mergeTypography(base, { fontSize: 16 }).fontFamily).toBe('kaiti')
  })

  it('originalLayout 只有显式给出才翻转(切换开关的瞬间)', () => {
    expect(mergeTypography(base, { fontSize: 20 }).originalLayout).toBe(false)
    expect(mergeTypography(base, { originalLayout: true }).originalLayout).toBe(true)
  })
})

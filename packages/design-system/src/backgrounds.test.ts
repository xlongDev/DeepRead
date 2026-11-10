import { describe, expect, it } from 'vitest'
import { ACCENT_DEFAULT, ACCENT_PRESETS } from './accents'
import {
  BACKGROUND_DEFAULT,
  BACKGROUND_SCHEMES,
  backgroundAccent,
  backgroundSwatch,
  parseBackground,
  wallpaperFor,
  wallpaperStops,
} from './backgrounds'

describe('background schemes', () => {
  it('keeps 15 schemes with unique ids and three hex stops per world', () => {
    expect(BACKGROUND_SCHEMES).toHaveLength(15)
    expect(new Set(BACKGROUND_SCHEMES.map((scheme) => scheme.id)).size).toBe(15)
    for (const scheme of BACKGROUND_SCHEMES) {
      for (const stop of [...scheme.light, ...scheme.dark]) {
        expect(stop).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('falls back to the pure-colour desktop for dirty storage', () => {
    expect(parseBackground(null)).toBe(BACKGROUND_DEFAULT)
    expect(parseBackground('not-a-scheme')).toBe(BACKGROUND_DEFAULT)
    expect(parseBackground('fresh')).toBe('fresh')
  })

  it('renders one gradient per world and nothing for the default', () => {
    expect(wallpaperFor('none', false)).toBeNull()
    const light = wallpaperFor('fresh', false)
    const dark = wallpaperFor('fresh', true)
    expect(light).toContain('#93c5fd')
    expect(dark).toContain('#60a5fa')
    expect(light).not.toBe(dark)
    expect(light?.match(/color-mix/g)).toHaveLength(3)
  })

  it('shares one stop source between CSS and the refraction canvas', () => {
    expect(wallpaperStops('none', false)).toBeNull()
    expect(wallpaperStops(parseBackground('garbage'), true)).toBeNull()
    const light = wallpaperStops('fresh', false)
    const dark = wallpaperStops('fresh', true)
    expect(light?.stops).toEqual(['#93c5fd', '#5eead4', '#86efac'])
    expect(dark?.stops).toEqual(['#60a5fa', '#2dd4bf', '#4ade80'])
    expect(light?.tint).toBe(46)
    expect(dark?.tint).toBe(22)
    // 乳白档的上限:再往上就是整片高饱和色块,会盖过文字(12-49 截图反馈)。
    // dark 永远比 light 淡,否则深底上亮得刺眼。
    expect(light?.tint).toBeLessThanOrEqual(50)
    expect(dark?.tint).toBeLessThan(light?.tint ?? 100)
    // 折射管线用同一组 stop 重画壁纸,别让 CSS 与 canvas 悄悄分色。
    expect(wallpaperFor('fresh', false)).toContain(light?.stops[0] ?? '')
    expect(wallpaperFor('fresh', true)).toContain(dark?.stops[0] ?? '')
  })

  it('每套主题自带一个强调色相,纯色桌面回落品牌蓝', () => {
    for (const scheme of BACKGROUND_SCHEMES) {
      expect(scheme.accent.h).toBeGreaterThanOrEqual(0)
      expect(scheme.accent.h).toBeLessThan(360)
      expect(scheme.accent.c).toBeGreaterThan(0)
      // 彩度不进项目的克制阶梯之外:再高就是营销页的高饱和色。
      expect(scheme.accent.c).toBeLessThanOrEqual(0.14)
    }
    // 十五套主题的色相不能全挤在一处,否则换主题看不出区别。
    expect(
      new Set(BACKGROUND_SCHEMES.map((scheme) => Math.round(scheme.accent.h / 20))).size,
    ).toBeGreaterThanOrEqual(10)

    const brand = ACCENT_PRESETS.find((preset) => preset.id === ACCENT_DEFAULT)
    expect(backgroundAccent('none', false)).toEqual({ h: brand?.hue, c: brand?.chroma })
    expect(backgroundAccent('fresh', false)).toEqual({ h: 181, c: 0.11 })
    // 深色世界统一收窄彩度,与 tokens.css 的 --accent-c 同档;色相不动。
    expect(backgroundAccent('fresh', true)).toEqual({ h: 181, c: 0.065 })
  })

  it('色标取原色,不掺表面色,并随明暗换一套', () => {
    expect(backgroundSwatch('none')).toBeNull()
    // 原色才分得清十五套:乳白档掺到 46% 以后小色条几乎全白。
    expect(backgroundSwatch('fresh')).toContain('#93c5fd')
    expect(backgroundSwatch('fresh')).not.toContain('color-mix')
    expect(backgroundSwatch('fresh', true)).toContain('#60a5fa')
    expect(backgroundSwatch('fresh', true)).not.toBe(backgroundSwatch('fresh'))
  })
})

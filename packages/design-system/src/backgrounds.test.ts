import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_DEFAULT,
  BACKGROUND_SCHEMES,
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
})

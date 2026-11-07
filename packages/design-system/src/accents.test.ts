import { describe, expect, it } from 'vitest'
import {
  ACCENT_DEFAULT,
  ACCENT_PRESETS,
  accentPreview,
  onAccentFor,
  parseAccent,
  serializeAccent,
} from './accents'

describe('强调色偏好', () => {
  it('空值与脏值回落默认品牌蓝', () => {
    expect(parseAccent(null)).toEqual({ kind: 'preset', id: ACCENT_DEFAULT })
    expect(parseAccent('custom:not-a-color')).toEqual({ kind: 'preset', id: ACCENT_DEFAULT })
    expect(parseAccent('neon')).toEqual({ kind: 'preset', id: ACCENT_DEFAULT })
  })

  it('预设与自定义都能往返', () => {
    for (const preset of ACCENT_PRESETS) {
      const choice = { kind: 'preset' as const, id: preset.id }
      expect(parseAccent(serializeAccent(choice))).toEqual(choice)
    }
    const custom = { kind: 'custom' as const, hex: '#3a7d8c' }
    expect(parseAccent(serializeAccent(custom))).toEqual(custom)
    expect(parseAccent('custom:#3A7D8C')).toEqual(custom)
  })

  it('自定义色的文字按亮度翻墨色/近白', () => {
    expect(onAccentFor('#ffffff')).toBe('#1d1b17')
    expect(onAccentFor('#f0ede5')).toBe('#1d1b17')
    expect(onAccentFor('#101010')).toBe('#f7f5f0')
    expect(onAccentFor('#2f6470')).toBe('#f7f5f0')
    expect(onAccentFor('bad')).toBe('#f7f5f0')
  })

  it('预览色用与 :root 相同的 OKLCH 三元组', () => {
    const brand = ACCENT_PRESETS.find((preset) => preset.id === ACCENT_DEFAULT)!
    expect(accentPreview(brand.hue, brand.chroma)).toBe('oklch(0.48 0.14 271)')
  })

  it('默认预设是目录第一项,且取桌面 logo 的蓝紫色相', () => {
    expect(ACCENT_DEFAULT).toBe('brand')
    expect(ACCENT_PRESETS[0]).toMatchObject({ id: 'brand', hue: 271 })
    expect(ACCENT_PRESETS).toHaveLength(6)
  })
})

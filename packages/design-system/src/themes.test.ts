import { describe, expect, it } from 'vitest'
import {
  APP_THEME_CHOICES,
  APP_THEMES,
  applyInitialAppTheme,
  parseAppThemeChoice,
  resolveAppTheme,
  systemPrefersDark,
} from './themes'

describe('app theme choices', () => {
  it('puts 跟随系统 first and keeps the three CSS worlds behind it', () => {
    expect(APP_THEME_CHOICES).toHaveLength(APP_THEMES.length + 1)
    expect(APP_THEME_CHOICES[0]).toMatchObject({ id: 'system', label: '跟随系统' })
    expect(APP_THEME_CHOICES.slice(1).map((item) => item.id)).toEqual(
      APP_THEMES.map((theme) => theme.id),
    )
  })

  it('resolves 跟随系统 to pure white in light mode and night in dark mode', () => {
    expect(resolveAppTheme('system', false)).toBe('pure-white')
    expect(resolveAppTheme('system', true)).toBe('dark')
  })

  it('never lets the OS override an explicit world', () => {
    for (const theme of APP_THEMES) {
      expect(resolveAppTheme(theme.id, false)).toBe(theme.id)
      expect(resolveAppTheme(theme.id, true)).toBe(theme.id)
    }
  })

  it('defaults to 跟随系统 and still migrates the v1 ids', () => {
    expect(parseAppThemeChoice(null)).toBe('system')
    expect(parseAppThemeChoice('')).toBe('system')
    expect(parseAppThemeChoice('not-a-theme')).toBe('system')
    expect(parseAppThemeChoice('dark')).toBe('dark')
    expect(parseAppThemeChoice('graphite')).toBe('dark')
    expect(parseAppThemeChoice('warm-paper')).toBe('pure-white')
  })

  it('stays safe outside a browser (node test env has no window/document)', () => {
    expect(systemPrefersDark()).toBe(false)
    expect(() => applyInitialAppTheme()).not.toThrow()
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { darkTheme, lightTheme, themeCssVariables, themes } from './tokens'
import { APP_THEMES } from './themes'
import { ACCENT_DEFAULT, ACCENT_PRESETS } from './accents'
import { MOTION, prefersReducedMotion } from './motion'

// Read directly from disk: vitest stubs CSS imports (css: false), and the raw
// import must reflect the real shipped file anyway.
const cssText = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function extractVarNames(text: string): Set<string> {
  const names = new Set<string>()
  const pattern = /(--[a-z0-9-]+)\s*:/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    names.add(match[1] ?? '')
  }
  return names
}

/** Values declared in the first `:root` block — the runtime base palette. */
function rootVarValues(text: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
  const values = new Map<string, string>()
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) {
    values.set(match[1] ?? '', (match[2] ?? '').trim())
  }
  return values
}

describe('theme tokens', () => {
  it('exposes exactly the same variable names as tokens.css', () => {
    const cssVars = extractVarNames(cssText)
    for (const [name, value] of Object.entries(themeCssVariables(lightTheme))) {
      expect(cssVars.has(name), `missing ${name} (${value}) in tokens.css`).toBe(true)
    }
  })

  it('keeps app-theme overrides to a subset of declared variables', () => {
    const cssVars = extractVarNames(cssText)
    const start = cssText.indexOf("[data-app-theme='dark']")
    expect(start).toBeGreaterThan(-1)
    const darkBlock = cssText.slice(start, cssText.indexOf('\n}', start))
    expect(darkBlock).not.toBe('')
    const darkVars = [...extractVarNames(darkBlock)]
    for (const name of darkVars) {
      expect(cssVars.has(name), `dark override ${name} is not declared in :root`).toBe(true)
    }
    // The old `[data-theme='dark']` branch had no writer and its white
    // --color-on-accent contradicted the live dark theme. Never bring it back.
    expect(cssText).not.toContain("[data-theme='dark']")
  })

  it('has exactly one CSS block per catalogued app theme', () => {
    const ids = [...cssText.matchAll(/\[data-app-theme='([^']+)'\]/g)].map((match) => match[1])
    for (const theme of APP_THEMES) {
      // pure-white is the :root default, so it has no block of its own.
      if (theme.id === 'pure-white') continue
      expect(ids, `missing CSS block for ${theme.id}`).toContain(theme.id)
    }
    for (const id of ids) {
      expect(
        APP_THEMES.some((theme) => theme.id === id),
        `unlisted CSS theme ${id}`,
      ).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the unstyled :root on the default accent (no first-frame flash)', () => {
    const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(cssText)?.[1] ?? ''
    const preset = ACCENT_PRESETS.find((item) => item.id === ACCENT_DEFAULT)
    expect(preset).toBeDefined()
    expect(rootBlock).toContain(`--accent-h: ${preset?.hue}`)
    expect(rootBlock).toContain(`--accent-c: ${preset?.chroma}`)
  })

  it('has one CSS preset block per catalogued accent', () => {
    const ids = [...cssText.matchAll(/\[data-accent='([^']+)'\]/g)].map((match) => match[1])
    for (const preset of ACCENT_PRESETS) {
      expect(ids, `missing CSS block for ${preset.id}`).toContain(preset.id)
      const block = new RegExp(`\\[data-accent='${preset.id}'\\]\\s*\\{([^}]+)\\}`).exec(
        cssText,
      )?.[1]
      expect(block, `empty CSS block for ${preset.id}`).toBeTruthy()
      expect(block).toContain(`--accent-h: ${preset.hue}`)
      expect(block).toContain(`--accent-c: ${preset.chroma}`)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the typed mirror aligned with the :root palette', () => {
    const root = rootVarValues(cssText)
    const expected: Record<string, string> = {
      '--color-bg': lightTheme.colors.bg,
      '--color-surface': lightTheme.colors.surface,
      '--color-surface-glass': lightTheme.colors.surfaceGlass,
      '--color-text-primary': lightTheme.colors.textPrimary,
      '--color-accent': lightTheme.colors.accent,
    }
    for (const [name, value] of Object.entries(expected)) {
      expect(root.get(name), `${name} drifted from tokens.css`).toBe(value)
    }
  })

  it('玻璃底在每个世界都写字面色,不跨变量求值', () => {
    // 自定义属性里的 var() 在声明它的元素上就求值;WebKit 会把它锁在 :root
    // 那份浅色表面上,深色世界的玻璃整片发白(20:22 截图)。三个世界的玻璃
    // 底因此必须是字面色,不能写 color-mix(… var(--color-surface) …)。
    for (const theme of ['dark', 'oled']) {
      const block =
        new RegExp(`\\[data-app-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(cssText)?.[1] ??
        ''
      expect(block, `${theme} block missing`).toBeTruthy()
      expect(block, `${theme} 的玻璃底退回了跨变量派生`).toMatch(/--glass-wallpaper-bg: rgba\(/)
      expect(block, `${theme} 的浮层底退回了跨变量派生`).toMatch(/--glass-tint: rgba\(/)
      expect(block, `${theme} 的内凹面退回了跨变量派生`).toMatch(/--surface-sunk: rgb/)
    }
    expect(rootVarValues(cssText).get('--glass-wallpaper-bg')).toMatch(/^rgba\(/)
  })

  it('light and dark themes differ in colors but share structure', () => {
    expect(themes.light.colorScheme).toBe('light')
    expect(themes.dark.colorScheme).toBe('dark')
    expect(Object.keys(themeCssVariables(lightTheme)).sort()).toEqual(
      Object.keys(themeCssVariables(darkTheme)).sort(),
    )
    expect(lightTheme.colors.bg).not.toBe(darkTheme.colors.bg)
  })

  it('radius scale is monotonically increasing', () => {
    const radius = lightTheme.radius
    const values = [radius.sm, radius.md, radius.lg, radius.xl].map((v) => parseFloat(v))
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]
      const current = values[i]
      expect(prev !== undefined && current !== undefined ? current > prev : false).toBe(true)
    }
  })

  it('colors use low-saturation, readable values (restrained palette)', () => {
    // Guard against the "high saturation" anti-pattern from spec §11.
    // Explicit keys: Object.values() on an interface degrades to any[].
    const colorKeys = [
      'bg',
      'surface',
      'surfaceGlass',
      'textPrimary',
      'textSecondary',
      'textTertiary',
      'accent',
      'accentSoft',
      'border',
      'danger',
      'dangerSoft',
      'success',
    ] as const satisfies readonly (keyof typeof lightTheme.colors)[]

    for (const key of colorKeys) {
      const color: string = lightTheme.colors[key]
      const hex = /^#([0-9a-f]{6})$/i.exec(color)
      if (!hex) continue // rgba(...) tokens are covered by design review
      const value = hex[1] ?? ''
      const r = parseInt(value.slice(0, 2), 16)
      const g = parseInt(value.slice(2, 4), 16)
      const b = parseInt(value.slice(4, 6), 16)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const saturation = max === 0 ? 0 : (max - min) / max
      expect(saturation, `color ${color} is too saturated`).toBeLessThan(0.75)
    }
  })
})

describe('wallpaper glass tokens', () => {
  it('gives each dark world its own smoky-glass variant', () => {
    for (const id of ['dark', 'oled']) {
      const block =
        new RegExp(`\\[data-app-theme='${id}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(cssText)?.[1] ?? ''
      for (const name of [
        '--glass-wallpaper-bg',
        '--glass-wallpaper-sheen',
        '--glass-wallpaper-edge',
        '--glass-wallpaper-filter',
        '--glass-wallpaper-veil',
      ]) {
        expect(block, `${id} is missing ${name}`).toContain(name)
      }
    }
  })

  it('keeps the wallpaper filter neutral instead of amplifying colour', () => {
    // 淡彩壁纸被 saturate(1.8)+brightness(1.06) 推成整块高饱和青绿会晃眼。
    // 提亮必须配降饱和:1.8 饱和 + 1.06 提亮才把壁纸推成高饱和色块;
    // 0.85 饱和 + 1.05 提亮读成一层干净的冷调,是玻璃该有的样子。
    const pairs = [...cssText.matchAll(/--glass-wallpaper-(?:filter|veil):([^;]*);/g)].map(
      (match) => match[1] ?? '',
    )
    expect(pairs.length).toBeGreaterThanOrEqual(6) // :root + dark + oled × filter/veil
    for (const decl of pairs) {
      const saturate = Number(/saturate\(([\d.]+)\)/.exec(decl)?.[1] ?? 1)
      const brightness = Number(/brightness\(([\d.]+)\)/.exec(decl)?.[1] ?? 1)
      expect(saturate, decl).toBeLessThanOrEqual(1.2)
      expect(brightness, decl).toBeLessThanOrEqual(1.06)
      if (brightness > 1)
        expect(saturate, `brightness>1 必须配降饱和:${decl}`).toBeLessThanOrEqual(1)
    }
  })

  it('turns wallpaper glass solid under reduced transparency and forced colours', () => {
    const reduced =
      /@media \(prefers-reduced-transparency: reduce\)\s*\{([\s\S]*?)\n\}/.exec(cssText)?.[1] ?? ''
    const forced = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/.exec(cssText)?.[1] ?? ''
    expect(reduced).toContain('--glass-wallpaper-bg: var(--color-surface)')
    expect(forced).toContain('--glass-wallpaper-bg: Canvas')
    for (const block of [reduced, forced]) {
      expect(block).toContain('--glass-wallpaper-filter: none')
      expect(block).toContain('--glass-wallpaper-veil: none')
    }
  })
})

describe('motion tokens', () => {
  it('defines durations and easings consistent with the CSS mirror', () => {
    expect(MOTION.durationFastMs).toBe(150)
    expect(MOTION.durationBaseMs).toBe(250)
    expect(MOTION.durationSlowMs).toBe(400)
    expect(MOTION.easeOut).toBe(lightTheme.motion.easeOut)
    expect(MOTION.easeInOut).toBe(lightTheme.motion.easeInOut)
  })

  it('reports reduced motion safely outside a browser', () => {
    // jsdom/node: matchMedia may exist or not; the helper must never throw.
    expect(typeof prefersReducedMotion()).toBe('boolean')
  })

  it('springs are critically-to-underdamped and positive', () => {
    for (const spring of [MOTION.springSnappy, MOTION.springGentle]) {
      expect(spring.stiffness).toBeGreaterThan(0)
      expect(spring.damping).toBeGreaterThan(0)
      expect(spring.mass).toBeGreaterThan(0)
      expect(spring.damping).toBeLessThan(2 * Math.sqrt(spring.stiffness * spring.mass))
    }
  })
})

/**
 * Design tokens — the TypeScript mirror of `tokens.css` (spec §10 / §18).
 *
 * `tokens.css` is the runtime source; this file is the typed source used by
 * logic and tests. `tokens.test.ts` keeps the two in sync by asserting that
 * every variable emitted here exists in the CSS.
 *
 * Visual direction (spec §11): Apple-inspired Liquid Glass — restrained,
 * calm, premium. Never at the cost of readability.
 */

export interface ColorTokens {
  readonly bg: string
  readonly surface: string
  /** Semi-transparent surface for Liquid Glass panels. */
  readonly surfaceGlass: string
  readonly textPrimary: string
  readonly textSecondary: string
  readonly textTertiary: string
  readonly accent: string
  readonly accentSoft: string
  readonly border: string
  readonly danger: string
  /** Tinted danger background for destructive hover/armed states. */
  readonly dangerSoft: string
  readonly success: string
}

export interface TypographyTokens {
  readonly fontSans: string
  readonly fontSerif: string
  readonly fontMono: string
  readonly fontSize2xs: string
  readonly fontSizeXs: string
  readonly fontSizeSm: string
  readonly fontSizeMd: string
  readonly fontSizeLg: string
  readonly fontSizeXl: string
  readonly fontSize2xl: string
  readonly fontSize3xl: string
  readonly fontWeightRegular: number
  readonly fontWeightMedium: number
  readonly fontWeightSemibold: number
  readonly lineHeightTight: number
  readonly lineHeightBody: number
  readonly leading2xs: number
  readonly leadingXs: number
  readonly leadingSm: number
  readonly leadingMd: number
  readonly leadingLg: number
  readonly leadingXl: number
  readonly leading2xl: number
  readonly leading3xl: number
}

/** Keyed by pixel value — the number *is* the size, no xs/sm/md mapping. */
export interface SpacingTokens {
  readonly s2: string
  readonly s4: string
  readonly s6: string
  readonly s8: string
  readonly s10: string
  readonly s12: string
  readonly s14: string
  readonly s16: string
  readonly s20: string
  readonly s24: string
  readonly s32: string
  readonly s40: string
  readonly s48: string
  readonly s64: string
}

export interface RadiusTokens {
  readonly xs: string
  readonly sm: string
  readonly md: string
  readonly lg: string
  readonly xl: string
  readonly full: string
}

export interface ShadowTokens {
  readonly soft: string
  readonly elevated: string
}

export interface BlurTokens {
  readonly glass: string
  readonly glassHeavy: string
}

export interface MotionCssTokens {
  readonly durationFast: string
  readonly durationBase: string
  readonly durationSlow: string
  readonly easeOut: string
  readonly easeInOut: string
}

export interface ThemeTokens {
  readonly name: string
  readonly colorScheme: 'light' | 'dark'
  readonly colors: ColorTokens
  readonly typography: TypographyTokens
  readonly spacing: SpacingTokens
  readonly radius: RadiusTokens
  readonly shadow: ShadowTokens
  readonly blur: BlurTokens
  readonly motion: MotionCssTokens
}

export const lightTheme: ThemeTokens = {
  name: 'Pure White',
  colorScheme: 'light',
  colors: {
    bg: '#f6f5f2',
    surface: '#ffffff',
    surfaceGlass: 'rgba(255, 255, 255, 0.62)',
    textPrimary: '#1d1b17',
    textSecondary: '#6f6a61',
    textTertiary: '#9c968b',
    accent: '#3d6deb',
    accentSoft: 'rgba(61, 109, 235, 0.12)',
    border: 'rgba(29, 27, 23, 0.10)',
    danger: '#c4453d',
    dangerSoft: 'rgba(196, 69, 61, 0.12)',
    success: '#2f8a5b',
  },
  typography: {
    fontSans:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    fontSerif: '"Iowan Old Style", Palatino, "Songti SC", "Noto Serif CJK SC", serif',
    fontMono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize2xs: '11px',
    fontSizeXs: '12px',
    fontSizeSm: '13px',
    fontSizeMd: '15px',
    fontSizeLg: '17px',
    fontSizeXl: '20px',
    fontSize2xl: '24px',
    fontSize3xl: '30px',
    fontWeightRegular: 400,
    fontWeightMedium: 500,
    fontWeightSemibold: 600,
    lineHeightTight: 1.25,
    lineHeightBody: 1.6,
    leading2xs: 1.4,
    leadingXs: 1.45,
    leadingSm: 1.5,
    leadingMd: 1.55,
    leadingLg: 1.5,
    leadingXl: 1.4,
    leading2xl: 1.32,
    leading3xl: 1.22,
  },
  spacing: {
    s2: '2px',
    s4: '4px',
    s6: '6px',
    s8: '8px',
    s10: '10px',
    s12: '12px',
    s14: '14px',
    s16: '16px',
    s20: '20px',
    s24: '24px',
    s32: '32px',
    s40: '40px',
    s48: '48px',
    s64: '64px',
  },
  radius: {
    xs: '4px',
    sm: '8px',
    md: '10px',
    lg: '12px',
    xl: '16px',
    full: '9999px',
  },
  shadow: {
    soft: '0 1px 2px rgba(20, 18, 14, 0.04), 0 8px 24px rgba(20, 18, 14, 0.06)',
    elevated: '0 2px 6px rgba(20, 18, 14, 0.06), 0 16px 48px rgba(20, 18, 14, 0.10)',
  },
  blur: {
    glass: '18px',
    glassHeavy: '32px',
  },
  motion: {
    durationFast: '150ms',
    durationBase: '250ms',
    durationSlow: '400ms',
    easeOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
    easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  },
}

export const darkTheme: ThemeTokens = {
  name: 'Dark',
  colorScheme: 'dark',
  colors: {
    bg: '#131210',
    surface: '#1d1b18',
    surfaceGlass: 'rgba(29, 27, 24, 0.55)',
    textPrimary: '#ece9e3',
    textSecondary: '#a39d92',
    textTertiary: '#6f6a61',
    accent: '#6e93f6',
    accentSoft: 'rgba(110, 147, 246, 0.16)',
    border: 'rgba(236, 233, 227, 0.12)',
    danger: '#e0706a',
    dangerSoft: 'rgba(224, 112, 106, 0.16)',
    success: '#5cb886',
  },
  typography: lightTheme.typography,
  spacing: lightTheme.spacing,
  radius: lightTheme.radius,
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.40), 0 8px 24px rgba(0, 0, 0, 0.35)',
    elevated: '0 2px 6px rgba(0, 0, 0, 0.45), 0 16px 48px rgba(0, 0, 0, 0.50)',
  },
  blur: lightTheme.blur,
  motion: lightTheme.motion,
}

export const themes = { light: lightTheme, dark: darkTheme } as const

export type ThemeName = keyof typeof themes

const colorVars = (c: ColorTokens): Record<string, string> => ({
  '--color-bg': c.bg,
  '--color-surface': c.surface,
  '--color-surface-glass': c.surfaceGlass,
  '--color-text-primary': c.textPrimary,
  '--color-text-secondary': c.textSecondary,
  '--color-text-tertiary': c.textTertiary,
  '--color-accent': c.accent,
  '--color-accent-soft': c.accentSoft,
  '--color-border': c.border,
  '--color-danger': c.danger,
  '--color-danger-soft': c.dangerSoft,
  '--color-success': c.success,
})

const typographyVars = (t: TypographyTokens): Record<string, string> => ({
  '--font-sans': t.fontSans,
  '--font-serif': t.fontSerif,
  '--font-mono': t.fontMono,
  '--font-size-2xs': t.fontSize2xs,
  '--font-size-xs': t.fontSizeXs,
  '--font-size-sm': t.fontSizeSm,
  '--font-size-md': t.fontSizeMd,
  '--font-size-lg': t.fontSizeLg,
  '--font-size-xl': t.fontSizeXl,
  '--font-size-2xl': t.fontSize2xl,
  '--font-size-3xl': t.fontSize3xl,
  '--font-weight-regular': String(t.fontWeightRegular),
  '--font-weight-medium': String(t.fontWeightMedium),
  '--font-weight-semibold': String(t.fontWeightSemibold),
  '--line-height-tight': String(t.lineHeightTight),
  '--line-height-body': String(t.lineHeightBody),
  '--leading-2xs': String(t.leading2xs),
  '--leading-xs': String(t.leadingXs),
  '--leading-sm': String(t.leadingSm),
  '--leading-md': String(t.leadingMd),
  '--leading-lg': String(t.leadingLg),
  '--leading-xl': String(t.leadingXl),
  '--leading-2xl': String(t.leading2xl),
  '--leading-3xl': String(t.leading3xl),
})

const spacingVars = (s: SpacingTokens): Record<string, string> => ({
  '--space-2': s.s2,
  '--space-4': s.s4,
  '--space-6': s.s6,
  '--space-8': s.s8,
  '--space-10': s.s10,
  '--space-12': s.s12,
  '--space-14': s.s14,
  '--space-16': s.s16,
  '--space-20': s.s20,
  '--space-24': s.s24,
  '--space-32': s.s32,
  '--space-40': s.s40,
  '--space-48': s.s48,
  '--space-64': s.s64,
})

const radiusVars = (r: RadiusTokens): Record<string, string> => ({
  '--radius-xs': r.xs,
  '--radius-sm': r.sm,
  '--radius-md': r.md,
  '--radius-lg': r.lg,
  '--radius-xl': r.xl,
  '--radius-full': r.full,
})

const shadowVars = (s: ShadowTokens): Record<string, string> => ({
  '--shadow-soft': s.soft,
  '--shadow-elevated': s.elevated,
})

const blurVars = (b: BlurTokens): Record<string, string> => ({
  '--blur-glass': b.glass,
  '--blur-glass-heavy': b.glassHeavy,
})

const motionVars = (m: MotionCssTokens): Record<string, string> => ({
  '--duration-fast': m.durationFast,
  '--duration-base': m.durationBase,
  '--duration-slow': m.durationSlow,
  '--ease-out': m.easeOut,
  '--ease-in-out': m.easeInOut,
})

/** All CSS custom properties a theme provides, keyed by CSS variable name. */
export function themeCssVariables(theme: ThemeTokens): Record<string, string> {
  return {
    ...colorVars(theme.colors),
    ...typographyVars(theme.typography),
    ...spacingVars(theme.spacing),
    ...radiusVars(theme.radius),
    ...shadowVars(theme.shadow),
    ...blurVars(theme.blur),
    ...motionVars(theme.motion),
  }
}

/**
 * Accent catalog — the single source of truth for signal colours.
 *
 * `tokens.css` owns the runtime values: presets only change hue/chroma, while
 * each app theme (paper / graphite / OLED) supplies its own lightness. That
 * split is why one preset stays readable in all three worlds without a second
 * palette. A custom sRGB hex overrides `--color-accent` itself from JS; the
 * soft / hover / on-accent derivations all read that variable and follow.
 */

export type AccentPreset = 'brand' | 'teal' | 'terra' | 'forest' | 'ink' | 'plum'

/** 桌面 App logo 的蓝紫是默认强调色;色相取自图标实测像素,见 DESIGN.md。 */
export const ACCENT_DEFAULT: AccentPreset = 'brand'

export const ACCENT_PRESETS: readonly {
  readonly id: AccentPreset
  readonly label: string
  readonly hue: number
  readonly chroma: number
}[] = [
  // logo 圆角方块是 #486ce3 → #5861d8 的蓝色渐变,平均 #5268de
  // (OKLCH L.564 / C.181 / H271.5)。彩度按本项目的克制阶梯收到 0.14,
  // 明度仍由主题块给 —— 直接照搬 L.56/C.18 会让纸底上的白字掉出 AA。
  { id: 'brand', label: '品牌蓝', hue: 271, chroma: 0.14 },
  { id: 'teal', label: '墨青', hue: 210, chroma: 0.055 },
  { id: 'terra', label: '赭石', hue: 45, chroma: 0.085 },
  { id: 'forest', label: '松绿', hue: 165, chroma: 0.06 },
  { id: 'ink', label: '墨蓝', hue: 255, chroma: 0.07 },
  { id: 'plum', label: '绛紫', hue: 320, chroma: 0.06 },
]

export const ACCENT_STORAGE_KEY = 'deepread.accent'

export type AccentChoice =
  | { readonly kind: 'preset'; readonly id: AccentPreset }
  | { readonly kind: 'custom'; readonly hex: string }

const HEX = /^#[0-9a-f]{6}$/i

export function parseAccent(raw: string | null): AccentChoice {
  if (raw === null) return { kind: 'preset', id: ACCENT_DEFAULT }
  if (raw.startsWith('custom:')) {
    const hex = raw.slice('custom:'.length)
    return HEX.test(hex)
      ? { kind: 'custom', hex: hex.toLowerCase() }
      : { kind: 'preset', id: ACCENT_DEFAULT }
  }
  return ACCENT_PRESETS.some((preset) => preset.id === raw)
    ? { kind: 'preset', id: raw as AccentPreset }
    : { kind: 'preset', id: ACCENT_DEFAULT }
}

export function serializeAccent(choice: AccentChoice): string {
  return choice.kind === 'preset' ? choice.id : `custom:${choice.hex.toLowerCase()}`
}

/** Preview swatch: the same OKLCH triple the paper theme uses at runtime. */
export function accentPreview(hue: number, chroma: number): string {
  return `oklch(0.48 ${chroma} ${hue})`
}

/**
 * Foreground for a custom accent, picked by WCAG relative luminance.
 * 0.21 is the crossover where ink and near-white both clear 4.5:1; below it
 * white wins, above it ink wins. Guards the one thing a free colour picker
 * cannot guarantee: button text that stays readable on any chosen colour.
 */
export function onAccentFor(hex: string): string {
  if (!HEX.test(hex)) return '#f7f5f0'
  const n = Number.parseInt(hex.slice(1), 16)
  const linear = (shift: number): number => {
    const v = ((n >> shift) & 255) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0)
  return luminance > 0.21 ? '#1d1b17' : '#f7f5f0'
}

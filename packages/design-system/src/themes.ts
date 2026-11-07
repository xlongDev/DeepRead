/**
 * App shell theme catalog — the single source of truth for which themes exist.
 *
 * `tokens.css` owns the runtime values (`[data-app-theme='…']`); this file owns
 * the ids, labels and picker swatches. `tokens.test.ts` asserts the two stay in
 * sync, so adding a theme without a CSS block (or vice versa) fails the gate.
 * `pure-white` is the `:root` default and therefore has no CSS block of its own.
 *
 * v2: three worlds instead of twelve near-duplicates. The old ids are mapped
 * onto these in `LibraryScreen` so saved preferences survive the migration.
 */
export type AppTheme = 'pure-white' | 'dark' | 'oled'

export const APP_THEMES: readonly {
  readonly id: AppTheme
  readonly label: string
  /** Mini page preview: background + ink. Accent is a separate axis now. */
  readonly swatch: string
  readonly ink: string
}[] = [
  { id: 'pure-white', label: '暖纸', swatch: '#f0ede5', ink: '#26221c' },
  { id: 'dark', label: '石墨', swatch: '#1d1b18', ink: '#f2efe9' },
  { id: 'oled', label: '纯黑', swatch: '#000000', ink: '#f0ede7' },
]

/** 12 主题时代写进 localStorage 的旧 id → v2 的三个世界。 */
export const LEGACY_APP_THEME_MAP: Readonly<Record<string, AppTheme>> = {
  'warm-paper': 'pure-white',
  ivory: 'pure-white',
  'soft-gray': 'pure-white',
  'liquid-glass': 'pure-white',
  mist: 'pure-white',
  sand: 'pure-white',
  pine: 'dark',
  graphite: 'dark',
  midnight: 'dark',
}

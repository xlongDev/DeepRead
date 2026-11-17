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
 *
 * 「跟随系统」是设置里的一项**选择**,不是一个 CSS 世界:它解析成三个世界里
 * 的一个再写到 `<html>`,所以 tokens.css 仍然只有三个明暗块。
 */
export type AppTheme = 'pure-white' | 'dark' | 'oled'

/** 用户在设置里选的值;首次启动(存值为空)默认 `system`。 */
export type AppThemeChoice = 'system' | AppTheme

export interface AppThemeSwatch {
  readonly id: AppTheme
  readonly label: string
  /** Mini page preview: background + ink. Accent is a separate axis now. */
  readonly swatch: string
  readonly ink: string
}

export const APP_THEMES: readonly AppThemeSwatch[] = [
  { id: 'pure-white', label: '暖纸', swatch: '#f0ede5', ink: '#26221c' },
  { id: 'dark', label: '石墨', swatch: '#1d1b18', ink: '#f2efe9' },
  { id: 'oled', label: '纯黑', swatch: '#000000', ink: '#f0ede7' },
]

/**
 * 设置面板与 ⌘K 的选项目录。跟随系统排在最前:浅色系统给纯白,深色系统给
 * 夜间(石墨)。预览卡左右分半摊开两个世界,文字线用两边都读得出的中性灰
 * (线宽不等,若线本身也左右分色,分界线会对不齐底色的 50%)。
 *
 * id 比 APP_THEMES 多一个 'system',所以这两个目录不能互换:APP_THEMES 是
 * CSS 世界的清单(tokens.test.ts 锁),APP_THEME_CHOICES 是用户可点的清单。
 */
export const APP_THEME_CHOICES: readonly (Omit<AppThemeSwatch, 'id'> & {
  readonly id: AppThemeChoice
})[] = [
  {
    id: 'system',
    label: '跟随系统',
    swatch: 'linear-gradient(90deg, #f0ede5 0 50%, #1d1b18 50% 100%)',
    ink: '#8a857d',
  },
  ...APP_THEMES,
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

export const APP_THEME_STORAGE_KEY = 'deepread.app-theme'
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/** 系统当前是否深色。node / 老引擎里没有 matchMedia,一律按浅色处理。 */
export function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(SYSTEM_DARK_QUERY).matches
  )
}

/** 读取用户意图:空值与脏值都回到默认的「跟随系统」,老 id 仍映射到具体世界。 */
export function parseAppThemeChoice(raw: string | null): AppThemeChoice {
  if (raw === null || raw === 'system') return 'system'
  if (APP_THEMES.some((theme) => theme.id === raw)) return raw as AppTheme
  return LEGACY_APP_THEME_MAP[raw] ?? 'system'
}

/** 用户意图 + 系统偏好 → 真正写到 `<html>` 上的世界。 */
export function resolveAppTheme(choice: AppThemeChoice, systemDark: boolean): AppTheme {
  if (choice !== 'system') return choice
  return systemDark ? 'dark' : 'pure-white'
}

/**
 * React 挂载前先把生效世界写到 `<html>`:深色系统下 CSS 先落地、JS 后落地,
 * 中间那一帧会是一片浅色。Tauri 的 CSP 只有 `script-src 'self'`,所以这事
 * 由入口模块(main.tsx)做,不能写进 index.html 的内联脚本。
 */
export function applyInitialAppTheme(): void {
  if (typeof document === 'undefined') return
  let raw: string | null = null
  try {
    raw = localStorage.getItem(APP_THEME_STORAGE_KEY)
  } catch {
    // 隐私模式 / 存储被禁:用系统偏好继续,不要让首屏挂掉。
  }
  document.documentElement.dataset.appTheme = resolveAppTheme(
    parseAppThemeChoice(raw),
    systemPrefersDark(),
  )
}

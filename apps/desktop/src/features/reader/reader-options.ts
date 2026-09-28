/**
 * Reader typography options + persistence. Pure data and functions only — the
 * screen renders them, so they live outside the 2000-line component where they
 * can be read (and reasoned about) on their own.
 */

import type { ReaderTheme } from '@deepread/reader-core'
import { convertFileSrc } from '../../lib/book-import'

export const READER_THEMES: readonly { readonly label: string; readonly theme: ReaderTheme }[] = [
  {
    label: '纸白',
    theme: { name: 'Paper', background: '#ffffff', foreground: '#1d1b17', colorScheme: 'light' },
  },
  {
    label: '羊皮',
    theme: { name: 'Sepia', background: '#f4e8cf', foreground: '#3a3226', colorScheme: 'light' },
  },
  {
    label: '夜间',
    theme: { name: 'Night', background: '#131210', foreground: '#b8b2a7', colorScheme: 'dark' },
  },
]

export const HIGHLIGHT_COLOR = '#f5d76e'
export const FONT_SIZES = [14, 16, 18, 20] as const

// undefined means 原书排版 (the book's own typography wins)
export const LINE_HEIGHT_OPTIONS: readonly {
  readonly label: string
  readonly value: number | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '紧凑', value: 1.45 },
  { label: '标准', value: 1.65 },
  { label: '宽松', value: 1.9 },
]

// 页边距档位:内核 margin(px),同时联动栏宽(边距越大栏越窄,
// 见 reader-adapter #maxInlineSize),宽窗口下也能感知变化。
export const PAGE_MARGIN_OPTIONS: readonly { readonly label: string; readonly value: number }[] = [
  { label: '特窄', value: 48 },
  { label: '标准', value: 72 },
  { label: '宽', value: 96 },
  { label: '特宽', value: 120 },
]

export const PARAGRAPH_MARGIN_OPTIONS: readonly {
  readonly label: string
  readonly value: number | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '紧凑', value: 0.4 },
  { label: '标准', value: 0.8 },
  { label: '宽松', value: 1.4 },
]

// 字重档位:覆盖正文级元素,标题不受影响;undefined = 原书字重。
export const FONT_WEIGHT_OPTIONS: readonly {
  readonly label: string
  readonly value: number | undefined
  readonly cssWeight: number
}[] = [
  { label: '原书', value: undefined, cssWeight: 400 },
  { label: '常规', value: 400, cssWeight: 400 },
  { label: '中等', value: 500, cssWeight: 500 },
  { label: '加粗', value: 700, cssWeight: 700 },
]

export const FONT_FAMILY_OPTIONS: readonly {
  readonly label: string
  readonly value: string | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '系统默认', value: 'system' },
  { label: '宋体', value: 'songti' },
  { label: '楷体', value: 'kaiti' },
  { label: '黑体', value: 'heiti' },
  { label: '霞鹜文楷', value: 'wenkai' },
  { label: '衬线', value: 'serif' },
  { label: '无衬线', value: 'sans' },
]

// 父窗口里的字体预览(OS 自带字体直接可用;霞鹜/导入字体只注入书内 iframe,不预览)。
export const FONT_STACK_PREVIEW: Readonly<Record<string, string>> = {
  system: '-apple-system, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", SimSun, serif',
  kaiti: '"Kaiti SC", KaiTi, serif',
  heiti: '"Heiti SC", SimHei, sans-serif',
  serif: 'Georgia, serif',
  sans: '-apple-system, "Helvetica Neue", sans-serif',
}

export type ViewMode = 'single' | 'dual' | 'scroll'

export const VIEW_MODE_OPTIONS: readonly { readonly label: string; readonly value: ViewMode }[] = [
  { label: '单页', value: 'single' },
  { label: '双页', value: 'dual' },
  { label: '滚动', value: 'scroll' },
]

export type PageTurnStyle = 'none' | 'slide' | 'cover' | 'flip' | 'fade'

export const PAGE_TURN_OPTIONS: readonly {
  readonly label: string
  readonly value: PageTurnStyle
}[] = [
  { label: '无', value: 'none' },
  { label: '滑动', value: 'slide' },
  { label: '覆盖', value: 'cover' },
  { label: '仿真', value: 'flip' },
  { label: '淡入', value: 'fade' },
]

/* ---------- 排版设置持久化(localStorage;Rust 侧只存进度/批注)。 ---------- */

export interface TypographySettings {
  viewMode?: ViewMode
  fontSize?: number
  lineHeight?: number | undefined
  fontFamily?: string | undefined
  fontWeight?: number | undefined
  themeIndex?: number
  pageMargin?: number
  paragraphMargin?: number | undefined
}

const TYPOGRAPHY_KEY = 'deepread.reader.typography'
let cachedTypography: TypographySettings | null = null

export function loadTypography(): TypographySettings {
  if (cachedTypography === null) {
    try {
      cachedTypography = JSON.parse(
        localStorage.getItem(TYPOGRAPHY_KEY) ?? '{}',
      ) as TypographySettings
    } catch {
      cachedTypography = {}
    }
  }
  return cachedTypography
}

export function persistTypography(patch: TypographySettings): void {
  const next = { ...loadTypography(), ...patch }
  // 整体回写让显式 undefined(选回"原书")从存储里删掉键。
  localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(next))
  cachedTypography = next
}

/* ---------- 底栏显示偏好与翻页动画(同样只落 localStorage)。 ---------- */

export interface StatsSettings {
  progress: boolean
  words: boolean
  time: boolean
  wordsScope: 'section' | 'book'
}

export const DEFAULT_STATS_SETTINGS: StatsSettings = {
  progress: true,
  words: true,
  time: true,
  wordsScope: 'section',
}

const PAGE_TURN_KEY = 'deepread.reader.pageTurn'
const STATS_KEY = 'deepread.reader.stats'

/**
 * 翻页动画偏好。存储值要按档位表校验:写成 `as PageTurnStyle` 直接信任
 * localStorage,一旦存进去过非法值(旧版本遗留 / 手改),翻页样式就永久坏掉
 * 且看不出原因。不认识的值一律回落默认档。
 */
export function loadPageTurnStyle(): PageTurnStyle {
  const stored = localStorage.getItem(PAGE_TURN_KEY)
  const known = PAGE_TURN_OPTIONS.some((option) => option.value === stored)
  return known ? (stored as PageTurnStyle) : 'slide'
}

export function persistPageTurnStyle(style: PageTurnStyle): void {
  localStorage.setItem(PAGE_TURN_KEY, style)
}

/** 底栏显示偏好。逐字段校验,坏值只丢那一项、不影响其余。 */
export function loadStatsSettings(): StatsSettings {
  try {
    const stored = localStorage.getItem(STATS_KEY)
    if (stored === null) return { ...DEFAULT_STATS_SETTINGS }
    const parsed: unknown = JSON.parse(stored)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_STATS_SETTINGS }
    const record = parsed as Record<string, unknown>
    return {
      progress: typeof record['progress'] === 'boolean' ? record['progress'] : true,
      words: typeof record['words'] === 'boolean' ? record['words'] : true,
      time: typeof record['time'] === 'boolean' ? record['time'] : true,
      wordsScope: record['wordsScope'] === 'book' ? 'book' : 'section',
    }
  } catch {
    return { ...DEFAULT_STATS_SETTINGS }
  }
}

export function persistStatsSettings(next: StatsSettings): void {
  localStorage.setItem(STATS_KEY, JSON.stringify(next))
}

/** 书籍文档的 @font-face:内置霞鹜文楷 + 用户导入字体。 */
export function buildFontFacesCss(
  customFonts: readonly { readonly name: string; readonly path: string }[],
): string {
  const rules = [
    `@font-face { font-family: 'LXGW WenKai'; src: url('${window.location.origin}/fonts/LxgwWenkai-Regular.ttf') format('truetype'); font-display: swap; }`,
  ]
  for (const font of customFonts) {
    const safeName = font.name.replace(/['"]/g, '')
    rules.push(
      `@font-face { font-family: '${safeName}'; src: url('${convertFileSrc(font.path)}') format('truetype'); font-display: swap; }`,
    )
  }
  return rules.join('\n')
}

/** 十六进制色 → 带 alpha 的 rgba,用于给阅读主题派生磨砂面板底色。 */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return hex
  const value = match[1] ?? ''
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Reader typography options + persistence. Pure data and functions only — the
 * screen renders them, so they live outside the 2000-line component where they
 * can be read (and reasoned about) on their own.
 */

import type { ReaderLayout, ReaderTheme, ZhConvertVariant } from '@deepread/reader-core'
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

/**
 * 划线色板(五档)。
 * 色值直接交给内核铺 SVG 背景(见 `reader-adapter` 的 draw-annotation 处理),
 * 内核统一按 0.3 不透明度绘制 —— 所以这里存的是"原色",上纸后被压成淡彩。
 * 五档亮度刻意对齐(多色划线要在同一页上并存而不打架):高饱和色压出来会
 * 一边重一边轻,不好做区分。
 */
export const HIGHLIGHT_PALETTE: readonly {
  readonly label: string
  readonly color: string
}[] = [
  { label: '黄色', color: HIGHLIGHT_COLOR },
  { label: '绿色', color: '#86c98a' },
  { label: '蓝色', color: '#86b6f0' },
  { label: '粉色', color: '#f0a0b8' },
  { label: '紫色', color: '#c0a8e8' },
]
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

/**
 * 页边距拆成两把标尺 —— 左右与上下在内核里根本不是同一个东西:
 * - 左右 = 栏宽上限(max-inline-size,见 reader-adapter #maxInlineSize);
 * - 上下 = paginator 的 margin 属性(内核的 margin 只作用于上下)。
 *
 * 新「左右·标准」= 旧「特窄」的 48px(实测下来那是桌面宽度最好读的一档),
 * 其余三档按同一档差向外排布;上下沿用旧标准的 72px 保持不动。
 */
export const PAGE_MARGIN_INLINE_OPTIONS: readonly {
  readonly label: string
  readonly value: number
}[] = [
  { label: '特窄', value: 24 },
  { label: '标准', value: 48 },
  { label: '宽', value: 72 },
  { label: '特宽', value: 96 },
]

export const PAGE_MARGIN_BLOCK_OPTIONS: readonly {
  readonly label: string
  readonly value: number
}[] = [
  { label: '特窄', value: 48 },
  { label: '标准', value: 72 },
  { label: '宽', value: 96 },
  { label: '特宽', value: 120 },
]

/** 「标准」档的左右/上下边距:UI 与 open 初值都从这里取,不写字面量。 */
export const PAGE_MARGIN_INLINE_DEFAULT = 48
export const PAGE_MARGIN_BLOCK_DEFAULT = 72

// 段首缩进(单位 em),只在自定义排版下注入 —— 原书排版由书自己的 CSS 决定。
export const TEXT_INDENT_OPTIONS: readonly {
  readonly label: string
  readonly value: number
}[] = [
  { label: '不缩进', value: 0 },
  { label: '1 字符', value: 1 },
  { label: '2 字符', value: 2 },
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

// 书写方向:undefined = 原书(竖排书保持竖排);显式档位强制覆盖。
export type WritingModeChoice = 'horizontal-tb' | 'vertical-rl'

export const WRITING_MODE_OPTIONS: readonly {
  readonly label: string
  readonly value: WritingModeChoice | undefined
}[] = [
  { label: '原书', value: undefined },
  { label: '横排', value: 'horizontal-tb' },
  { label: '竖排', value: 'vertical-rl' },
]

// 简繁转换档位(与 readest 的 simplecc 变体一一对应)。
export const ZH_CONVERT_OPTIONS: readonly {
  readonly label: string
  readonly value: ZhConvertVariant
}[] = [
  { label: '不转换', value: 'none' },
  { label: '简体 → 繁体', value: 's2t' },
  { label: '繁体 → 简体', value: 't2s' },
  { label: '简体 → 繁体(台湾)', value: 's2tw' },
  { label: '简体 → 繁体(香港)', value: 's2hk' },
  { label: '简体 → 繁体(台湾·用语)', value: 's2twp' },
  { label: '繁体(台湾) → 简体', value: 'tw2s' },
  { label: '繁体(香港) → 简体', value: 'hk2s' },
  { label: '繁体(台湾) → 简体·用语', value: 'tw2sp' },
]

/* ---------- 排版设置持久化(localStorage;Rust 侧只存进度/批注)。 ---------- */

export interface TypographySettings {
  /**
   * 原书排版总开关(缺省 true)。
   * 开着 = 书自己的排版赢:行距 / 段间距 / 段首缩进 / 字重 / 排版方向不下发。
   * 字号、页边距、字体三条是读者口味,与开关无关,两种模式下都生效
   * (字体选「原书」时才回到书自带的字体)。
   */
  originalLayout?: boolean
  viewMode?: ViewMode
  /** 字号;undefined = 读者还没动过(原书排版下按 16 走,切到自定义落到 18)。 */
  fontSize?: number | undefined
  lineHeight?: number | undefined
  fontFamily?: string | undefined
  fontWeight?: number | undefined
  themeIndex?: number
  /** 页边距 · 左右(px)。 */
  pageMargin?: number
  /** 页边距 · 上下(px)。 */
  pageMarginBlock?: number
  paragraphMargin?: number | undefined
  /** 段首缩进(em);undefined = 不下发(原书排版)。 */
  textIndent?: number | undefined
  writingMode?: WritingModeChoice | undefined
  zhConvert?: ZhConvertVariant
}

/**
 * 切到自定义排版时实体化的默认档位 —— 每行都取该行的「标准」档。
 *
 * 为什么需要:不下发 = 书自己的排版。若切过去时六个维度都还是 undefined,
 * 「关掉原书排版」在画面上什么都不会变,读者只会以为开关坏了。
 */
/**
 * 字号在读者从没动过时的档位。
 *
 * 字号必须能表示「没选过」(undefined):否则切到自定义排版时无从判断该不该
 * 落到 CUSTOM_TYPOGRAPHY_DEFAULTS 里的 18px —— 状态里永远躺着一个 16,
 * 18 就永远不会生效。
 */
export const FONT_SIZE_DEFAULT = 16

export const CUSTOM_TYPOGRAPHY_DEFAULTS = {
  fontSize: 18,
  lineHeight: 1.65,
  fontFamily: 'system',
  fontWeight: 400,
  paragraphMargin: 0.8,
  textIndent: 2,
  writingMode: 'horizontal-tb',
} as const

/**
 * 生效的排版覆盖项(纯函数,落盘与下发都走它)。
 *
 * 两个层级并存,互不覆盖:
 * - 总开关开:除字体外整组维度不下发 —— 书自己的排版赢;
 * - 总开关关:按各行档位下发,某行单独选回「原书」时那一项仍是 undefined,
 *   于是这一个维度回到书自己的值。
 *
 * 字体是独立于总开关的一条轴:读哪本书都用自己的字体是阅读口味,不算「书的
 * 排版」,所以两种模式下都下发。选「原书」(undefined)仍然回到书自带的字体。
 */
export function layoutOverrides(
  settings: TypographySettings,
): Pick<
  ReaderLayout,
  'lineHeight' | 'fontFamily' | 'fontWeight' | 'paragraphMargin' | 'textIndent' | 'writingMode'
> {
  if (settings.originalLayout ?? true) {
    return {
      lineHeight: undefined,
      fontFamily: settings.fontFamily,
      fontWeight: undefined,
      paragraphMargin: undefined,
      textIndent: undefined,
      writingMode: undefined,
    }
  }
  return {
    lineHeight: settings.lineHeight,
    fontFamily: settings.fontFamily,
    fontWeight: settings.fontWeight,
    paragraphMargin: settings.paragraphMargin,
    textIndent: settings.textIndent,
    writingMode: settings.writingMode,
  }
}

/**
 * 把还没选过的维度落到标准档(只用在「切到自定义」那一刻)。
 *
 * 字体不在这里强制改写:它是独立轴,读者在原书模式下挑的字体切过去要留着。
 * 只有从未选过(undefined = 原书字体)时,才落成自定义档的默认。
 */
export function materializeCustomDefaults(settings: TypographySettings): TypographySettings {
  return {
    ...settings,
    fontSize: settings.fontSize ?? CUSTOM_TYPOGRAPHY_DEFAULTS.fontSize,
    lineHeight: settings.lineHeight ?? CUSTOM_TYPOGRAPHY_DEFAULTS.lineHeight,
    fontFamily: settings.fontFamily ?? CUSTOM_TYPOGRAPHY_DEFAULTS.fontFamily,
    fontWeight: settings.fontWeight ?? CUSTOM_TYPOGRAPHY_DEFAULTS.fontWeight,
    paragraphMargin: settings.paragraphMargin ?? CUSTOM_TYPOGRAPHY_DEFAULTS.paragraphMargin,
    textIndent: settings.textIndent ?? CUSTOM_TYPOGRAPHY_DEFAULTS.textIndent,
    writingMode: settings.writingMode ?? CUSTOM_TYPOGRAPHY_DEFAULTS.writingMode,
  }
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

/* ---------- 划选翻译的目标语言(只落 localStorage)。 ---------- */

const TRANSLATE_KEY = 'deepread.translate.target'

export const TRANSLATE_TARGETS = ['中文', 'English', '日本語', '한국어'] as const

/** 没选过就返回 null —— 默认值要看书的语言,由调用方决定。 */
export function loadTranslateTarget(): string | null {
  try {
    const stored = localStorage.getItem(TRANSLATE_KEY)
    return stored === null || stored === '' ? null : stored
  } catch {
    return null
  }
}

export function persistTranslateTarget(target: string): void {
  localStorage.setItem(TRANSLATE_KEY, target)
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

/* ---------- 阅读尺(跨书偏好,与翻页动画同一档)。 ---------- */

export interface ReadingRulerSettings {
  enabled: boolean
  /** 焦点带覆盖的行数。 */
  focusLines: number
  /** 非焦点内容的不透明度:越小越暗。 */
  dimOpacity: number
}

/** 档位表,兼作脏值白名单 —— localStorage 里的历史值不能被当成法。 */
export const RULER_FOCUS_LINES = [1, 2, 3, 5] as const

export const RULER_DIM_OPTIONS: readonly {
  readonly label: string
  readonly value: number
}[] = [
  { label: '轻', value: 0.35 },
  { label: '标准', value: 0.2 },
  { label: '强', value: 0.1 },
]

export const DEFAULT_RULER_SETTINGS: ReadingRulerSettings = {
  enabled: false,
  focusLines: 1,
  dimOpacity: 0.2,
}

const RULER_KEY = 'deepread.reader.ruler'

export function loadRulerSettings(): ReadingRulerSettings {
  try {
    const stored = localStorage.getItem(RULER_KEY)
    if (stored === null) return { ...DEFAULT_RULER_SETTINGS }
    const parsed: unknown = JSON.parse(stored)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_RULER_SETTINGS }
    const record = parsed as Record<string, unknown>
    const focusLines = record['focusLines']
    const dimOpacity = record['dimOpacity']
    return {
      enabled: record['enabled'] === true,
      focusLines: RULER_FOCUS_LINES.find((value) => value === focusLines) ?? 1,
      dimOpacity:
        RULER_DIM_OPTIONS.find((option) => option.value === dimOpacity)?.value ??
        DEFAULT_RULER_SETTINGS.dimOpacity,
    }
  } catch {
    return { ...DEFAULT_RULER_SETTINGS }
  }
}

export function persistRulerSettings(next: ReadingRulerSettings): void {
  localStorage.setItem(RULER_KEY, JSON.stringify(next))
}

/** 书籍文档的 @font-face:内置霞鹜文楷 + 用户导入字体。 */ export function buildFontFacesCss(
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

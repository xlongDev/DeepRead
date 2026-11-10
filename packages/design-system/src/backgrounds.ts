import { ACCENT_DEFAULT, ACCENT_PRESETS } from './accents'

/**
 * 配色主题目录 —— 三个 app 世界的「色相轴」。
 *
 * 一条轴只回答一件事:这套界面是什么颜色。明暗仍归 app 主题(暖纸 / 石墨 /
 * 纯黑),阅读纸仍归 READER_THEMES。三者互不重叠,所以换主题永远不会动到
 * 书页 —— 阅读背景是独立的资产,不是界面配色的一部分。
 *
 * 每个方案带两样东西:
 *   stops  三个渐变 stop,铺在页面底色上(原样保留自 Tailwind v3 渐变常量,
 *          本项目没有 Tailwind,类名只留作溯源)。
 *   accent 该方案自己的强调色 (OKLCH 色相 + 浅色世界的彩度)。以前选一套
 *          渐变只换底色、强调色还是品牌蓝,两套色系各说各话,看着像贴纸;
 *          现在主题同时决定按钮、选中态和进度条的颜色,一整屏才读成一套。
 *
 * 'none' 是默认值:不装主题时仍是纯色桌面 + 品牌蓝,既有视觉一字不改。
 */
interface BackgroundScheme {
  readonly id: string
  readonly label: string
  readonly light: readonly [string, string, string]
  readonly dark: readonly [string, string, string]
  /** 色相取该方案最有辨识度的那个 stop;彩度按项目的克制阶梯收过一档。 */
  readonly accent: { readonly h: number; readonly c: number }
}

export const BACKGROUND_SCHEMES = [
  {
    id: 'fresh',
    label: '清新青绿',
    light: ['#93c5fd', '#5eead4', '#86efac'],
    dark: ['#60a5fa', '#2dd4bf', '#4ade80'],
    accent: { h: 181, c: 0.11 },
  },
  {
    id: 'warm',
    label: '暖调霞紫',
    light: ['#fed7aa', '#f9a8d4', '#c084fc'],
    dark: ['#fb923c', '#ec4899', '#a855f7'],
    accent: { h: 315, c: 0.13 },
  },
  {
    id: 'retro',
    label: '复古琥珀',
    light: ['#fef3c7', '#fde68a', '#d6d3d1'],
    dark: ['#fbbf24', '#fcd34d', '#e5e7eb'],
    accent: { h: 84, c: 0.1 },
  },
  {
    id: 'pastel',
    label: '粉彩玫瑰',
    light: ['#ffe4e6', '#fbcfe8', '#fda4af'],
    dark: ['#fb7185', '#f472b6', '#fda4af'],
    accent: { h: 350, c: 0.12 },
  },
  {
    id: 'ocean',
    label: '海洋蓝',
    light: ['#a5f3fc', '#7dd3fc', '#60a5fa'],
    dark: ['#22d3ee', '#38bdf8', '#3b82f6'],
    accent: { h: 211, c: 0.12 },
  },
  {
    id: 'nightsky',
    label: '星空靛蓝',
    light: ['#bfdbfe', '#a5b4fc', '#60a5fa'],
    dark: ['#60a5fa', '#818cf8', '#3b82f6'],
    accent: { h: 277, c: 0.13 },
  },
  {
    id: 'aurora',
    label: '极光紫绿',
    light: ['#c4b5fd', '#a7f3d0', '#5eead4'],
    dark: ['#8b5cf6', '#34d399', '#2dd4bf'],
    accent: { h: 175, c: 0.1 },
  },
  {
    id: 'dusk',
    label: '傍晚霞光',
    light: ['#fecaca', '#fdba74', '#fef08a'],
    dark: ['#f87171', '#fb923c', '#facc15'],
    accent: { h: 56, c: 0.11 },
  },
  {
    id: 'tropical',
    label: '热带日落',
    light: ['#fde68a', '#f9a8d4', '#fecaca'],
    dark: ['#fbbf24', '#ec4899', '#f87171'],
    accent: { h: 335, c: 0.13 },
  },
  {
    id: 'tech',
    label: '科技靛青',
    light: ['#a5b4fc', '#93c5fd', '#67e8f9'],
    dark: ['#818cf8', '#60a5fa', '#22d3ee'],
    accent: { h: 257, c: 0.12 },
  },
  {
    id: 'forest',
    label: '森林晨曦',
    light: ['#d1fae5', '#ccfbf1', '#a5f3fc'],
    dark: ['#34d399', '#2dd4bf', '#22d3ee'],
    accent: { h: 163, c: 0.1 },
  },
  {
    id: 'lavender',
    label: '薰衣草',
    light: ['#fae8ff', '#f3e8ff', '#c7d2fe'],
    dark: ['#e879f9', '#c084fc', '#818cf8'],
    accent: { h: 300, c: 0.11 },
  },
  {
    id: 'amber',
    label: '沙漠琥珀',
    light: ['#fefce8', '#fef3c7', '#ffedd5'],
    dark: ['#fde047', '#fcd34d', '#fdba74'],
    accent: { h: 92, c: 0.1 },
  },
  {
    id: 'glacier',
    label: '冰雪极光',
    light: ['#e0f2fe', '#ede9fe', '#bfdbfe'],
    dark: ['#38bdf8', '#a78bfa', '#60a5fa'],
    accent: { h: 265, c: 0.11 },
  },
  {
    id: 'coral',
    label: '热带珊瑚',
    light: ['#fecdd3', '#ffedd5', '#fbcfe8'],
    dark: ['#fb7185', '#fdba74', '#f472b6'],
    accent: { h: 13, c: 0.13 },
  },
] as const satisfies readonly BackgroundScheme[]

export type BackgroundChoice = 'none' | (typeof BACKGROUND_SCHEMES)[number]['id']

export const BACKGROUND_DEFAULT: BackgroundChoice = 'none'
export const BACKGROUND_STORAGE_KEY = 'deepread.background'

/** localStorage 是信任边界:脏值一律回落纯色桌面,不带进 CSS。 */
export function parseBackground(raw: string | null): BackgroundChoice {
  return raw === 'none' || BACKGROUND_SCHEMES.some((scheme) => scheme.id === raw)
    ? (raw as BackgroundChoice)
    : BACKGROUND_DEFAULT
}

/**
 * 壁纸的三色 stop 与掺入比例。CSS 用它拼 linear-gradient,折射管线的 canvas
 * 用它重画同一张壁纸 —— 一个数据源,免得两边颜色悄悄漂移。
 */
export function wallpaperStops(
  choice: BackgroundChoice,
  dark: boolean,
): { readonly stops: readonly [string, string, string]; readonly tint: number } | null {
  const scheme = BACKGROUND_SCHEMES.find((item) => item.id === choice)
  if (scheme === undefined) return null
  // 乳白档:原色占比越低,混进的 --surface-page 越多,整页越接近纸白。
  // 玻璃滤镜早期还把彩度放大到 1.8,整片青绿会盖过文字、看久了晃眼;
  // 两处一起收,渐变仍在,但只是纸面上的一层淡彩而非整块高饱和色。
  return { stops: dark ? scheme.dark : scheme.light, tint: dark ? 22 : 46 }
}

/**
 * 铺在 `.library` 上的 background-image;null = 让宿主清掉变量。
 * 两套都融进 --surface-page:原色是营销页的高饱和渐变,整片铺满会吃掉
 * 页面/卡片的明度差;深色世界的比例更低,免得深底上亮得刺眼。
 */
export function wallpaperFor(choice: BackgroundChoice, dark: boolean): string | null {
  const scheme = wallpaperStops(choice, dark)
  if (scheme === null) return null
  const stops = scheme.stops.map(
    (hex) => `color-mix(in srgb, ${hex} ${scheme.tint}%, var(--surface-page))`,
  )
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** 深色世界收窄到的彩度,与 tokens.css 深色块的 --accent-c 同档。 */
const DARK_ACCENT_CHROMA = 0.065

/**
 * 主题色标:原始三色渐变,给下拉与设置里的预览条用。
 *
 * 不能用 `wallpaperFor` —— 页面上的乳白档掺了 46% 表面色,做成 22×12 的
 * 色条以后十五套几乎同色,选主题变成读名字。这里要的是标识,不是截屏。
 *
 * 按世界取色:深色界面里浅色档(`light`)会像一排发光的小灯,反而比
 * 菜单文字更抢眼;`dark` 那套是同一个方案在中调上的版本,和深色浮层同温度。
 */
export function backgroundSwatch(choice: BackgroundChoice, dark = false): string | null {
  const scheme = BACKGROUND_SCHEMES.find((item) => item.id === choice)
  if (scheme === undefined) return null
  const stops = dark ? scheme.dark : scheme.light
  return `linear-gradient(90deg, ${stops[0]}, ${stops[1]}, ${stops[2]})`
}

/**
 * 主题的强调色。'none'(纯色桌面)回落到品牌蓝 —— 没有色相可跟时,
 * 界面必须和没装主题时一模一样。
 *
 * 只产出 h / c,明度(--accent-l)永远归主题块给:同一套色相在暖纸 /
 * 石墨 / 纯黑下自动拿到各自正确的对比度,这是强调色轴原本的约定。
 */
export function backgroundAccent(
  choice: BackgroundChoice,
  dark: boolean,
): { readonly h: number; readonly c: number } {
  const scheme = BACKGROUND_SCHEMES.find((item) => item.id === choice)
  if (scheme === undefined) {
    const brand = ACCENT_PRESETS.find((preset) => preset.id === ACCENT_DEFAULT)
    return {
      h: brand?.hue ?? 271,
      c: dark ? DARK_ACCENT_CHROMA : (brand?.chroma ?? 0.14),
    }
  }
  return { h: scheme.accent.h, c: dark ? DARK_ACCENT_CHROMA : scheme.accent.c }
}

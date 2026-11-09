/**
 * 界面背景方案(壁纸)目录 —— 三个 app 世界与九张阅读纸之外的第三条轴。
 *
 * 来源是一份 Tailwind v3 渐变常量:本项目没有 Tailwind,类名只留作溯源,
 * 运行时只用三个 hex stop。light 是原渐变色,dark 是同套方案在灰底上用的
 * 装饰色(原文件的深色背景一律是统一灰渐变,方案间的色差全在 colors.dark)。
 * 'none' 是默认值:不装壁纸时仍是纯色桌面,既有视觉一字不改。
 */
interface BackgroundScheme {
  readonly id: string
  readonly label: string
  readonly light: readonly [string, string, string]
  readonly dark: readonly [string, string, string]
}

export const BACKGROUND_SCHEMES = [
  {
    id: 'fresh',
    label: '清新青绿',
    light: ['#93c5fd', '#5eead4', '#86efac'],
    dark: ['#60a5fa', '#2dd4bf', '#4ade80'],
  },
  {
    id: 'warm',
    label: '暖调霞紫',
    light: ['#fed7aa', '#f9a8d4', '#c084fc'],
    dark: ['#fb923c', '#ec4899', '#a855f7'],
  },
  {
    id: 'retro',
    label: '复古琥珀',
    light: ['#fef3c7', '#fde68a', '#d6d3d1'],
    dark: ['#fbbf24', '#fcd34d', '#e5e7eb'],
  },
  {
    id: 'pastel',
    label: '粉彩玫瑰',
    light: ['#ffe4e6', '#fbcfe8', '#fda4af'],
    dark: ['#fb7185', '#f472b6', '#fda4af'],
  },
  {
    id: 'ocean',
    label: '海洋蓝',
    light: ['#a5f3fc', '#7dd3fc', '#60a5fa'],
    dark: ['#22d3ee', '#38bdf8', '#3b82f6'],
  },
  {
    id: 'nightsky',
    label: '星空靛蓝',
    light: ['#bfdbfe', '#a5b4fc', '#60a5fa'],
    dark: ['#60a5fa', '#818cf8', '#3b82f6'],
  },
  {
    id: 'aurora',
    label: '极光紫绿',
    light: ['#c4b5fd', '#a7f3d0', '#5eead4'],
    dark: ['#8b5cf6', '#34d399', '#2dd4bf'],
  },
  {
    id: 'dusk',
    label: '傍晚霞光',
    light: ['#fecaca', '#fdba74', '#fef08a'],
    dark: ['#f87171', '#fb923c', '#facc15'],
  },
  {
    id: 'tropical',
    label: '热带日落',
    light: ['#fde68a', '#f9a8d4', '#fecaca'],
    dark: ['#fbbf24', '#ec4899', '#f87171'],
  },
  {
    id: 'tech',
    label: '科技靛青',
    light: ['#a5b4fc', '#93c5fd', '#67e8f9'],
    dark: ['#818cf8', '#60a5fa', '#22d3ee'],
  },
  {
    id: 'forest',
    label: '森林晨曦',
    light: ['#d1fae5', '#ccfbf1', '#a5f3fc'],
    dark: ['#34d399', '#2dd4bf', '#22d3ee'],
  },
  {
    id: 'lavender',
    label: '薰衣草',
    light: ['#fae8ff', '#f3e8ff', '#c7d2fe'],
    dark: ['#e879f9', '#c084fc', '#818cf8'],
  },
  {
    id: 'amber',
    label: '沙漠琥珀',
    light: ['#fefce8', '#fef3c7', '#ffedd5'],
    dark: ['#fde047', '#fcd34d', '#fdba74'],
  },
  {
    id: 'glacier',
    label: '冰雪极光',
    light: ['#e0f2fe', '#ede9fe', '#bfdbfe'],
    dark: ['#38bdf8', '#a78bfa', '#60a5fa'],
  },
  {
    id: 'coral',
    label: '热带珊瑚',
    light: ['#fecdd3', '#ffedd5', '#fbcfe8'],
    dark: ['#fb7185', '#fdba74', '#f472b6'],
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

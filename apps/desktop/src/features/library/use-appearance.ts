import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  ACCENT_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
  BACKGROUND_STORAGE_KEY,
  MOTION_STORAGE_KEY,
  SYSTEM_DARK_QUERY,
  backgroundAccent,
  motionAttribute,
  onAccentFor,
  parseAccent,
  parseAppThemeChoice,
  parseBackground,
  parseMotionPreference,
  resolveAppTheme,
  serializeAccent,
  systemPrefersDark,
  wallpaperFor,
  type AccentChoice,
  type AppThemeChoice,
  type BackgroundChoice,
  type MotionPreference,
} from '@deepread/design-system'

/**
 * 书架的外观域:配色主题、强调色、壁纸、动效四条轴 + 落到 `<html>` 的
 * 全部持久化与 DOM 写入,收进一个 hook。书架卸载(进阅读器)时收走
 * 壁纸/背景开关,玻璃态不泄漏到别的页面。
 */
export function useAppearance() {
  /**
   * 用户意图(跟随系统 / 三个具体世界)与生效世界分开存:前者进 localStorage,
   * 后者只写到 `<html>`。存生效世界会让「跟随系统」在第一次切换后被自己覆盖。
   */
  const [themeChoice, setThemeChoice] = useState<AppThemeChoice>(() =>
    parseAppThemeChoice(localStorage.getItem(APP_THEME_STORAGE_KEY)),
  )
  /** 系统明暗:一个独立的信号。选了具体世界时照样更新,切回跟随系统不会拿到旧值。 */
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const appTheme = resolveAppTheme(themeChoice, systemDark)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(SYSTEM_DARK_QUERY)
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    // 老 WKWebView 只有 addListener;没有 addEventListener 时不能让监听静默失效。
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [])

  /** 强调色:预设 id 或自定义 hex;宿主持有,设置面板只是入口。 */
  const [accent, setAccent] = useState<AccentChoice>(() =>
    parseAccent(localStorage.getItem(ACCENT_STORAGE_KEY)),
  )
  /** 界面动效:只存用户意图,系统偏好仍由原生 @media 判定。 */
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(() =>
    parseMotionPreference(localStorage.getItem(MOTION_STORAGE_KEY)),
  )
  /** 界面背景(壁纸):独立轴,默认纯色桌面;明暗由 appTheme 一起决定。 */
  const [background, setBackground] = useState<BackgroundChoice>(() =>
    parseBackground(localStorage.getItem(BACKGROUND_STORAGE_KEY)),
  )
  /**
   * 换配色主题就是换掉整套配色,所以把强调色交回给主题;唯一例外是手动
   * 调过的自定义色 —— 那是用户花时间挑的,主题不该悄悄盖掉。
   */
  const changeBackground = useCallback((value: BackgroundChoice): void => {
    setBackground(value)
    setAccent((prev) => (prev.kind === 'custom' ? prev : { kind: 'auto' }))
  }, [])

  // 明暗必须**在布局阶段**落地,不能等 useEffect:壁纸折射画布
  // (useGlassRefraction)在被动 effect 里用 getComputedStyle 读
  // `--surface-page` 重画纹理 —— 那会儿若 data-app-theme 还是旧世界,纹理就
  // 会拿到浅色底,玻璃卡在暗色主题下变成一大块发白的色块(11-10 截图,
  // 切主题后滚动尤其明显:每次 frame() 都在用那张错的纹理重绘)。
  useLayoutEffect(() => {
    document.documentElement.dataset['appTheme'] = appTheme
    localStorage.setItem(APP_THEME_STORAGE_KEY, themeChoice)
  }, [appTheme, themeChoice])

  // 布局阶段写壁纸,不能等 useEffect:那会在首次 paint 先出一帧纯色桌面,
  // 切回书架时读作「白一下才渐变」。useLayoutEffect 在 paint 前同步落地。
  useLayoutEffect(() => {
    const root = document.documentElement
    const wallpaper = wallpaperFor(background, appTheme !== 'pure-white')
    if (wallpaper === null) root.style.removeProperty('--wallpaper')
    else root.style.setProperty('--wallpaper', wallpaper)
    root.dataset.background = background
    localStorage.setItem(BACKGROUND_STORAGE_KEY, background)
    // 书架卸载(进入阅读器)时收走开关,否则壁纸态玻璃会跟着留在 html 上。
    return () => {
      root.style.removeProperty('--wallpaper')
      root.removeAttribute('data-background')
    }
  }, [background, appTheme])

  useEffect(() => {
    const root = document.documentElement
    if (accent.kind === 'auto') {
      // 跟随配色主题:只写色相 / 彩度,明度仍归主题块 —— 同一套色相在
      // 暖纸 / 石墨 / 纯黑下各自拿到正确对比度。内联变量压过 [data-accent]
      // 预设块,所以属性要一并撤掉;自定义色留下的 --color-accent 同理。
      const { h, c } = backgroundAccent(background, appTheme !== 'pure-white')
      root.removeAttribute('data-accent')
      root.style.removeProperty('--color-accent')
      root.style.removeProperty('--color-on-accent')
      root.style.setProperty('--accent-h', String(h))
      root.style.setProperty('--accent-c', String(c))
    } else if (accent.kind === 'preset') {
      root.dataset.accent = accent.id
      root.style.removeProperty('--accent-h')
      root.style.removeProperty('--accent-c')
      root.style.removeProperty('--color-accent')
      root.style.removeProperty('--color-on-accent')
    } else {
      // 自定义色直接盖 --color-accent;soft / hover 都读这个变量,自动跟随。
      // on-accent 按亮度算,否则浅色底上白字会掉到 3:1 以下。
      root.removeAttribute('data-accent')
      root.style.removeProperty('--accent-h')
      root.style.removeProperty('--accent-c')
      root.style.setProperty('--color-accent', accent.hex)
      root.style.setProperty('--color-on-accent', onAccentFor(accent.hex))
    }
    localStorage.setItem(ACCENT_STORAGE_KEY, serializeAccent(accent))
  }, [accent, background, appTheme])

  useEffect(() => {
    const attribute = motionAttribute(motionPreference)
    if (attribute === null) {
      // 移除而非写 'system':CSS 里没有 system 块,系统偏好交给 @media。
      document.documentElement.removeAttribute('data-motion')
    } else {
      document.documentElement.dataset.motion = attribute
    }
    localStorage.setItem(MOTION_STORAGE_KEY, motionPreference)
  }, [motionPreference])

  return {
    themeChoice,
    setThemeChoice,
    appTheme,
    accent,
    setAccent,
    motionPreference,
    setMotionPreference,
    background,
    changeBackground,
  }
}

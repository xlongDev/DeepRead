import { useEffect, useRef, type RefObject } from 'react'
import type { BackgroundChoice } from '@deepread/design-system'
import { createRefraction, type GlassRefraction, type GlassSurface } from './refract.js'
import { paintWallpaper } from './wallpaper-canvas'

/** 与 13-glass-wallpaper.css 的三块常驻卡片逐字一致;refract.js 最多画 8 块。 */
export const GLASS_SURFACE_SELECTOR = '.lib-sidebar-goal, .continue-reading, .shelf-search'

/**
 * 壁纸开启时在书架屏挂一层 WebGL 折射 canvas。折射不出来(无 WebGL2 /
 * 低透明度偏好)就留在 CSS 玻璃:data-glass='css' 让组件保留原生 backdrop-filter。
 *
 * 静态壁纸只画一帧。滚动期间绝不逐帧重画全屏 shader:surfaces() 里的
 * getBoundingClientRect + getComputedStyle 会触发强制同步布局,叠加 WebGL
 * 绘制正是首页卡顿的来源。滚动停下来后合并成一次 frame() 补齐位置。
 *
 * `surfaceKey` 变了(切页面 / 开合侧栏 —— 玻璃卡换了位置甚至整批消失)就重画:
 * 画布不会自己擦掉,旧的一帧会留在原地,在笔记/统计页上表现为「继续阅读卡
 * 那么大的一块浅色」(11-10 截图)。滚动会顺带补一次,但只在滚动位置真的变了
 * 的时候 —— 别指望它。
 */
export function useGlassRefraction(
  choice: BackgroundChoice,
  dark: boolean,
  surfaceKey: string,
): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 当前那一份折射实例:换页时只让它重画一帧,不用重编译 shader。 */
  const refractionRef = useRef<GlassRefraction | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.removeAttribute('data-glass')
    if (choice === 'none') return
    if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) {
      root.dataset.glass = 'css'
      return
    }

    const canvas = canvasRef.current
    if (canvas === null) return

    let wallpaper = paintWallpaper(choice, dark, window.innerWidth, window.innerHeight)
    // shader 画的是玻璃框「内」的壁纸,框外是 CSS 原图。低对比平滑渐变上
    // saturate/brightness 看不出材质,只会让框内外差一层色,读成一条分层
    // 硬边。材质感交给 CSS 的 tint + rim,这里保持与背景逐像素一致。
    const tone = { saturate: 1, contrast: 1, brightness: 1 }

    const refraction = createRefraction(canvas, {
      source: () => (wallpaper === null ? null : { el: wallpaper, moving: false }),
      surfaces: () => {
        const list: GlassSurface[] = []
        document.querySelectorAll<HTMLElement>(GLASS_SURFACE_SELECTOR).forEach((el) => {
          const box = el.getBoundingClientRect()
          if (box.width < 24 || box.height < 24) return
          const radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
          list.push({
            x: box.left,
            y: box.top,
            w: box.width,
            h: box.height,
            radius,
            rim: 40,
            edge: 1.1,
            power: 2.6,
            blur: 18,
            ...tone,
            keep: 1,
            // 平滑渐变没有纹理,色散看不出来却让 shader 采样翻三倍。
            dispersion: 0,
          })
        })
        return list.slice(0, 8)
      },
    })

    if (refraction === null) {
      root.dataset.glass = 'css'
      return
    }
    root.dataset.glass = 'webgl'
    refractionRef.current = refraction
    refraction.setEnabled(true)
    refraction.frame()

    let scrollTimer = 0
    const onScroll = (): void => {
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => refraction.frame(), 120)
    }
    const onResize = (): void => {
      wallpaper = paintWallpaper(choice, dark, window.innerWidth, window.innerHeight)
      // 新 canvas 与上一次上传的纹理不是同一个对象,draw() 会自动重传。
      refraction.frame()
    }
    window.addEventListener('resize', onResize)
    // 滚动容器里没有 window scroll:capture 才收得到 .library-main 的滚动。
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })

    return () => {
      window.clearTimeout(scrollTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      refraction.setEnabled(false)
      refractionRef.current = null
      root.removeAttribute('data-glass')
    }
  }, [choice, dark])

  // 玻璃卡换位置了(切页面 / 侧栏收起展开):画布不会自己擦,旧的一帧会留在
  // 原地 —— 在笔记/统计页上就是凭空一块「继续阅读卡」形状的浅色。滚动会顺带
  // 补一次,但只在滚动位置真的变了的时候,别指望它。
  // 记下已经画过的 key,挂载那次不必再补一帧。
  const paintedKey = useRef<string | null>(null)
  useEffect(() => {
    if (paintedKey.current === surfaceKey) return
    paintedKey.current = surfaceKey
    refractionRef.current?.frame()
  }, [surfaceKey])

  return canvasRef
}

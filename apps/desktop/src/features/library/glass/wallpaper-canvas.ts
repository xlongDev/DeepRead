import { wallpaperStops, type BackgroundChoice } from '@deepread/design-system'

/**
 * 把 CSS 壁纸重画成一张 canvas,给折射管线当纹理。
 * 颜色计算交给浏览器:--surface-page 是 OKLCH 变量,自己解码永远和
 * CSS 的 color-mix 对不上,重画出来的玻璃会和真实壁纸差一层色。
 */
export function paintWallpaper(
  choice: BackgroundChoice,
  dark: boolean,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const scheme = wallpaperStops(choice, dark)
  if (scheme === null) return null

  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0'
  document.body.append(probe)
  const colors = scheme.stops.map((hex) => {
    probe.style.backgroundColor = `color-mix(in srgb, ${hex} ${scheme.tint}%, var(--surface-page))`
    return getComputedStyle(probe).backgroundColor
  })
  probe.remove()

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0)
  gradient.addColorStop(0, colors[0] ?? 'transparent')
  gradient.addColorStop(0.5, colors[1] ?? 'transparent')
  gradient.addColorStop(1, colors[2] ?? 'transparent')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

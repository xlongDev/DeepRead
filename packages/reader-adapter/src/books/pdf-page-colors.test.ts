import { describe, expect, it } from 'vitest'
import { getPageColorMatrix, recolorPixels } from './vendor/foliate-pdf.js'

/**
 * PDF 夜间模式的重着色矩阵。数学断言移植自 readest 的
 * `pdf-page-colors.test.ts`(foliate-js fork commit 2d0ad8c):亮度线性映射到
 * 前景色→背景色梯度、保留色度,所以黑白主题原样、中间灰平滑、彩色链接保色相。
 */

// 把 feColorMatrix 的一行应用到 RGB 三元组上(带 0..1 截断,同浏览器行为)。
const apply = (matrix: number[], [r, g, b]: number[]) =>
  [0, 1, 2].map((i) => {
    const [mr, mg, mb, , offset] = matrix.slice(i * 5, i * 5 + 5) as number[]
    return Math.min(1, Math.max(0, mr! * r! + mg! * g! + mb! * b! + offset!))
  })

const close = (got: number[], hex: string) =>
  got.forEach((v, i) =>
    expect(v).toBeCloseTo(parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255, 5),
  )

describe('getPageColorMatrix', () => {
  it('leaves a black-on-white theme alone', () => {
    expect(getPageColorMatrix({ foreground: '#000000', background: '#ffffff' })).toBeNull()
  })

  it('turns paper into the theme background and ink into the theme foreground', () => {
    const matrix = getPageColorMatrix({ foreground: '#ffd595', background: '#342e25' })!
    close(apply(matrix, [1, 1, 1]), '#342e25')
    close(apply(matrix, [0, 0, 0]), '#ffd595')
  })

  it('maps mid-grays smoothly instead of posterizing them', () => {
    const matrix = getPageColorMatrix({ foreground: '#ffffff', background: '#000000' })!
    // 64 级灰必须保持 64 个互不相同、均匀分布的色调(对比 pdf.js 自带过滤的
    // 六调量化)。
    const tones = Array.from({ length: 64 }, (_, i) => apply(matrix, [i / 63, i / 63, i / 63])[0]!)
    expect(new Set(tones.map((t) => t.toFixed(4))).size).toBe(64)
    tones.forEach((t, i) => expect(t).toBeCloseTo(1 - i / 63, 5))
  })

  it('keeps the hue of colored ink when the page goes dark', () => {
    const matrix = getPageColorMatrix({ foreground: '#e0e0e0', background: '#222222' })!
    const [r, g, b] = apply(matrix, [0, 0, 0.93]) // a link blue
    expect(b).toBeGreaterThan(r! + 0.2)
    expect(b).toBeGreaterThan(g! + 0.2)
  })

  it('expands three-digit hex', () => {
    const matrix = getPageColorMatrix({ foreground: '#fff', background: '#000' })!
    close(apply(matrix, [0, 0, 0]), '#ffffff')
  })

  it('returns null for missing or malformed colors', () => {
    expect(getPageColorMatrix({})).toBeNull()
    expect(getPageColorMatrix({ foreground: 'red', background: '#000000' })).toBeNull()
    expect(getPageColorMatrix({ foreground: '#ff0000', background: 'rgb(0,0,0)' })).toBeNull()
    expect(getPageColorMatrix(null)).toBeNull()
  })
})

describe('recolorPixels', () => {
  // 逐像素套用(替代 ctx.filter —— WebKit 里 filter 静默失效)。断言它和
  // 上面的矩阵行数学一致,并覆盖 alpha 保留与 0..255 量化。
  const night = { foreground: '#b8b2a7', background: '#131210' }
  const matrix = getPageColorMatrix(night)!

  const recolor = (rgb: number[], alpha = 255, contrast?: number) => {
    const data = new Uint8ClampedArray([rgb[0]!, rgb[1]!, rgb[2]!, alpha])
    recolorPixels(data, night, contrast)
    return Array.from(data)
  }

  it('turns paper into the theme background and ink into the theme foreground', () => {
    expect(recolor([255, 255, 255]).slice(0, 3)).toEqual([0x13, 0x12, 0x10])
    expect(recolor([0, 0, 0]).slice(0, 3)).toEqual([0xb8, 0xb2, 0xa7])
  })

  it('preserves alpha instead of touching it', () => {
    expect(recolor([10, 20, 30], 128)[3]).toBe(128)
    expect(recolor([10, 20, 30], 0)[3]).toBe(0)
  })

  it('clamps out-of-range channels to 0..255', () => {
    // 亮白像素的 R 通道矩阵结果 >1(fg→bg 梯度外推),必须截断而不是回绕。
    const [r] = recolor([255, 255, 255])
    expect(r).toBeLessThanOrEqual(255)
    expect(r).toBeGreaterThanOrEqual(0)
  })

  it('matches the matrix-row math within one quantization step', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [200, 50, 120],
      [17, 99, 233],
      [64, 64, 64],
      [250, 250, 250],
    ]
    for (const [r, g, b] of cases) {
      const got = recolor([r, g, b]).slice(0, 3)
      const want = apply(matrix, [r / 255, g / 255, b / 255]).map((v) => v * 255)
      got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(1))
    }
  })

  it('rewrites pixels in place across a multi-pixel buffer', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
    recolorPixels(data, night)
    expect(Array.from(data)).toEqual([0x13, 0x12, 0x10, 255, 0xb8, 0xb2, 0xa7, 255])
  })

  it('keeps hue of colored ink (chroma-preserving offset)', () => {
    const [r, g, b] = recolor([255, 0, 0])
    expect(r!).toBeGreaterThan(g! + 30)
    expect(r!).toBeGreaterThan(b! + 30)
  })
})

describe('recolorPixels with knee contrast', () => {
  // PDF 位图文字的抗锯齿边缘在线性映射下落中段显虚,暗色主题开膝点:中灰推回
  // 两端。端点(纸→bg、字→fg)因截断天然保住 —— 线性矩阵左乘膝点做不到。
  const night = { foreground: '#b8b2a7', background: '#131210' }
  const CONTRAST = 1.6

  const recolor = (rgb: number[], contrast = CONTRAST) => {
    const data = new Uint8ClampedArray([rgb[0]!, rgb[1]!, rgb[2]!, 255])
    recolorPixels(data, night, contrast)
    return Array.from(data.slice(0, 3))
  }

  const plain = (rgb: number[]) => {
    const data = new Uint8ClampedArray([rgb[0]!, rgb[1]!, rgb[2]!, 255])
    recolorPixels(data, night)
    return Array.from(data.slice(0, 3))
  }

  it('is a no-op at contrast 1', () => {
    const dataA = new Uint8ClampedArray([110, 106, 99, 255])
    const dataB = new Uint8ClampedArray([110, 106, 99, 255])
    recolorPixels(dataA, night)
    recolorPixels(dataB, night, 1)
    expect(Array.from(dataA)).toEqual(Array.from(dataB))
  })

  it('keeps paper and ink endpoints under contrast', () => {
    expect(recolor([255, 255, 255])).toEqual([0x13, 0x12, 0x10])
    expect(recolor([0, 0, 0])).toEqual([0xb8, 0xb2, 0xa7])
  })

  it('pushes anti-aliased edge grays toward the ink side', () => {
    // 边缘中灰(luma≈0.43)在膝点下应更靠近字色 fg,离纸色 bg 更远
    const edge = [110, 106, 99]
    const knee = recolor(edge)
    const linear = plain(edge)
    const ink = [0xb8, 0xb2, 0xa7]
    const dist = (c: number[]) => c.reduce((s, v, i) => s + Math.abs(v - ink[i]!), 0)
    expect(dist(knee)).toBeLessThan(dist(linear))
  })

  it('pushes paper-side grays toward the paper side', () => {
    // 纸面侧的淡灰(luma≈0.6)应更靠近 bg,离 fg 更远
    const pale = [160, 155, 146]
    const knee = recolor(pale)
    const linear = plain(pale)
    const paper = [0x13, 0x12, 0x10]
    const dist = (c: number[]) => c.reduce((s, v, i) => s + Math.abs(v - paper[i]!), 0)
    expect(dist(knee)).toBeLessThan(dist(linear))
  })
})

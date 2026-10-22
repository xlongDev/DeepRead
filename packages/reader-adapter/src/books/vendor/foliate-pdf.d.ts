import type { FoliateBook } from 'foliate-js/view.js'

/** PDF 页面重着色色值(主题色直接以 hex 传入;keepImages = 内嵌图片保原色)。 */
export interface PDFPageColors {
  foreground: string
  background: string
  keepImages?: boolean
  /**
   * 重着色亮度域的中灰膝点对比度(1 = 不加)。PDF 位图文字的抗锯齿边缘在线性
   * 映射下落在 fg→bg 中段显得发虚,暗色主题用 >1 把中灰推回两端。浅色主题 1。
   */
  contrast?: number
}

export function setPageColors(colors: PDFPageColors | null): void
/** 缺字段/非法色值/黑白主题都返回 null(不重着色)。 */
export function getPageColorMatrix(colors: Partial<PDFPageColors> | null): number[] | null
/**
 * 逐像素套用「亮度 → fg→bg 梯度」映射(与 getPageColorMatrix 的 20 值矩阵在
 * sRGB 域数学等价,contrast=1 时逐字节一致)。data 为 RGBA 字节序列
 * (Uint8ClampedArray),原地改写,alpha 保留。不用 ctx.filter:WebKit 里它静默
 * 失效。contrast 以中灰为膝点且带截断,端点(纸→bg、字→fg)天然保住。
 */
export function recolorPixels(
  data: Uint8ClampedArray,
  colors: { foreground: string; background: string },
  contrast?: number,
): void
export function makePDF(file: File): Promise<FoliateBook>

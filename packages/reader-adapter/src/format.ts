/**
 * Format detection and the kernel support matrix (spec §7: only formats the
 * kernel really renders are listed as supported; nothing is faked).
 */

import type { BookFormat } from '@deepread/reader-core'

export type KernelSupport = 'native' | 'adapter' | 'unsupported'

export const FORMAT_SUPPORT: Readonly<Record<BookFormat, KernelSupport>> = {
  epub: 'native',
  mobi: 'native',
  azw3: 'native',
  fb2: 'native',
  cbz: 'native',
  pdf: 'adapter',
  txt: 'adapter',
  md: 'adapter',
  // foliate-js ships no CHM parser; the reader-core contract still allows the
  // format so a future parser can slot in without touching the business layer.
  chm: 'unsupported',
}

const EXTENSION_TO_FORMAT: Readonly<Record<string, BookFormat>> = {
  epub: 'epub',
  mobi: 'mobi',
  prc: 'mobi',
  azw: 'mobi',
  azw3: 'azw3',
  kf8: 'azw3',
  fb2: 'fb2',
  fbz: 'fb2',
  cbz: 'cbz',
  pdf: 'pdf',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  chm: 'chm',
}

/** Detect the format from the original file name (extension-based). */
export function detectFormat(fileName: string): BookFormat | null {
  const name = fileName.toLowerCase()
  if (name.endsWith('.fb2.zip')) return 'fb2'
  const extension = name.split('.').pop() ?? ''
  return EXTENSION_TO_FORMAT[extension] ?? null
}

/**
 * 固定排版格式:folio-fxl 渲染,每页一个 spread。单页/双页切换对所有固定
 * 排版都有效(改的是内核的 spread 分组);滚动形态只有 PDF 有 —— 它的页文档
 * 带自然尺寸与 onZoom(见 reader-adapter/pdf-scroll.ts),CBZ 的 section
 * load() 只给一个 URL,预排不出占位高度。
 */
export const isFixedLayoutFormat = (format: BookFormat): boolean =>
  format === 'pdf' || format === 'cbz'

export function isSupported(format: BookFormat): boolean {
  return FORMAT_SUPPORT[format] !== 'unsupported'
}

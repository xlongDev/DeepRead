import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core'
import type { BookFormat } from '@deepread/reader-core'
import type { LibraryBook } from '@deepread/shared'
import { detectFormat } from '@deepread/reader-adapter'
import { getStoredFile } from './web-store'

/**
 * A book the reader can open: everything is resolved up front so the reader
 * screen never touches files itself (kernel reads `url`).
 */
export interface OpenedBook {
  readonly bookId: string
  readonly format: BookFormat
  readonly hash: string
  readonly name: string
  readonly url: string
  /**
   * 打开后直接落到这条 CFI(笔记页「回到原文」用)。给了它就以它为准,
   * 而不是恢复上次读到的位置 —— 用户点的是某条批注,不是「继续阅读」。
   */
  readonly cfi?: string
}

/**
 * SHA-256 of the book file (WebCrypto), used as the persistence key.
 * # ponytail: buffers the whole file once per import; stream-hash when 100MB
 * TXT imports actually show memory pressure.
 */
export async function sha256Hex(file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** convertFileSrc that degrades to the raw path outside a real Tauri runtime. */
export function convertFileSrc(path: string): string {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return path
  return tauriConvertFileSrc(path)
}

/**
 * Shelf title from a file name: extension off, download-site noise out.
 * Shown until the book's own metadata title is resolved (`displayName`).
 */
export function cleanBookTitle(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  const cleaned = withoutExtension
    // "(z-library.sk, 1lib.sk…)", "[Anna's Archive]", "- Z-Library" and friends.
    // NB: `\]` inside the class is required — an unescaped `]` closes it and
    // the whole bracket-noise match silently stops working.
    .replace(
      /\s*[（([【][^）)\]】]*\b(?:z-?lib\w*|1lib|libgen|dokumen|annas?)[^）)\]】]*[）)\]】]/gi,
      '',
    )
    .replace(/[\s\-–—_]*\b(?:z-?library|z-?lib\.\w+|1lib\.\w+)\b\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s·•\-–—]+$/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : withoutExtension.trim()
}

/**
 * 浏览器端的书籍字节存储。
 *
 * 桌面端把文件留在用户磁盘上,阅读时经 asset 协议读;浏览器里**没有「文件
 * 路径」这回事** —— File 对象只在一次会话里活着,刷新即失效。所以 web 端必须
 * 把字节自己存下来(IndexedDB,见 `web-store.ts`),否则书架刷新后还在、点开
 * 却读不了,那比没有书架更糟。
 */
const browserObjectUrls = new Map<string, string>()

/**
 * 取这本书的 object URL(可直接喂给阅读内核 / 封面提取)。
 * 返回 `''` 表示字节已不在库里 —— 调用方据此跳过,而不是拿空 URL 去解析。
 */
export async function browserBookUrl(hash: string): Promise<string> {
  const cached = browserObjectUrls.get(hash)
  if (cached !== undefined) return cached
  const stored = await getStoredFile(hash)
  if (stored === undefined) return ''
  const url = URL.createObjectURL(stored.blob)
  browserObjectUrls.set(hash, url)
  return url
}

/**
 * 忘掉这本书的 object URL。**只 revoke,不碰 IndexedDB** —— 库里的清理由
 * `library.remove` 的 web handler 负责,两处都删会重复,漏一处会泄漏。
 */
export function forgetBrowserBook(hash: string): void {
  const url = browserObjectUrls.get(hash)
  if (url !== undefined) {
    URL.revokeObjectURL(url)
    browserObjectUrls.delete(hash)
  }
}

/**
 * Open a shelf book. Desktop streams the original file through the asset
 * protocol; in the browser the caller passes the object URL it resolved from
 * IndexedDB (`browserBookUrl`).
 */
export function openedBookFromLibrary(
  record: LibraryBook,
  browserUrl?: string,
  cfi?: string,
): OpenedBook {
  return {
    bookId: record.hash,
    format: record.format as BookFormat,
    hash: record.hash,
    name: record.fileName,
    url: browserUrl ?? convertFileSrc(record.path),
    ...(cfi === undefined ? {} : { cfi }),
  }
}

export type ImportProblem = { readonly kind: 'unsupported' } | { readonly kind: 'chm' }

export function classifyFile(file: File): { format: BookFormat } | ImportProblem {
  const format = detectFormat(file.name)
  if (format === null) return { kind: 'unsupported' }
  if (format === 'chm') return { kind: 'chm' }
  return { format }
}

/** Browser-session import (dev mode); the desktop app imports via library.import. */
export async function openedBookFromFile(file: File, format: BookFormat): Promise<OpenedBook> {
  const hash = await sha256Hex(file)
  return { bookId: hash, format, hash, name: file.name, url: URL.createObjectURL(file) }
}

export const ACCEPTED_EXTENSIONS =
  '.epub,.mobi,.prc,.azw,.azw3,.kf8,.fb2,.fbz,.fb2.zip,.cbz,.pdf,.txt,.text,.md,.markdown'

export const DIALOG_EXTENSIONS = [
  'epub',
  'mobi',
  'prc',
  'azw',
  'azw3',
  'kf8',
  'fb2',
  'fbz',
  'cbz',
  'pdf',
  'txt',
  'text',
  'md',
  'markdown',
]

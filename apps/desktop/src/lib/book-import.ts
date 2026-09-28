import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core'
import type { BookFormat } from '@deepread/reader-core'
import type { LibraryBook } from '@deepread/shared'
import { detectFormat } from '@deepread/reader-adapter'

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
 * Browser-mode (dev) file registry: imported `File` objects live here so the
 * shelf can re-open and re-parse a book after LibraryScreen remounts. File
 * handles cannot survive a reload — that is what the desktop build is for.
 */
const browserFiles = new Map<string, File>()

export function registerBrowserFile(hash: string, file: File): void {
  browserFiles.set(hash, file)
}

export function getBrowserFile(hash: string): File | undefined {
  return browserFiles.get(hash)
}

export function deleteBrowserFile(hash: string): void {
  browserFiles.delete(hash)
  const url = browserObjectUrls.get(hash)
  if (url !== undefined) {
    URL.revokeObjectURL(url)
    browserObjectUrls.delete(hash)
  }
}

/** Stable object URL per imported file (created once, reused by covers/titles). */
const browserObjectUrls = new Map<string, string>()

export function browserBookUrl(hash: string): string {
  let url = browserObjectUrls.get(hash)
  if (url === undefined) {
    const file = browserFiles.get(hash)
    if (file === undefined) return ''
    url = URL.createObjectURL(file)
    browserObjectUrls.set(hash, url)
  }
  return url
}

/**
 * Open a shelf book. Desktop streams the original file through the asset
 * protocol; in the browser `record.path` is empty and the registered `File`
 * provides the URL instead.
 */
export function openedBookFromLibrary(record: LibraryBook, file?: File, cfi?: string): OpenedBook {
  return {
    bookId: record.hash,
    format: record.format as BookFormat,
    hash: record.hash,
    name: record.fileName,
    url: file !== undefined ? URL.createObjectURL(file) : convertFileSrc(record.path),
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

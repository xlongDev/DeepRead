/**
 * Real cover extraction (spec: 书籍封面). Uses the reading kernel itself:
 * EPUB/MOBI expose getCover(), PDF page 1 renders through pdf.js. Falls back
 * to null so the shelf can draw its generated cover. Results are object URLs
 * the caller caches per book hash.
 */

import { EPUB } from 'foliate-js/epub.js'
import { MOBI } from 'foliate-js/mobi.js'
import { unzlibSync } from 'foliate-js/vendor/fflate.js'
import { BlobReader, BlobWriter, TextWriter, ZipReader, configure } from 'foliate-js/vendor/zip.js'
import type { BookFormat } from '@deepread/reader-core'
import type { FoliateBook } from 'foliate-js/view.js'

async function makeZipLoader(file: File) {
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(file))
  const entries = await reader.getEntries()
  const map = new Map(entries.map((entry) => [entry.filename, entry]))
  const load =
    <T, A extends unknown[]>(
      f: (entry: NonNullable<ReturnType<typeof map.get>>, ...args: A) => Promise<T>,
    ) =>
    (name: string, ...args: A): Promise<T> | null =>
      map.has(name) ? f(map.get(name)!, ...args) : null
  return {
    entries,
    loadText: load((entry) => entry.getData(new TextWriter()) as Promise<string>),
    loadBlob: load((entry, type: string) => entry.getData(new BlobWriter(type)) as Promise<Blob>),
    getSize: (name: string) => map.get(name)?.uncompressedSize ?? 0,
  }
}

async function kernelCover(book: FoliateBook): Promise<string | null> {
  try {
    const cover = await book.getCover?.()
    return cover ? URL.createObjectURL(cover) : null
  } catch {
    return null
  }
}

async function fetchAsFile(url: string, name: string, type: string): Promise<File | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    return new File([blob], name, { type })
  } catch {
    return null
  }
}

async function openEpub(url: string): Promise<FoliateBook | null> {
  const file = await fetchAsFile(url, 'book.epub', 'application/epub+zip')
  if (!file) return null
  try {
    const loader = await makeZipLoader(file)
    return await new EPUB(loader).init()
  } catch {
    return null
  }
}

async function openMobi(url: string): Promise<FoliateBook | null> {
  const file = await fetchAsFile(url, 'book.mobi', 'application/x-mobipocket-ebook')
  if (!file) return null
  try {
    return await new MOBI({ unzlib: unzlibSync }).open(file)
  } catch {
    return null
  }
}

export async function extractEpubCover(url: string): Promise<string | null> {
  const file = await fetchAsFile(url, 'book.epub', 'application/epub+zip')
  if (!file) return null
  try {
    const loader = await makeZipLoader(file)
    const book = await new EPUB(loader).init()
    const cover = await kernelCover(book)
    if (cover) return cover
    // Fallback: some EPUBs declare the cover only by file name convention.
    const imageEntry = loader.entries.find(
      (entry) => /cover/i.test(entry.filename) && /\.(jpe?g|png|webp|gif)$/i.test(entry.filename),
    )
    if (!imageEntry) return null
    const extension = (
      /\.(jpe?g|png|webp|gif)$/i.exec(imageEntry.filename)?.[1] ?? 'jpeg'
    ).toLowerCase()
    const mime =
      extension === 'png'
        ? 'image/png'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'gif'
            ? 'image/gif'
            : 'image/jpeg'
    const blob = (await imageEntry.getData(new BlobWriter(mime))) as Blob | undefined
    return blob && blob.size > 0 ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}

export async function extractMobiCover(url: string): Promise<string | null> {
  const book = await openMobi(url)
  return book ? kernelCover(book) : null
}

/** Render the first non-blank PDF page (max 3) and return it as an object URL. */
export async function extractPdfCover(url: string): Promise<string | null> {
  try {
    const pdfjs = await import('pdfjs-dist')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        './books/vendor/pdfjs/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()
    }
    const pdf = await pdfjs.getDocument({
      url,
      // Chinese PDFs need CMaps for text; served from the app bundle.
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    }).promise
    const pagesToTry = Math.min(3, pdf.numPages)
    for (let pageNumber = 1; pageNumber <= pagesToTry; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = 480 / baseViewport.height
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) return null
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: context, viewport, canvas }).promise
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve))
      if (!blob) return null
      // A real cover is never blank; some PDFs open with an empty page
      // before the actual cover, so skip those and keep looking.
      if (!(await isCanvasBlank(context, canvas.width, canvas.height))) {
        return URL.createObjectURL(blob)
      }
    }
    return null
  } catch {
    return null
  }
}

/** True when >99.5% of sampled pixels are near-white. */
async function isCanvasBlank(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<boolean> {
  const { data } = context.getImageData(0, 0, width, height)
  const stride = Math.max(1, Math.floor(data.length / 4 / 400)) // ~400 samples
  let sampled = 0
  let nonWhite = 0
  for (let i = 0; i < data.length; i += 4 * stride) {
    sampled++
    const r = data[i] ?? 255
    const g = data[i + 1] ?? 255
    const b = data[i + 2] ?? 255
    if (r < 245 || g < 245 || b < 245) nonWhite++
  }
  return sampled === 0 || nonWhite / sampled < 0.005
}

/**
 * The book's own title. Download-site file names are noise ("…(z-library…)"),
 * and PDFs often carry the source file name as metadata — both are rejected
 * here so the shelf never shows them.
 */
function normalizeTitle(raw: string | undefined | null): string | null {
  if (!raw) return null
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0 || text.length > 200) return null
  if (/\.(pdf|docx?|pptx?|xlsx?|epub|txt)$/i.test(text)) return null
  return text
}

/** Extract the real title for a book; null means "fall back to the file name". */
export async function extractTitle(url: string, format: BookFormat): Promise<string | null> {
  switch (format) {
    case 'epub':
      return normalizeTitle((await openEpub(url))?.metadata?.title)
    case 'mobi':
    case 'azw3':
      return normalizeTitle((await openMobi(url))?.metadata?.title)
    case 'pdf': {
      try {
        const pdfjs = await import('pdfjs-dist')
        const pdf = await pdfjs.getDocument({ url }).promise
        const info = (await pdf.getMetadata()).info as { Title?: string } | undefined
        void pdf.cleanup()
        return normalizeTitle(info?.Title)
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

/** Extract a cover URL for a book; null means "draw the generated cover". */
export async function extractCover(url: string, format: BookFormat): Promise<string | null> {
  switch (format) {
    case 'epub':
      return extractEpubCover(url)
    case 'mobi':
    case 'azw3':
      return extractMobiCover(url)
    case 'pdf':
      return extractPdfCover(url)
    default:
      return null
  }
}

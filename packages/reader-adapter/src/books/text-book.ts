/**
 * Plain-text books for the foliate kernel.
 *
 * The kernel has no TXT parser, so this implements its `book` interface
 * directly (README: "Add support for other formats yourself"). The text is
 * never rewritten: paragraphs are wrapped in <p> and escaped, nothing else.
 * The file is split into sections of a bounded paragraph count so large books
 * do not create one giant iframe.
 */

import type { FoliateBook, FoliateSection, FoliateTocItem } from 'foliate-js/view.js'

import { byteLength } from './bytes'
import { chapterMatcherFromRules, isChapterTitle, type ChapterRule } from '@deepread/ai-core'

const PARAGRAPHS_PER_SECTION = 400

/**
 * Built-in chapter rules (spec §15 第一批): a short paragraph that *starts*
 * with a chapter marker opens a new section. Content that merely contains
 * such a marker never splits — false positives stay inside their paragraph.
 */

/** A paragraph that opens with a quotation mark reads as dialogue (ColorTxt). */
export function isDialogue(paragraph: string): boolean {
  return /^\s*[“”「『"'‘]/.test(paragraph)
}

export function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    // Not valid UTF-8: common Chinese web novels are GBK/GB18030.
    try {
      return new TextDecoder('gb18030').decode(buffer)
    } catch {
      return new TextDecoder().decode(buffer)
    }
  }
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function splitParagraphs(text: string): string[] {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
}

function sectionHtml(
  paragraphs: readonly { text: string; chapter: boolean; dialogue: boolean }[],
): string {
  const body = paragraphs
    .map(({ text, chapter, dialogue }) => {
      const escaped = escapeHtml(text)
      if (chapter) return `<h2 class="enh-chapter">${escaped}</h2>`
      if (dialogue) return `<p class="enh-dialogue">${escaped}</p>`
      return `<p>${escaped}</p>`
    })
    .join('\n')
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body { margin: 0; padding: 1em; }',
    '.enh-chapter { line-height: 1.3; }',
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('\n')
}

/** Group raw source text into chapter-labeled sections (RAG indexing). */
export function chapterSections(text: string): { label: string; text: string }[] {
  const sections: { label: string; text: string }[] = [{ label: '开篇', text: '' }]
  for (const paragraph of splitParagraphs(text)) {
    if (isChapterTitle(paragraph)) sections.push({ label: paragraph, text: '' })
    const current = sections[sections.length - 1]
    if (current) current.text = current.text ? `${current.text}\n\n${paragraph}` : paragraph
  }
  return sections.filter((section) => section.text.trim().length > 0)
}

export function buildTextBook(
  text: string,
  title: string,
  options?: { chapterRules?: readonly ChapterRule[] },
): FoliateBook {
  const paragraphs = splitParagraphs(text)

  // Group into chapters at detected markers; content before the first marker
  // becomes its own opening section. Long chapterless runs still fall back to
  // the bounded chunk so huge flat files never create one giant iframe.
  type Block = { text: string; chapter: boolean; dialogue: boolean }
  const sections: { blocks: Block[]; chapterTitle?: string }[] = [{ blocks: [] }]
  const isTitle = options?.chapterRules
    ? chapterMatcherFromRules(options.chapterRules)
    : isChapterTitle
  for (const paragraph of paragraphs) {
    if (isTitle(paragraph)) {
      sections.push({
        blocks: [{ text: paragraph, chapter: true, dialogue: false }],
        chapterTitle: paragraph,
      })
      continue
    }
    const current = sections[sections.length - 1]!
    current.blocks.push({ text: paragraph, chapter: false, dialogue: isDialogue(paragraph) })
    if (current.blocks.length >= PARAGRAPHS_PER_SECTION && !current.chapterTitle) {
      sections.push({ blocks: [] })
    }
  }

  const builtSections: FoliateSection[] = []
  const toc: FoliateTocItem[] = []
  for (const section of sections) {
    if (section.blocks.length === 0) continue
    const index = builtSections.length
    const html = sectionHtml(section.blocks)
    const heading = section.blocks.find((b) => b.chapter)
    if (heading) toc.push({ label: heading.text, href: `s${index}` })
    builtSections.push({
      id: `s${index}`,
      size: byteLength(section.blocks.map((b) => b.text).join('\n\n')),
      // The kernel's section contract: load() resolves to a URL *string*.
      load: async () => URL.createObjectURL(new Blob([html], { type: 'text/html' })),
      // # ponytail: every section keeps its full HTML in memory for instant
      // re-open; swap to on-demand rebuild from the source buffer if a 100MB
      // TXT actually shows memory pressure.
      createDocument: async () => new DOMParser().parseFromString(html, 'text/html'),
    })
  }

  return {
    metadata: { title },
    dir: 'ltr',
    toc: toc satisfies FoliateTocItem[],
    sections: builtSections,
    splitTOCHref: (href) => {
      const match = /^s(\d+)$/.exec(href)
      return match ? [Number(match[1]), null] : [0, null]
    },
    getTOCFragment: (doc) => doc.body,
    resolveHref: async (href) => {
      const match = /^s(\d+)$/.exec(href)
      // The anchor function routes the kernel into its precise rect-scrolling
      // branch; index-only targets land one column into the page strip.
      return {
        index: match ? Number(match[1]) : 0,
        anchor: (doc: Document): Element => doc.body,
      }
    },
  }
}

export { isChapterTitle } from '@deepread/ai-core'

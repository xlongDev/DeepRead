/**
 * Chapter-aware RAG pipeline (spec §32/§33): section-based chunking with
 * bounded windows, cosine retrieval, and citation-preserving message
 * assembly. The product always cites chapter labels; when retrieval has no
 * confident source the prompt instructs the model to say so explicitly.
 */

import type { ChatMessage } from './types'

export interface RagChunk {
  /** Human-readable chapter/section label shown as a citation. */
  readonly label: string
  readonly text: string
  readonly vector: readonly number[]
}

export interface RagSection {
  readonly label: string
  readonly text: string
}

const CHUNK_TARGET = 800
const CHUNK_OVERLAP = 120

/** Split an oversized single paragraph at sentence boundaries. */
function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= CHUNK_TARGET) return [paragraph]
  const sentences = paragraph.split(/(?<=[。！？!?])/)
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length > CHUNK_TARGET) {
      pieces.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim().length > 0) pieces.push(current)
  return pieces
}

/** Built-in chapter rule (spec §15): also mirrored by the TXT adapter. */
export const BUILT_IN_CHAPTER_PATTERN =
  /^\s*(?:(?:序章|楔子|终章|尾声|番外[一二三四五六七八九十]*)(?:[\s：:].{0,30})?|(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章卷回节部篇])(?:[\s：:.、]{0,3}[^\n]{0,30})?)\s*$/

/** Built-in chapter-title test: short paragraph matching the built-in rule. */
export function isChapterTitle(paragraph: string): boolean {
  return paragraph.length <= 44 && BUILT_IN_CHAPTER_PATTERN.test(paragraph)
}

/** Split source text into chapter-labeled sections using a chapter matcher. */
export function chapterSectionsWith(
  text: string,
  isTitle: (paragraph: string) => boolean,
): { label: string; text: string }[] {
  const paragraphs = text.split(/\r?\n\r?\n|\r?\n/)
  const sections: { label: string; text: string }[] = []
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    if (isTitle(trimmed) && trimmed.length <= 60) {
      sections.push({ label: trimmed, text: trimmed })
    } else if (sections.length > 0) {
      const current = sections[sections.length - 1]
      if (current) current.text = `${current.text}\n\n${trimmed}`
    } else {
      sections.push({ label: '开篇', text: trimmed })
    }
  }
  return sections.filter((section) => section.text.trim().length > 0)
}

/** Split one section's text into overlapping windows on paragraph bounds. */
export function chunkSectionText(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (trimmed.length <= CHUNK_TARGET) return [trimmed]

  const paragraphs = trimmed.split(/\n{2,}/).flatMap((paragraph) => splitLongParagraph(paragraph))
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > CHUNK_TARGET) {
      chunks.push(current)
      // carry a tail overlap so answers can span the boundary
      current = current.slice(-CHUNK_OVERLAP) + '\n\n' + paragraph
    } else {
      current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`
    }
  }
  if (current.trim().length > 0) chunks.push(current)
  return chunks
}

/** Chunk sections in order; chunk ids become `label#index`. */
export function buildRagChunks(sections: readonly RagSection[]): { label: string; text: string }[] {
  const chunks: { label: string; text: string }[] = []
  for (const section of sections) {
    const pieces = chunkSectionText(section.text)
    pieces.forEach((text, index) => {
      chunks.push({
        label: pieces.length === 1 ? section.label : `${section.label}(${index + 1})`,
        text,
      })
    })
  }
  return chunks
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface RetrievedChunk {
  readonly label: string
  readonly text: string
  readonly score: number
}

/** Top-K cosine retrieval over the indexed chunks. */
export function retrieve(
  chunks: readonly RagChunk[],
  queryVector: readonly number[],
  topK = 4,
  minScore = 0.05,
): readonly RetrievedChunk[] {
  return chunks
    .map((chunk) => ({
      label: chunk.label,
      text: chunk.text,
      score: cosineSimilarity(chunk.vector, queryVector),
    }))
    .filter((chunk) => chunk.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** Build the chat messages for a RAG question, with citation rules in the system prompt. */
export function buildRagMessages(
  question: string,
  retrieved: readonly RetrievedChunk[],
  history: readonly ChatMessage[] = [],
): readonly ChatMessage[] {
  const context =
    retrieved.length === 0
      ? '(未检索到相关正文片段)'
      : retrieved.map((chunk, index) => `[${index + 1}] ${chunk.label}\n${chunk.text}`).join('\n\n')
  const system: ChatMessage = {
    role: 'system',
    content: [
      '你是电子书阅读助手。仅依据下面的书籍片段回答用户问题;回答中必须标注所引用片段的编号,例如 [1]。',
      '如果片段不足以回答,明确说"书中没有找到相关内容,以下是模型推测"。禁止编造书中没有的内容。',
      '',
      '书籍片段:',
      context,
    ].join('\n'),
  }
  return [
    system,
    ...history.filter((m) => m.role !== 'system'),
    { role: 'user', content: question },
  ]
}

/** Compact citation list for UI chips (dedup by label, keep order). */
export function citationLabels(retrieved: readonly RetrievedChunk[]): readonly string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const chunk of retrieved) {
    if (seen.has(chunk.label)) continue
    seen.add(chunk.label)
    labels.push(chunk.label)
  }
  return labels
}

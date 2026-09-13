/**
 * TTS text segmentation (spec §44-§46).
 *
 * Pure functions: section text → speakable segments tagged with a speaker
 * ('narrator' or a character name), so the UI can assign a voice per character
 * (multi-character TTS) and show the currently spoken sentence. The kernel is
 * never touched here — callers feed plain text in.
 */

export interface SpeechSegment {
  readonly text: string
  /** 'narrator' or a character name (dialogue attribution). */
  readonly speaker: string
}

/** Sentence enders: CJK punctuation plus western .!?; with the terminator kept. */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '；', '：', '…', '.', '!', '?', ';', ':'])

/** Quotes that wrap dialogue in CJK and western typography. */
const DIALOGUE_QUOTES = /[「『“"']([^「『“"'」』”"'”]*?)[」』”"']/

const MAX_SENTENCE_CHARS = 220

/**
 * Split text into speakable sentences (terminators kept on the chunk). Very
 * long un-terminated runs are cut at a comma boundary, then hard-cut, so no
 * single utterance outgrows the synthesizer's practical limits.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.trim()) pushChunked(sentences, buffer.trim())
    buffer = ''
  }
  for (const char of text) {
    if (char === '\n') {
      flush()
      continue
    }
    buffer += char
    if (SENTENCE_ENDERS.has(char)) flush()
  }
  flush()
  return mergeShort(sentences)
}

function pushChunked(out: string[], piece: string): void {
  let rest = piece.trim()
  while (rest.length > MAX_SENTENCE_CHARS) {
    const window = rest.slice(0, MAX_SENTENCE_CHARS)
    const cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
    )
    const at = cut > 40 ? cut + 1 : MAX_SENTENCE_CHARS
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
}

/** Merge fragments too short to sound natural (terminators split off above). */
function mergeShort(sentences: readonly string[]): string[] {
  const merged: string[] = []
  for (const sentence of sentences) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && (previous.length < 4 || sentence.length < 4)) {
      merged[merged.length - 1] = previous + sentence
    } else {
      merged.push(sentence)
    }
  }
  return merged
}

/**
 * Segment into narrator/dialogue spans (spec §45 dialogue detection): text
 * inside CJK/western quotes becomes a dialogue segment, everything between
 * stays narration. Speaker attribution happens later in `assignSpeakers`.
 */
export function splitDialogue(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  let rest = text
  while (rest.length > 0) {
    const match = DIALOGUE_QUOTES.exec(rest)
    if (match === null || match.index === undefined) {
      pushNarrator(segments, rest)
      break
    }
    pushNarrator(segments, rest.slice(0, match.index))
    segments.push({ text: match[0], speaker: 'narrator' })
    rest = rest.slice(match.index + match[0].length)
  }
  return segments.filter((segment) => segment.text.trim().length > 0)
}

function pushNarrator(segments: SpeechSegment[], text: string): void {
  const trimmed = text.trim()
  if (trimmed) segments.push({ text: trimmed, speaker: 'narrator' })
}

/**
 * Attribute dialogue to characters (spec §45): a dialogue whose neighbouring
 * narration mentions exactly one known character name gets that name; all
 * ambiguous or unattributed dialogue stays with the narrator voice.
 */
export function assignSpeakers(
  segments: readonly SpeechSegment[],
  knownNames: readonly string[],
): SpeechSegment[] {
  if (knownNames.length === 0) return [...segments]
  return segments.map((segment, index) => {
    if (!isQuoted(segment.text)) return segment
    // The nearest narration that names exactly one character owns the line;
    // Chinese dialogue tags sit before or after the quote.
    const before = neighbouringText(segments, index, -1)
    const after = neighbouringText(segments, index, +1)
    const named = singleName(before, knownNames) ?? singleName(after, knownNames)
    return named !== null ? { ...segment, speaker: named } : segment
  })
}

function singleName(text: string, knownNames: readonly string[]): string | null {
  const names = knownNames.filter((name) => text.includes(name))
  return names.length === 1 ? names[0]! : null
}

function neighbouringText(segments: readonly SpeechSegment[], index: number, step: -1 | 1): string {
  for (let i = index + step; i >= 0 && i < segments.length; i += step) {
    if (segments[i]!.speaker !== 'narrator') continue
    return step === -1 ? segments[i]!.text.slice(-40) : segments[i]!.text.slice(0, 40)
  }
  return ''
}

function isQuoted(text: string): boolean {
  return /^[「『“"']/.test(text.trim()) || DIALOGUE_QUOTES.test(text)
}

/** One-shot pipeline: section text + known character names → speakable plan. */
export function buildSpeechSegments(
  text: string,
  knownNames: readonly string[] = [],
): SpeechSegment[] {
  return assignSpeakers(splitDialogue(text), knownNames)
}

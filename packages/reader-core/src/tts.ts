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

/** CJK 硬句末:句号、感叹号、问号、省略号。每遇必切。 */
const CJK_HARD_ENDERS = new Set(['。', '！', '？', '…'])

/** CJK 软句末:分号、冒号。短句里保留(读起来是同一句),超长才切,
 *  否则一句话能被分号拆成两半,歌词页失去意义。 */
const CJK_SOFT_ENDERS = new Set(['；', '：'])

/** 西文 ender。必须后跟空白或字符串结尾才切,
 *  否则 Dr. Mr. 这种缩写会被误切。 */
const ASCII_ENDERS = new Set(['.', '!', '?'])

/** Quotes that wrap dialogue in CJK and western typography. */
const DIALOGUE_QUOTES = /[「『“"']([^「『“"'」』”"'”]*?)[」』”"']/

const MAX_SENTENCE_CHARS = 220

/**
 * Split text into speakable sentences (terminators kept on the chunk). Very
 * long un-terminated runs are cut at a comma boundary, then hard-cut, so no
 * single utterance outgrows the synthesizer's practical limits.
 *
 * 切句规则:
 * - CJK 硬句末(。！？…)必切。
 * - CJK 软句末(；：)只在 buffer 超过 {@link SOFT_ENDER_THRESHOLD} 字时才切,
 *   短句里读起来是同一句的不切。
 * - 西文 . ! ? 必须后跟空白/字符串结尾才切,Dr. / Mr. 这种缩写不切。
 */
const SOFT_ENDER_THRESHOLD = 60

export function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.trim()) pushChunked(sentences, buffer.trim())
    buffer = ''
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) continue
    buffer += char
    if (char === '\n') {
      flush()
      continue
    }
    if (CJK_HARD_ENDERS.has(char)) {
      flush()
      continue
    }
    if (CJK_SOFT_ENDERS.has(char)) {
      if (buffer.length > SOFT_ENDER_THRESHOLD) flush()
      continue
    }
    if (ASCII_ENDERS.has(char)) {
      const next = text[index + 1]
      if (next === undefined || /\s/.test(next)) flush()
    }
  }
  flush()
  return mergeShort(sentences)
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

/** 一个句子的文本,以及它在**原文**中的字符起点。 */
export interface SentenceSlice {
  readonly text: string
  readonly start: number
}

/**
 * 切句并带上**原文**字符偏移 —— TTS 高亮/自动翻页要的就是这个。
 *
 * 与 {@link splitSentences} 的区别:
 * - 返回 `{ text, start }`,`start` 是句子在传入文本里的真实下标,调用方
 *   据此把句子位置映射回 DOM。`splitSentences` 只给字符串,调用方用
 *   「句子长度累加」推 start —— 一旦中间有被 trim 掉的空白(比如块级
 *   元素之间的换行),后续每一句都会累积偏移,高亮越读越偏。
 * - 不合并短句:短标题被并进正文,高亮范围就不再是「一句」。
 *
 * 空白(换行/块级边界)本身不产出句子,但计入后面句子的 `start`。
 */
export function splitSentencesWithOffsets(text: string): SentenceSlice[] {
  const out: SentenceSlice[] = []
  let from = -1
  let to = -1
  const flush = (): void => {
    if (from !== -1 && to > from) pushSlices(out, text, from, to)
    from = -1
    to = -1
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) continue
    if (char === '\n') {
      flush()
      continue
    }
    if (from === -1) from = index
    to = index + 1
    if (CJK_HARD_ENDERS.has(char)) {
      flush()
      continue
    }
    if (CJK_SOFT_ENDERS.has(char)) {
      if (to - from > SOFT_ENDER_THRESHOLD) flush()
      continue
    }
    if (ASCII_ENDERS.has(char)) {
      const next = text[index + 1]
      if (next === undefined || isSpace(next)) flush()
    }
  }
  flush()
  return out
}

/** 超长片段按逗号切,每片保留自己在原文里的 start(不 trim,边界已在 caller 收窄)。 */
function pushSlices(out: SentenceSlice[], text: string, from: number, to: number): void {
  let cursor = from
  // 先收窄首尾空白:空白不属于句子,但 start 必须是原文下标。
  while (cursor < to && isSpace(text[cursor])) cursor += 1
  let end = to
  while (end > cursor && isSpace(text[end - 1])) end -= 1
  while (end - cursor > MAX_SENTENCE_CHARS) {
    const window = text.slice(cursor, cursor + MAX_SENTENCE_CHARS)
    const cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
    )
    const at = cut > 40 ? cursor + cut + 1 : cursor + MAX_SENTENCE_CHARS
    out.push({ text: text.slice(cursor, at), start: cursor })
    cursor = at
  }
  if (end > cursor) out.push({ text: text.slice(cursor, end), start: cursor })
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
  // 叙述与对话都按句切分,播放器才能逐句高亮(长段落整段一段会让
  // 歌词页失去意义)。
  for (const sentence of splitSentences(text)) {
    segments.push({ text: sentence, speaker: 'narrator' })
  }
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

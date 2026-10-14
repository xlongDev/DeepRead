/**
 * TTS read-aloud units (ported from ColorReader's `speech.ts`).
 *
 * Pure functions: section text → speakable units tagged with a speaker
 * ('narrator' or a character name), so the UI can assign a voice per character
 * (multi-character TTS) and wash exactly what the voice is on.
 *
 * The cut is **one unit per sentence**, never per quote: a sentence that
 * contains dialogue is one utterance, because the voice says it in one breath.
 * Splitting at quote boundaries (the old model) cut one sentence into several
 * clips, and the gap between two clips is audible — the reader hears a stall
 * every time the text meets a 「」 or “”. ColorReader's `Intl.Segmenter`-based
 * cut keeps the quote inside its sentence, which is what the voice does too.
 */

/**
 * 朗读单元:一句话 + 它在**章节原文**里的字符区间 + 说话人。
 *
 * 与 ColorReader 的 `SpeechUnit` 同构,只差两点:
 * - 多一个 `speaker`(DeepRead 的多角色配音按单元选音色);
 * - `start`/`end` 是**章节绝对偏移**(ColorReader 是块内偏移)——
 *   DeepRead 只有一个 source(整章文本),高亮广播(`onHighlight`)与
 *   歌词页 seek 用的都是章节绝对偏移,少一层换算。
 */
export interface SpeechUnit {
  /** 朗读文本:原文切片,不做任何规范化 —— 引擎报回来的 charIndex 必须
   *  能原样映射回正文,拷贝一份会漂。 */
  readonly text: string
  /** 章节序号(整章一个 source)。 */
  readonly source: number
  /** 半开区间 `[start, end)`,UTF-16 偏移,相对章节原文。 */
  readonly start: number
  readonly end: number
  /** `narrator` 或角色名。 */
  readonly speaker: string
}

/** 引擎状态:三个引擎(Edge/云端/系统)都报这一组。 */
export type SpeechStatus = 'idle' | 'playing' | 'paused'

/** 引擎报回的「声音在哪」:单元下标 + 单元内字符偏移。 */
export interface SpeechBoundary {
  readonly unit: number
  /** UTF-16 偏移,相对单元自己的 text。 */
  readonly charIndex: number
  /** 词长;引擎只报起点时为 0。 */
  readonly charLength: number
}

/** 一个词的时间锚点:秒 + 在单元文本里的字符区间。 */
export interface WordCue {
  readonly at: number
  readonly start: number
  readonly end: number
}

/** 半开字符区间。 */
export interface Span {
  readonly start: number
  readonly end: number
}

/* -------------------------------------------------------------------------- */
/* 断句                                                                      */
/* -------------------------------------------------------------------------- */

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: string },
) => { segment(input: string): Iterable<{ segment: string; index: number }> }

/** `Intl.Segmenter` 在 WKWebView / Chromium 都有;没有就退回近似。 */
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter

/**
 * Fallback sentence cutter for engines without `Intl.Segmenter`: a run up to
 * and including its terminator, plus any closing quote or bracket. Chinese and
 * Latin terminators are both covered, and a bare newline also ends a sentence
 * so a heading never swallows the paragraph under it.
 */
const SENTENCE_CUTTER = /[^。！？!?…\n]*[。！？!?…]+[”’"'』」）)]*|[^。！？!?…\n]+/g

/**
 * 句子跨度:一段原文里的每一句,半开区间。
 *
 * `Intl.Segmenter` 是首选 —— 它按 UAX #29 断句,引号/括号跟在句末标点之后
 * (`他说:“你好。”` 不会被切成 `他说:“` + `你好。”`),这正是「一句一呼吸」
 * 的读法。回退正则同款语义:终止符 + 收尾引号/括号算一句。
 */
function sentenceSpans(text: string): Span[] {
  if (Segmenter) {
    const segmenter = new Segmenter('zh', { granularity: 'sentence' })
    return [...segmenter.segment(text)].map(({ index, segment }) => ({
      start: index,
      end: index + segment.length,
    }))
  }
  return [...text.matchAll(SENTENCE_CUTTER)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }))
}

/**
 * Trims a run of the raw text down to what the voice actually says, keeping
 * the offsets honest: the leading whitespace HTML pretty-printing leaves in
 * front of a sentence is dropped from the utterance *and* from its start, so
 * a `charIndex` inside the utterance still lands on the right character.
 * (块级元素之间的虚拟换行也在这一步被剥掉 —— 它不属于任何一句话。)
 */
function trimSpan(raw: string, start: number): { text: string; start: number; end: number } {
  const lead = raw.length - raw.trimStart().length
  const text = raw.trim()
  return { text, start: start + lead, end: start + lead + text.length }
}

/**
 * 超长句的安全网:一句没有任何终止符地跑过 {@link MAX_SENTENCE_CHARS} 字时,
 * 按逗号切(切不动就硬切),每片保留自己在原文里的偏移。
 *
 * 正常行文一句话到不了这个长度;这是给「整段没有标点」的病态文本兜底的,
 * 免得一个单元长到合成服务拒绝。切分不改变正常句子的行为。
 */
const MAX_SENTENCE_CHARS = 220

function chunkLongSentence(
  text: string,
  start: number,
): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  if (text.length <= MAX_SENTENCE_CHARS) {
    return [{ text, start, end: start + text.length }]
  }
  const pieces: { text: string; start: number; end: number }[] = []
  let cursor = 0
  while (text.length - cursor > MAX_SENTENCE_CHARS) {
    const window = text.slice(cursor, cursor + MAX_SENTENCE_CHARS)
    const cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
    )
    const at = cut > 40 ? cursor + cut + 1 : cursor + MAX_SENTENCE_CHARS
    pieces.push({ text: text.slice(cursor, at), start: start + cursor, end: start + at })
    cursor = at
  }
  if (cursor < text.length) {
    pieces.push({ text: text.slice(cursor), start: start + cursor, end: start + text.length })
  }
  return pieces
}

/* -------------------------------------------------------------------------- */
/* 说话人归属                                                                */
/* -------------------------------------------------------------------------- */

/** 引号包住的对白:归属说话人时要把对白文本从窗口里剔掉(对白里提到的名字
 *  不是说话的人)。不成对的引号不匹配 —— 归属只是启发式,漏了比错了好。 */
const QUOTED_RUN = /[「『“"'][^「『“"』’”]*[」』”"']/g
const QUOTED_RUN_ONCE = /[「『“"'][^「『“"』’”]*[」’”"']/

/** 收尾引号/括号:对白在句中出现时,它之后的叙述才是「本句之后」的窗口。 */
const CLOSING_QUOTE = /[」』”"']/g

/** 任意引号:定位本句里第一处对白的起点(不锚定 —— 引号常在句中)。 */
const ANY_QUOTE = /[「『“"']/

/** 已知角色名里,文本恰好只提到一个的那个;0 个或 ≥2 个都返回 null。 */
function singleName(text: string, knownNames: readonly string[]): string | null {
  const names = knownNames.filter((name) => text.includes(name))
  return names.length === 1 ? names[0]! : null
}

/** 单元里的叙述文本(对白剔除后的部分)。 */
function narrationOf(text: string): string {
  return text.replace(QUOTED_RUN, '')
}

/** 归属窗口:本句引号之前的叙述 + 向前最近的句子叙述;引号之后的 + 向后的。
 *  各 40 字,规则同旧版 assignSpeakers —— 前后最近的叙述里唯一提到的人名
 *  认领这句对白。本句引号同侧有叙述就只用它:拼窗口会把上一场的说话人
 *  也算进来(青柳/雅子连说两句就会认错)。 */
function attributionWindows(
  units: readonly SpeechUnit[],
  index: number,
): { before: string; after: string } {
  const WINDOW = 40
  const own = units[index]!
  const firstQuote = own.text.search(ANY_QUOTE)
  let lastQuote = -1
  for (const match of own.text.matchAll(CLOSING_QUOTE)) {
    lastQuote = match.index ?? -1
  }
  const ownBefore = firstQuote < 0 ? '' : own.text.slice(0, firstQuote)
  const ownAfter = lastQuote < 0 ? '' : own.text.slice(lastQuote + 1)
  const spoken = (text: string): boolean => narrationOf(text).trim() !== ''
  let before = ownBefore
  if (before.trim() === '') {
    for (let at = index - 1; at >= 0; at -= 1) {
      if (!spoken(units[at]!.text)) continue
      before = narrationOf(units[at]!.text).slice(-WINDOW)
      break
    }
  }
  let after = ownAfter
  if (after.trim() === '') {
    for (let at = index + 1; at < units.length; at += 1) {
      if (!spoken(units[at]!.text)) continue
      after = narrationOf(units[at]!.text).slice(0, WINDOW)
      break
    }
  }
  return { before: before.slice(-WINDOW), after: after.slice(0, WINDOW) }
}

/**
 * 含对白的单元按邻近叙述认领说话人;纯叙述与认领不了一致的都留给叙述者。
 *
 * 句级切分之后,对白通常独占一句(`“你好。”他说。` → 两句),多角色配音的
 * 常见写法因此完全保留;`青柳说:「谢谢你。」` 这种引号嵌在句中的,整句算
 * 在青柳头上 —— 一句话一个音色,不在一句中间换声。
 */
function attributeSpeakers(
  units: readonly SpeechUnit[],
  knownNames: readonly string[],
): SpeechUnit[] {
  if (knownNames.length === 0) return [...units]
  return units.map((unit, index) => {
    if (!QUOTED_RUN_ONCE.test(unit.text)) return unit
    const { before, after } = attributionWindows(units, index)
    const named = singleName(before, knownNames) ?? singleName(after, knownNames)
    return named !== null ? { ...unit, speaker: named } : unit
  })
}

/* -------------------------------------------------------------------------- */
/* 单元构造                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 章节文本 → 朗读单元(一句一个),带说话人与章节绝对偏移。
 *
 * 三步:断句({@link sentenceSpans})→ 收窄空白({@link trimSpan})→ 归属
 * ({@link attributeSpeakers})。区间全程是原文切片:`text ===
 * text.slice(start, end)` 恒成立,引擎报回来的 charIndex 才能原样映射回正文。
 *
 * `knownNames` 为空时整章都是 narrator,退化成普通断句。
 */
export function buildSpeechUnits(
  text: string,
  knownNames: readonly string[] = [],
  source = 0,
): SpeechUnit[] {
  if (text.trim() === '') return []
  const units: SpeechUnit[] = []
  for (const span of sentenceSpans(text)) {
    const sentence = trimSpan(text.slice(span.start, span.end), span.start)
    if (sentence.text === '') continue
    for (const piece of chunkLongSentence(sentence.text, sentence.start)) {
      units.push({
        text: piece.text,
        source,
        start: piece.start,
        end: piece.end,
        speaker: 'narrator',
      })
    }
  }
  return attributeSpeakers(units, knownNames)
}

/** 角色页签的一行:名字 + 本章单元数(量级参考)。 */
export function speakerRoles(
  units: readonly SpeechUnit[],
): readonly { readonly name: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  for (const unit of units) {
    if (unit.speaker === 'narrator') continue
    counts.set(unit.speaker, (counts.get(unit.speaker) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count }))
}

/* -------------------------------------------------------------------------- */
/* 高亮                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `index` 落在哪个词里 —— 给只报起点不报长度的引擎(Safari 的 boundary 事件)
 * 补长度。没有 Segmenter 时返回 null,调用方自行回退整句。
 */
export function wordAround(text: string, index: number): Span | null {
  if (!Segmenter) return null
  const segmenter = new Segmenter('zh', { granularity: 'word' })
  for (const part of segmenter.segment(text)) {
    if (index >= part.index && index < part.index + part.segment.length) {
      return { start: part.index, end: part.index + part.segment.length }
    }
  }
  return null
}

/** 要洗的字符区间:引擎报了长度就用,否则按词补,再不行至少一个字符。 */
export function wordSpanAt(text: string, charIndex: number, charLength: number): Span {
  const at = Math.min(Math.max(charIndex, 0), Math.max(text.length - 1, 0))
  if (charLength > 0) return { start: at, end: Math.min(at + charLength, text.length) }
  return wordAround(text, at) ?? { start: at, end: Math.min(at + 1, text.length) }
}

/**
 * 当前单元要洗的区间(章节绝对偏移);`null` = 引擎还没报位置,或报的位置
 * 属于别的单元(切句后的迟到事件)。
 *
 * 句级 = 整句;词级 = 引擎最后报的词。词级下先不洗、等第一个词到位 ——
 * 先洗整句再缩成一个词读起来是闪一下而不是高亮。
 */
export function washSpan(
  index: number,
  unit: SpeechUnit,
  boundary: SpeechBoundary | null,
  granularity: 'sentence' | 'word',
): Span | null {
  if (granularity === 'sentence') return { start: unit.start, end: unit.end }
  if (boundary === null || boundary.unit !== index) return null
  const span = wordSpanAt(unit.text, boundary.charIndex, boundary.charLength)
  return { start: unit.start + span.start, end: unit.start + span.end }
}

/**
 * 每个词在单元文本里的位置,来自引擎计时的词表。
 *
 * 从移动游标向前匹配,而不是每次 `indexOf` 从头找:引擎按朗读顺序报词,
 * 一句里重复出现的词必须落到正在读的那个,而不是第一个。
 *
 * 文本里找不到的词直接丢 —— 引擎会规范化数字、展开缩写,报回来的词根本
 * 不在正文里,硬造一个偏移会洗错字符。
 */
export function wordCues(
  text: string,
  words: readonly { readonly at: number; readonly text: string }[],
): WordCue[] {
  const cues: WordCue[] = []
  let cursor = 0
  for (const word of words) {
    if (word.text === '') continue
    const at = text.indexOf(word.text, cursor)
    if (at < 0) continue
    cursor = at + word.text.length
    cues.push({ at: word.at, start: at, end: cursor })
  }
  return cues
}

/* -------------------------------------------------------------------------- */
/* 队列位置                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 朗读进度:已读字符 / 总字符。
 *
 * 注意这是**累加字符空间**(单元文本长度相加),与单元 `start`/`end` 的章节
 * 真实偏移是两个空间 —— 块级元素之间的虚拟换行不属于任何单元。scrubber 与
 * 进度条只用这个自洽的空间;「声音在哪」永远由引擎报的单元下标回答,不要
 * 把章节偏移喂给 {@link unitAtChar} 反推单元(会随换行数漂移)。
 */
export function queuePosition(
  units: readonly { readonly text: string }[],
  index: number | null,
): { spoken: number; total: number } {
  let spoken = 0
  let total = 0
  units.forEach((unit, at) => {
    if (index !== null && at < index) spoken += unit.text.length
    total += unit.text.length
  })
  return { spoken, total }
}

/** 累加字符位置 → 单元下标(scrubber 专用;见 {@link queuePosition})。 */
export function unitAtChar(units: readonly { readonly text: string }[], chars: number): number {
  let acc = 0
  for (let i = 0; i < units.length; i++) {
    acc += units[i]!.text.length
    if (chars < acc) return i
  }
  return Math.max(units.length - 1, 0)
}

/** 上一句/下一句:钳到队列内。 */
export function stepIndex(units: readonly SpeechUnit[], at: number, dir: 1 | -1): number {
  return Math.max(0, Math.min(at + dir, units.length - 1))
}

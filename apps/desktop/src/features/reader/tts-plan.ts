/**
 * TTS 播放计划:把章节文本切成「句」和「合成块」,并给出位置换算。
 *
 * 纯逻辑,不碰 DOM / 音频 / IPC —— 调度本身(预取、重试、token 中断)仍在
 * TtsDrawer 里,因为它和 ref 生命周期绑得太紧。这里只放能单测的部分。
 */

import { buildSpeechSegments } from '@deepread/reader-core'

/** 合成块上限:约 2-4 句。小块首响快(1-3 秒),配合预取无缝衔接。 */
export const MAX_SYNTH_CHARS = 300

/** 中文语速基线:每秒约 4.2 字,用于时间估算。 */
export const CHARS_PER_SECOND = 4.2

export interface Sentence {
  readonly text: string
  /** 全章字符起点。 */
  readonly start: number
}

export interface Block {
  readonly text: string
  readonly start: number
}

/** 句子 -> 带上全章字符起点的条目;`splitSentencesWithOffsets` 的输出即此形状。 */
export function withOffsets(sentences: readonly string[]): Sentence[] {
  let cursor = 0
  return sentences.map((text) => {
    const entry = { text, start: cursor }
    cursor += text.length
    return entry
  })
}

/**
 * 合成块:按句边界攒到 ≤max 字符。块文本是**原文切片**(含句间空白),
 * 于是块内字符推进(`start + ratio * text.length`)与原文一一对应 ——
 * 若块文本只拼接句子、丢掉句间换行,块内每过一个句界就会偏一格。
 */
export function splitChapterBlocks(
  text: string,
  sentences: readonly Sentence[],
  max = MAX_SYNTH_CHARS,
): Block[] {
  const blocks: Block[] = []
  let start = -1
  let end = -1
  for (const sentence of sentences) {
    const sentenceEnd = sentence.start + sentence.text.length
    if (start === -1) {
      start = sentence.start
      end = sentenceEnd
      continue
    }
    if (sentenceEnd - start > max) {
      blocks.push({ text: text.slice(start, end), start })
      start = sentence.start
    }
    end = sentenceEnd
  }
  if (start !== -1) blocks.push({ text: text.slice(start, end), start })
  return blocks
}

/** 一块只属于一个说话人 —— 多角色时不能让两个人的话进同一段音频。 */
export interface SpeakerBlock extends Block {
  readonly speaker: string
}

/** 角色页签的一行:名字 + 本章出现段数(给用户一个"这角色有多少戏份"的量级)。 */
export interface SpeakerRole {
  readonly name: string
  readonly count: number
}

/**
 * 按说话人分块。复用 reader-core 的 `splitDialogue → assignSpeakers` 链
 * (spec §45):引号内的段落归角色,邻近叙述里唯一提到的人名认领它,归属不了的
 * 台词仍归叙述者 —— 不猜、不硬凑。
 *
 * 段文本在原文里按顺序 `indexOf` 定位,块文本因此始终是**原文切片**,块内
 * 字符推进与原文 1:1(与 {@link splitChapterBlocks} 同一约束,正文高亮靠它)。
 * `knownNames` 为空时整章都是 narrator,输出退化成普通分块。
 */
export function buildSpeakerPlan(
  text: string,
  knownNames: readonly string[],
  max = MAX_SYNTH_CHARS,
): { readonly blocks: SpeakerBlock[]; readonly roles: SpeakerRole[] } {
  const blocks: SpeakerBlock[] = []
  const counts = new Map<string, number>()
  let start = -1
  let end = -1
  let speaker: string | null = null
  let cursor = 0
  for (const segment of buildSpeechSegments(text, knownNames)) {
    const at = text.indexOf(segment.text, cursor)
    // 段文本来自原文切片,定位不到只可能是上游改了切分规则 —— 跳过而不是错位。
    if (at === -1) continue
    const nextEnd = at + segment.text.length
    cursor = nextEnd
    counts.set(segment.speaker, (counts.get(segment.speaker) ?? 0) + 1)
    if (speaker === null || segment.speaker !== speaker || nextEnd - start > max) {
      if (speaker !== null && start !== -1) {
        blocks.push({ text: text.slice(start, end), start, speaker })
      }
      start = at
      speaker = segment.speaker
    }
    end = nextEnd
  }
  if (speaker !== null && start !== -1) {
    blocks.push({ text: text.slice(start, end), start, speaker })
  }
  const roles = [...counts]
    .filter(([name]) => name !== 'narrator')
    .map(([name, count]) => ({ name, count }))
  return { blocks, roles }
}

/** 起点块下标:`startChar` 落在哪个块里;越界(章末)返回 -1。 */
export function locateBlock(blocks: readonly Block[], startChar: number): number {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.start + block.text.length > startChar) return i
  }
  return -1
}

/** 句中续播时,块内需要跳过的时长比例;块起始前返回 0。 */
export function blockSeekRatio(block: Block, startChar: number): number {
  if (block.start >= startChar) return 0
  return (startChar - block.start) / block.text.length
}

/** 当前句下标:`charPos` 落在哪句区间。空列表返回 0。 */
export function sentenceIndexAt(sentences: readonly Sentence[], charPos: number): number {
  let index = 0
  for (const sentence of sentences) {
    if (sentence.start > charPos) break
    index += 1
  }
  return Math.max(0, index - 1)
}

export function totalChars(sentences: readonly Sentence[]): number {
  return sentences.reduce((sum, sentence) => sum + sentence.text.length, 0)
}

/** 优先保留与书同语言的语音;同语言不足两条时回退全部。 */
export function voicesForLanguage<T extends { lang: string }>(
  voices: readonly T[],
  language: string | undefined,
): readonly T[] {
  if (!language) return voices
  const prefix = language.slice(0, 2).toLowerCase()
  const matched = voices.filter((voice) =>
    voice.lang.toLowerCase().replace('_', '-').startsWith(prefix),
  )
  return matched.length >= 2 ? matched : voices
}

/** 秒 -> `m:ss`(负值按 0 处理)。 */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 速率循环下一档:未收录的速率回落到第一档。 */
export function nextRate(rates: readonly number[], current: number): number {
  const index = rates.indexOf(current)
  return index === -1 ? (rates[0] ?? 1) : (rates[(index + 1) % rates.length] ?? 1)
}

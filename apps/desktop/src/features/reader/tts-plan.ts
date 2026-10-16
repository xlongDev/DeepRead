/**
 * TTS 播放计划:朗读单元(句)的构造与位置换算。
 *
 * 纯逻辑,不碰 DOM / 音频 / IPC —— 调度本身在 `tts/useTts.ts`(引擎状态机)
 * 与 `tts/clipEngine.ts`(预取/时钟/跟词)里,这里只放能单测的部分。
 *
 * 旧版的「合成块 + 块内比例估算 charPos」已整体删除:块是比例估算时代的
 * 产物(音频只有 `currentTime/duration` 可问),现在引擎直接报词级边界
 * (`SpeechBoundary`),字符位置不再需要猜。单元模型见
 * `@deepread/reader-core` 的 `SpeechUnit` / `buildSpeechUnits`。
 */

import type { SpeechUnit } from '@deepread/reader-core'

/** 中文语速基线:每秒约 4.2 字,用于时间标签的估算。 */
export const CHARS_PER_SECOND = 4.2

/** 歌词页的一行(由单元映射而来,UI 形状不变)。 */
export interface Sentence {
  readonly text: string
  /** 全章字符起点。 */
  readonly start: number
}

/** 单元 → 歌词页行。顺序与下标即朗读队列顺序。 */
export function sentencesOf(units: readonly SpeechUnit[]): Sentence[] {
  return units.map((unit) => ({ text: unit.text, start: unit.start }))
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

/** 归一化:压掉所有连续空白(含换行)。单元文本是正文原样切片,选区文本
 *  来自内核 Range.toString(),两者的空白形态不保证一致。 */
function squish(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * 选区文本 → 它所在的朗读单元下标(从那一句起播)。
 *
 * 只给**没有字符偏移可用**的路径兜底:编辑模式点已有划线,手里只有划线
 * 存下的 excerpt 文本。选区路径走 {@link unitAtOffset}(内核随选区报来
 * 偏移,exact),轮不到这里。
 *
 * 两级匹配,都建立在归一化文本上:
 *   1. 选区盖住整句 —— 第一个被选区包含的单元就是起点(最常见:划了一句,
 *      哪怕一句被切成两个单元,两级都成立,落到第一个);
 *   2. 选区是句子中间一节 —— 从长到短试选区开头。固定 8 字会跨句界
 *      (「遍。她转身」谁也不包含),缩短到落得下为止。
 * 都落空(选区跨章边界、正文被外部改动)时回 0:从章首念起好过不念,
 *  调用方(TtsDrawer)照常起播。
 *
 * ponytail: 纯文本匹配的固有极限 —— 短头(1-2 字)可能误中更早的句子
 * (「了。天」的开头「了。」,上一句句尾也有)。选区路径不走这里(内核
 * 报来字符偏移,见 unitAtOffset),只有 excerpt 路径吃这个风险;要治得
 * 把 excerpt 的偏移也存下来,目前 Excerpt 只有文本。
 */
export function locateSpeechUnit(units: readonly SpeechUnit[], text: string): number {
  const needle = squish(text)
  if (needle === '' || units.length === 0) return 0
  const covered = units.findIndex((unit) => needle.includes(squish(unit.text)))
  if (covered !== -1) return covered
  for (let length = Math.min(needle.length, 8); length >= 1; length -= 1) {
    const head = needle.slice(0, length)
    const partial = units.findIndex((unit) => squish(unit.text).includes(head))
    if (partial !== -1) return partial
  }
  return 0
}

/**
 * 章节绝对偏移 → 单元下标:选区起播的精确落点(内核随选区一起报来偏移,
 * 见 `EngineSelection.start`)。
 *
 * 与 {@link locateSpeechUnit} 互补:偏移是 exact 的,文本匹配只给没有偏移
 * 可用的路径兜底(编辑模式的划线 excerpt)。偏移落在单元之间的块级空白里
 * 时归下一句 —— 选区从段首开始划,要听的是下一段的第一句。
 */
export function unitAtOffset(units: readonly SpeechUnit[], offset: number): number {
  for (let at = 0; at < units.length; at += 1) {
    if (offset < units[at]!.end) return at
  }
  return Math.max(units.length - 1, 0)
}

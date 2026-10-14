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

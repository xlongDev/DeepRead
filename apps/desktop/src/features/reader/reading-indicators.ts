/**
 * 底栏三块指示器(页码 / 字数 / 预计剩余时间)的纯计算。
 *
 * 从 ReaderScreen 抽出来:这里全是分支(整本书字数已知与否、本章还是全书、
 * 中文还是西文排版),放在 2000 行组件里既读不出全貌也测不了。
 */

import { estimateReadingMinutes, formatCharCount, formatDurationLabel } from '@deepread/reader-core'

export interface ReadingIndicatorInput {
  /** 内核报的页码位置;固定排版或内核未报时为空。 */
  readonly location: { readonly current: number; readonly total: number } | undefined
  /** 整本书进度 0..1。 */
  readonly fraction: number
  readonly bookLanguage: string | undefined
  /** 当前章字数;尚未算出为 null。 */
  readonly sectionChars: number | null
  /** 全书正文统计;PDF 等固定排版为 null。 */
  readonly bookCharStats: { readonly total: number; readonly cjk: number } | null
  readonly wordsScope: 'section' | 'book'
}

export interface ReadingIndicators {
  readonly page: string | null
  readonly chars: string | null
  readonly time: string | null
}

/**
 * 时间用全书实测的中西文单位数加权估算(CJK ~400 字/分,西文 ~250 词/分),
 * 对字号/边距/翻页模式不敏感;固定排版(无正文字数)退回按页估算,中文排版
 * 每页默认比西文读得久,所以秒/页取两个值。
 */
export function buildReadingStats(input: ReadingIndicatorInput): ReadingIndicators {
  const { location, fraction, bookLanguage, sectionChars, bookCharStats, wordsScope } = input

  const pages =
    location && location.total > 0 ? { current: location.current, total: location.total } : null
  const isCjk = bookLanguage === undefined || /^(zh|ja|ko)/i.test(bookLanguage)

  let timeLabel: string | null = null
  if (bookCharStats !== null && bookCharStats.total > 0) {
    const remaining = Math.min(1, Math.max(0, 1 - fraction))
    const minutes = estimateReadingMinutes(
      bookCharStats.cjk * remaining,
      (bookCharStats.total - bookCharStats.cjk) * remaining,
    )
    timeLabel = formatDurationLabel(minutes)
  } else if (pages && fraction > 0) {
    const secondsPerPage = isCjk ? 90 : 45
    timeLabel = formatDurationLabel(
      Math.max(1, Math.round(((1 - fraction) * pages.total * secondsPerPage) / 60)),
    )
  }

  const charsLabel =
    wordsScope === 'book'
      ? bookCharStats !== null && bookCharStats.total > 0
        ? `全书 ${formatCharCount(bookCharStats.total)} 字`
        : null
      : sectionChars !== null
        ? `本章 ${sectionChars.toLocaleString('zh-Hans-CN')} 字`
        : null

  return {
    page: pages ? `${pages.current} / ${pages.total} 页` : null,
    chars: charsLabel,
    time: timeLabel,
  }
}

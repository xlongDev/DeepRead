import { describe, expect, it } from 'vitest'
import { applyRepair, repairText, reviewRepair } from './text-repair'

describe('reviewRepair — 硬换行修复', () => {
  it('joins a sentence broken across lines at a comma', () => {
    const review = reviewRepair('他走进房间，\n看见一封信。')
    expect(review.proposals).toHaveLength(1)
    expect(review.proposals[0]?.rule).toBe('hard-break')
    expect(review.proposals[0]?.after).toBe('他走进房间，看见一封信。')
  })

  it('joins multi-line runs without spaces between CJK', () => {
    const review = reviewRepair('雪水滴落\n敲在石板上\n像一封信。')
    expect(review.proposals[0]?.after).toBe('雪水滴落敲在石板上像一封信。')
  })

  it('keeps one space when joining across an ascii boundary', () => {
    const review = reviewRepair('He read the book\nand fell asleep.')
    expect(review.proposals[0]?.after).toBe('He read the book and fell asleep.')
  })

  it('never joins into a chapter marker', () => {
    const review = reviewRepair('前情未完，\n第二章 信')
    expect(review.proposals).toHaveLength(0)
  })

  it('leaves sentences that already end with terminal punctuation', () => {
    const review = reviewRepair('第一句完整。\n第二句也完整。')
    expect(review.proposals).toHaveLength(0)
  })
})

describe('reviewRepair — 空白清理', () => {
  it('collapses doubled spaces and strips trailing whitespace', () => {
    const review = reviewRepair('太多  空格   \n下一行正常')
    expect(review.proposals).toHaveLength(1)
    expect(review.proposals[0]?.rule).toBe('spaces')
    expect(review.proposals[0]?.after).toBe('太多 空格')
  })
})

describe('applyRepair', () => {
  const text = '他走进房间，\n看见一封信。\n太多  空格  '

  it('applies only the accepted proposals', () => {
    const review = reviewRepair(text)
    expect(review.proposals).toHaveLength(2)
    const partially = applyRepair(review.original, [review.proposals[0]!.id])
    expect(partially).toBe('他走进房间，看见一封信。\n太多  空格  ')
  })

  it('applies everything via repairText', () => {
    const result = repairText(text)
    expect(result.text).toBe('他走进房间，看见一封信。\n太多 空格')
  })

  it('is a no-op when nothing is accepted', () => {
    const review = reviewRepair(text)
    expect(applyRepair(review.original, [])).toBe(text)
  })
})

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { alignedAnchorFor } from './engine'

/**
 * 复刻 foliate-js 1.0.1 的两个内核口径(测试即契约,改动需同步这两个函数):
 *
 * 1. 落页(paginator.js #scrollToAnchor 分页分支):
 *      `newPage = Math.round(anchor * (textPages - 1))`,`#scrollToPage(newPage + 1)`
 * 2. 汇报(view.js #onRelocate → progress.js getProgress 的 nextSize):
 *      文本页 p(1 起)汇报 `p / textPages` —— 即「页尾」位置,不是列内比例。
 */
const kernelLandingPage = (anchor: number, pages: number): number =>
  Math.round(anchor * (pages - 3)) + 1
const kernelReport = (page: number, pages: number): number => page / (pages - 2)

describe('alignedAnchorFor', () => {
  it('汇报值原样落回同一文本页(页尾口径的反解)', () => {
    // 回归:联动两栏永远差一页。B 在文本页 2 汇报 0.286,A 同步后落文本页 3
    // 汇报 0.429 —— 因为旧实现把「页尾」汇报值当「页首」比例反解,系统性多算一页。
    // 这里遍历 pages=4..12 的每一页,断言锚点落回来的正是汇报那一页。
    for (let pages = 4; pages <= 12; pages++) {
      const textPages = pages - 2
      for (let page = 1; page <= textPages; page++) {
        const reported = kernelReport(page, pages)
        const anchor = alignedAnchorFor(reported, pages)
        expect(kernelLandingPage(anchor, pages), `pages=${pages} page=${page}`).toBe(page)
      }
    }
  })

  it('落在汇报值最近的那个页尾(刮擦/进度恢复的取整方向)', () => {
    // pages=9 → textPages=7,页尾在 1/7..7/7。0.2 距 0.143 更近 → 文本页 1;
    // 0.25 距 0.286 更近 → 文本页 2。旧实现两例都多翻一页(0.2 落 28.6%)。
    expect(kernelLandingPage(alignedAnchorFor(0.2, 9), 9)).toBe(1)
    expect(kernelLandingPage(alignedAnchorFor(0.25, 9), 9)).toBe(2)
  })

  it('边界值夹在有效页范围内', () => {
    // 0 与负值:没有「第 0 页」可落,夹到第一页。
    expect(alignedAnchorFor(0, 9)).toBe(0)
    expect(alignedAnchorFor(0.01, 9)).toBe(0)
    // 1 与超出:最后一页。
    expect(alignedAnchorFor(1, 9)).toBe(1)
    expect(kernelLandingPage(alignedAnchorFor(1, 9), 9)).toBe(7)
  })

  it('pages 未知或不足两页时原样返回(无可校正空间)', () => {
    expect(alignedAnchorFor(0.3, undefined)).toBe(0.3)
    expect(alignedAnchorFor(0.3, 3)).toBe(0.3)
    expect(alignedAnchorFor(0.3, 2)).toBe(0.3)
  })
})

import { describe, expect, it } from 'vitest'

import {
  anchorFromRect,
  placeCompanionCard,
  placeToolbarX,
  placeToolbarY,
  TOOLBAR_EDGE,
  TOOLBAR_GAP,
  TOOLBAR_MIN_WIDTH,
  TOOLBAR_TYPICAL_HEIGHT,
  TOOLBAR_WIDTH,
  toolbarWidth,
  windowFrame,
  type ReadingFrame,
} from './selection-place'

const FRAME: ReadingFrame = { left: 100, top: 40, right: 1180, bottom: 900 }

describe('划词工具定位', () => {
  it('宽阅读区:面板以选区中心对齐', () => {
    // 1080 宽的阅读区放得下 400,所以直接用全宽。
    expect(toolbarWidth(FRAME)).toBe(TOOLBAR_WIDTH)
    // 选区中心 640,面板 left = 640 - 200。
    expect(placeToolbarX(FRAME, 640, TOOLBAR_WIDTH)).toBe(640 - TOOLBAR_WIDTH / 2)
  })

  it('窄阅读区:宽度收缩,不低于下限', () => {
    const narrow: ReadingFrame = { left: 0, top: 0, right: 360, bottom: 800 }
    // 360 - 24 = 336,还没到 300 的下限。
    expect(toolbarWidth(narrow)).toBe(336)
    const tiny: ReadingFrame = { left: 0, top: 0, right: 200, bottom: 800 }
    expect(toolbarWidth(tiny)).toBe(TOOLBAR_MIN_WIDTH)
  })

  it('贴左/右边缘:面板夹在阅读区内,不挂出去', () => {
    const width = toolbarWidth(FRAME)
    // 选区贴左缝:left 不能低于 112。
    expect(placeToolbarX(FRAME, 105, width)).toBe(FRAME.left + TOOLBAR_EDGE)
    // 选区贴右缝:right 不能超过 1168。
    expect(placeToolbarX(FRAME, 1180, width)).toBe(FRAME.right - TOOLBAR_EDGE - width)
  })

  it('下方放得下:贴着选区底边下一丝缝', () => {
    const anchor = anchorFromRect({ top: 200, left: 500, height: 20 })
    const { top, above, fitsBelow } = placeToolbarY(FRAME, anchor, 96)
    expect(fitsBelow).toBe(true)
    expect(above).toBe(false)
    expect(top).toBe(220 + TOOLBAR_GAP)
  })

  it('下方放不下:翻到选区上方', () => {
    // 选区贴阅读区脚底,面板高 96:下面只剩 11px。
    const anchor = anchorFromRect({ top: 800, left: 500, height: 20 })
    const { top, above, fitsBelow } = placeToolbarY(FRAME, anchor, 96)
    expect(fitsBelow).toBe(false)
    expect(above).toBe(true)
    expect(top).toBe(800 - TOOLBAR_GAP - 96)
  })

  it('上下都放不下:夹在阅读区头尾之间', () => {
    const anchor = anchorFromRect({ top: 30, left: 500, height: 10 })
    // 面板 96,上沿 30-2-96 为负,下沿 40+2+96 = 138 又超过 foot 888 前的位置
    // —— 这里下沿其实放得下,所以测一个真正极端的:面板比阅读区还高。
    const { top } = placeToolbarY(FRAME, anchor, 2000)
    expect(top).toBe(FRAME.top + TOOLBAR_EDGE)
  })

  it('窗口兜底:无阅读区容器时按窗口夹取', () => {
    const frame = windowFrame(800, 600)
    const width = toolbarWidth(frame)
    expect(width).toBe(TOOLBAR_WIDTH)
    expect(placeToolbarX(frame, 790, width)).toBe(800 - TOOLBAR_EDGE - width)
  })
})

describe('协作浮层(翻译卡)避让划词工具', () => {
  const CARD = 300

  it('工具在选区下方:卡片去工具底下,不遮工具', () => {
    const anchor = anchorFromRect({ top: 200, left: 500, height: 20 })
    const { top } = placeCompanionCard(FRAME, anchor, CARD)
    expect(top).toBe(220 + TOOLBAR_GAP + TOOLBAR_TYPICAL_HEIGHT + 8)
  })

  it('工具翻到选区上方:卡片贴选区下沿', () => {
    // 选区贴脚底,工具放不下只能翻上去;小卡片(60px)还贴得下选区下沿。
    const anchor = anchorFromRect({ top: 800, left: 500, height: 20 })
    const { top } = placeCompanionCard(FRAME, anchor, 60)
    expect(top).toBe(820 + 8)
  })

  it('下沿也放不下:退到工具更上方,不与工具相折', () => {
    // 同上,但卡片 300px 在 828 处放不下(888 是底):
    // 应退到工具(702..798)上方。
    const anchor = anchorFromRect({ top: 800, left: 500, height: 20 })
    const { top } = placeCompanionCard(FRAME, anchor, CARD)
    expect(top).toBe(800 - TOOLBAR_GAP - TOOLBAR_TYPICAL_HEIGHT - 8 - CARD)
  })

  it('卡片比剩余空间还高:夹在阅读区头尾之间', () => {
    const anchor = anchorFromRect({ top: 200, left: 500, height: 20 })
    const { top } = placeCompanionCard(FRAME, anchor, 5000)
    expect(top).toBe(FRAME.top + TOOLBAR_EDGE)
  })
})

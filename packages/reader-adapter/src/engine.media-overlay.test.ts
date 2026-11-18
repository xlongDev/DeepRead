// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { ensureMediaOverlayActiveStyle } from './engine'

describe('原书配音激活态兜底样式', () => {
  it('注入书声明的 activeClass 规则,幂等不重复', () => {
    const doc = document.implementation.createHTMLDocument()
    ensureMediaOverlayActiveStyle(doc, '-epub-media-overlay-active')
    const style = doc.getElementById('media-overlay-active-style')
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('.-epub-media-overlay-active')
    // 第二次注入(同文档重复 load)不加第二份。
    ensureMediaOverlayActiveStyle(doc, '-epub-media-overlay-active')
    expect(doc.querySelectorAll('#media-overlay-active-style')).toHaveLength(1)
  })

  it('类名带特殊字符也安全(CSS.escape)', () => {
    const doc = document.implementation.createHTMLDocument()
    expect(() => ensureMediaOverlayActiveStyle(doc, 'mo:active')).not.toThrow()
    expect(doc.getElementById('media-overlay-active-style')?.textContent).toContain('.mo\\:active')
  })

  it('书没声明类名就什么都不注', () => {
    const doc = document.implementation.createHTMLDocument()
    ensureMediaOverlayActiveStyle(doc, '')
    expect(doc.getElementById('media-overlay-active-style')).toBeNull()
  })
})

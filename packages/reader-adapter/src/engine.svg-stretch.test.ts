// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fixSvgStretch } from './engine'

describe('封面 SVG 防压扁', () => {
  it('calibre 封面页:viewBox + preserveAspectRatio="none" → meet', () => {
    document.body.innerHTML =
      '<svg viewBox="0 0 1080 1532" preserveAspectRatio="none" width="100%" height="100%"></svg>'
    expect(fixSvgStretch(document)).toBe(1)
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    expect(svg.getAttribute('viewBox')).toBe('0 0 1080 1532')
  })

  it('已经是 meet / 无 preserveAspectRatio / 无 viewBox 的不动', () => {
    document.body.innerHTML =
      '<svg viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet"></svg>' +
      '<svg viewBox="0 0 2 2"></svg>' +
      '<svg preserveAspectRatio="none"></svg>'
    expect(fixSvgStretch(document)).toBe(0)
  })

  it('重复调用幂等', () => {
    document.body.innerHTML = '<svg viewBox="0 0 3 3" preserveAspectRatio="none"></svg>'
    expect(fixSvgStretch(document)).toBe(1)
    expect(fixSvgStretch(document)).toBe(0)
  })
})

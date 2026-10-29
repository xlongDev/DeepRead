// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { registerTtsCustomHighlight, unregisterTtsCustomHighlight } from './engine'

/**
 * 页文档的真实形态是 iframe 文档(有 defaultView);jsdom 没有 Custom
 * Highlight API,在 iframe 的 window 上装结构兼容的桩 —— 验的就是真实代码
 * 路径(doc.defaultView.CSS.highlights / doc.defaultView.Highlight)。
 */
const makePageDoc = (): { doc: Document; registry: Map<string, unknown> } => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const doc = frame.contentDocument!
  doc.body.innerHTML = '<p>正文</p>'
  const registry = new Map<string, unknown>()
  ;(doc.defaultView!.CSS as { highlights?: Map<string, unknown> }).highlights = registry
  class FakeHighlight {
    readonly ranges: readonly Range[]
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }
  ;(doc.defaultView as unknown as { Highlight?: unknown }).Highlight = FakeHighlight
  return { doc, registry }
}

describe('fixed-layout 页文档的 TTS 洗色走 Custom Highlight API', () => {
  let doc: Document
  let registry: Map<string, unknown>

  beforeEach(() => {
    ;({ doc, registry } = makePageDoc())
  })

  it('注册 Range + 注入 ::highlight 规则(透明度对齐内核 overlayer 的 .3)', () => {
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    expect(registerTtsCustomHighlight(doc, range, '#f5d76e')).toBe(true)
    expect(registry.get('deepread-tts')).toBeDefined()
    const style = doc.getElementById('tts-custom-highlight-style')
    expect(style?.textContent).toContain('::highlight(deepread-tts)')
    expect(style?.textContent).toContain('color-mix(in srgb, #f5d76e 30%, transparent)')
  })

  it('重复洗色只换条目,不叠样式', () => {
    const r1 = doc.createRange()
    r1.selectNodeContents(doc.body)
    registerTtsCustomHighlight(doc, r1, '#f5d76e')
    const r2 = doc.createRange()
    r2.selectNodeContents(doc.body)
    registerTtsCustomHighlight(doc, r2, '#7dd3fc')
    expect(registry.size).toBe(1)
    expect(doc.querySelectorAll('#tts-custom-highlight-style')).toHaveLength(1)
  })

  it('清除摘注册(样式壳留着,幂等且无害)', () => {
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    registerTtsCustomHighlight(doc, range, '#f5d76e')
    unregisterTtsCustomHighlight(doc)
    expect(registry.has('deepread-tts')).toBe(false)
  })

  it('能力缺失(无 Highlight 构造器)返回 false,不炸', () => {
    delete (doc.defaultView as unknown as { Highlight?: unknown }).Highlight
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    expect(registerTtsCustomHighlight(doc, range, '#f5d76e')).toBe(false)
  })
})

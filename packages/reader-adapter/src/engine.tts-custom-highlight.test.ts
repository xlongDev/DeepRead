// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  drawSearchCustomHighlights,
  registerTtsCustomHighlight,
  unregisterTtsCustomHighlight,
} from './engine'

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
    const style = doc.getElementById('custom-highlight-style-deepread-tts')
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
    expect(doc.querySelectorAll('#custom-highlight-style-deepread-tts')).toHaveLength(1)
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

describe('fixed-layout 的搜索命中高亮(match 文本自验证页归属)', () => {
  let doc: Document
  let registry: Map<string, unknown>

  beforeEach(() => {
    ;({ doc, registry } = makePageDoc())
  })

  /** 本页 <p>正文的 Range;match 必须与 Range 文本一致才画。 */
  const hitOn = (match: string) => ({
    anchor: (d: Document): Range => {
      const range = d.createRange()
      range.selectNodeContents(d.body.querySelector('p')!)
      return range
    },
    match,
  })

  it('match 与 Range 文本一致的画,聚合多个命中', () => {
    const hit = hitOn('正文')
    expect(drawSearchCustomHighlights(doc, [hit, hit])).toBe(true)
    const drawn = registry.get('deepread-search') as { ranges: readonly Range[] }
    expect(drawn.ranges).toHaveLength(2)
    expect(registry.get('deepread-tts')).toBeUndefined()
    expect(doc.getElementById('custom-highlight-style-deepread-search')?.textContent).toContain(
      'rgba(61, 109, 235, 0.28)',
    )
  })

  it('match 对不上(错页侥幸解出的 Range)不画并摘旧注册', () => {
    const hit = hitOn('正文')
    drawSearchCustomHighlights(doc, [hit])
    expect(drawSearchCustomHighlights(doc, [hitOn('别页的文字')])).toBe(false)
    expect(registry.has('deepread-search')).toBe(false)
  })

  it('坏锚点跳过,其余照画;全部无效则不注册', () => {
    const bad = {
      anchor: () => {
        throw new Error('stale cfi')
      },
      match: '正文',
    }
    expect(drawSearchCustomHighlights(doc, [bad, hitOn('正文')])).toBe(true)
    expect((registry.get('deepread-search') as { ranges: readonly Range[] }).ranges).toHaveLength(1)
    expect(drawSearchCustomHighlights(doc, [bad])).toBe(false)
    expect(registry.has('deepread-search')).toBe(false)
  })

  it('没有 match 的命中跳过(拿不到验证文本就宁可不画)', () => {
    const hit = { anchor: hitOn('正文').anchor }
    expect(drawSearchCustomHighlights(doc, [hit])).toBe(false)
    expect(registry.has('deepread-search')).toBe(false)
  })
})

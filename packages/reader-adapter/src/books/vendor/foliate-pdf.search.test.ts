// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { appendPdfTextItems } from './foliate-pdf.js'

/** 造一个与真实页文档同构的骨架:body > #canvas + .textLayer + .annotationLayer。 */
const makeLayer = (): { doc: Document; layer: Element } => {
  const doc = document.implementation.createHTMLDocument('')
  const body = doc.body
  body.append(doc.createElement('div'), doc.createElement('div'))
  const layer = body.children[1]!
  layer.className = 'textLayer'
  return { doc, layer }
}

describe('PDF 搜索伪文档必须逐元素镜像 TextLayer 的真实结构', () => {
  // CFI.fromRange(伪文档) 之后要经 CFI.toRange 解析回真实渲染的页文档 ——
  // span/br 的数量与顺序错一个,命中高亮与锚点就整体错位。
  it('文本项逐个成 span,hasEOL 追加 br,顺序保持', () => {
    const { doc, layer } = makeLayer()
    appendPdfTextItems(layer, doc, [
      { str: '第一行', hasEOL: true },
      { str: '第二行', hasEOL: false },
    ])
    expect(layer.children.length).toBe(3)
    const [span1, br, span2] = Array.from(layer.children)
    expect(span1!.tagName).toBe('SPAN')
    expect(span1!.textContent).toBe('第一行')
    expect(span1!.getAttribute('role')).toBe('presentation')
    expect(br!.tagName).toBe('BR')
    expect(span2!.textContent).toBe('第二行')
  })

  it('空串项不成 span(hasText = str !== \'\'),但其 hasEOL 的 br 要在', () => {
    // pdf.js #appendText:span 只在 str 非空时 append,br 只看 hasEOL。
    const { doc, layer } = makeLayer()
    appendPdfTextItems(layer, doc, [
      { str: '前文', hasEOL: false },
      { str: '', hasEOL: true },
    ])
    expect(layer.children.length).toBe(2)
    expect(layer.children[0]!.tagName).toBe('SPAN')
    expect(layer.children[1]!.tagName).toBe('BR')
  })

  it('marked content 项跳过(streamTextContent 默认不含,防御性)', () => {
    const { doc, layer } = makeLayer()
    appendPdfTextItems(layer, doc, [
      { type: 'beginMarkedContentProps', id: 'p1', tag: 'P' },
      { str: '正文', hasEOL: true },
      { type: 'endMarkedContent' },
    ] as never)
    expect(layer.children.length).toBe(2)
    expect(layer.children[0]!.textContent).toBe('正文')
  })

  it('超过 pdf.js MAX_TEXT_DIVS_TO_RENDER(100000)即截断,与真渲染一致', () => {
    // 真渲染在处理第 N 项前检查 textDivs.length(N-1)> 100000 才停,即最多
    // 处理 100001 项;伪文档多出尾部文本会让密排页的 CFI 错位,镜像同一上限。
    const { doc, layer } = makeLayer()
    const items = Array.from({ length: 100_002 }, () => ({ str: 'x', hasEOL: false }))
    appendPdfTextItems(layer, doc, items)
    expect(layer.children.length).toBe(100_001)
  })
})

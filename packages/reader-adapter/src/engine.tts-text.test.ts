// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { findRangeByCharOffset, walkSectionText } from './engine'

/** 造一个 section body(用 div 承载,语义等价于 doc.body)。 */
function bodyOf(html: string): Element {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

describe('walkSectionText', () => {
  it('在块级元素之间插入换行 —— 标题不与正文粘连', () => {
    // 回归:doc.body.textContent 会把 <h1> 和 <p> 直接拼成一句,
    // TTS 于是连着念标题+正文,句级高亮糊成一整段。
    const body = bodyOf('<h1>第三章 元认知</h1><p>1946年10月24日，一群科学家。</p>')
    const { text } = walkSectionText(body)
    expect(text).toBe('第三章 元认知\n1946年10月24日，一群科学家。\n')
  })

  it('行内元素不产生换行', () => {
    const body = bodyOf('<p>他<em>很</em>高兴。</p>')
    expect(walkSectionText(body).text).toBe('他很高兴。\n')
  })

  it('嵌套块级元素各自断开', () => {
    const body = bodyOf('<div><p>甲。</p><p>乙。</p></div>')
    expect(walkSectionText(body).text).toBe('甲。\n乙。\n\n')
  })

  it('跳过 script 与 style', () => {
    const body = bodyOf('<style>p{color:red}</style><script>x()</script><p>正文。</p>')
    expect(walkSectionText(body).text).toBe('正文。\n')
  })

  it('列表项各自成行', () => {
    const body = bodyOf('<ul><li>甲。</li><li>乙。</li></ul>')
    expect(walkSectionText(body).text).toBe('甲。\n乙。\n\n')
  })
})

describe('findRangeByCharOffset', () => {
  it('offset 与 walkSectionText 的文本一一对应(跨块也对)', () => {
    const body = bodyOf('<h1>标题</h1><p>正文第一句。正文第二句。</p>')
    const { text } = walkSectionText(body)
    const target = '正文第二句。'
    const start = text.indexOf(target)
    expect(start).toBeGreaterThan(-1)
    const range = findRangeByCharOffset(body, start, start + target.length)
    expect(range).not.toBeNull()
    expect(range!.toString()).toBe(target)
  })

  it('区间落在单个块内也精确', () => {
    const body = bodyOf('<p>甲乙丙丁。</p>')
    const range = findRangeByCharOffset(body, 1, 3)
    expect(range!.toString()).toBe('乙丙')
  })

  it('越界或空区间返回 null', () => {
    const body = bodyOf('<p>短。</p>')
    expect(findRangeByCharOffset(body, 999, 1000)).toBeNull()
    expect(findRangeByCharOffset(body, 2, 2)).toBeNull()
  })

  it('offset 全部来自同一文本模型 —— 整段往返不丢字', () => {
    const body = bodyOf('<h2>第一节</h2><p>第一句。第二句。</p><blockquote>引用。</blockquote>')
    const { text } = walkSectionText(body)
    const trimmed = text.replace(/\n+$/, '')
    const range = findRangeByCharOffset(body, 0, trimmed.length)
    expect(range).not.toBeNull()
    // Range 的 toString 会把块间的虚拟换行还原成 ''(DOM 里没有这个字符),
    // 所以比较去掉换行后的文本。
    expect(range!.toString().replace(/\n/g, '')).toBe(trimmed.replace(/\n/g, ''))
  })
})

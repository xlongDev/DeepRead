// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ZhConvertVariant } from '@deepread/reader-core'
import { convertSectionDocument } from './zh-convert'

// 与 reader-core 的 ZhConvertVariant 联合类型互为穷尽断言:档位表漏了
// 联合类型里的成员,或联合类型加了新成员没同步这里,都会在此编译报错。
const ALL_VARIANTS = [
  'none',
  's2t',
  't2s',
  's2tw',
  's2hk',
  's2twp',
  'tw2s',
  'hk2s',
  'tw2sp',
] as const satisfies readonly ZhConvertVariant[]
type Exhaustive =
  Exclude<ZhConvertVariant, (typeof ALL_VARIANTS)[number]> extends never ? true : false
const exhaustive: Exhaustive = true

describe('convertSectionDocument', () => {
  const convert = (text: string): string => text.replaceAll('简', '簡').replaceAll('体', '體')

  it('转换正文文本节点', () => {
    const doc = new DOMParser().parseFromString('<p>简体正文</p>', 'text/html')
    convertSectionDocument(doc, convert)
    expect(doc.body.textContent).toBe('簡體正文')
  })

  it('跳过 script 与 style 内的文本', () => {
    const doc = new DOMParser().parseFromString(
      '<style>p::before{content:"简"}</style><p>简</p><script>const 简 = 1</script>',
      'text/html',
    )
    convertSectionDocument(doc, convert)
    expect(doc.querySelector('style')?.textContent).toBe('p::before{content:"简"}')
    expect(doc.querySelector('script')?.textContent).toBe('const 简 = 1')
    expect(doc.querySelector('p')?.textContent).toBe('簡')
  })

  it('空白文本节点不动,元素结构保持原样', () => {
    const doc = new DOMParser().parseFromString('<div><p>简</p> <em>简</em></div>', 'text/html')
    convertSectionDocument(doc, convert)
    expect(doc.querySelector('em')?.textContent).toBe('簡')
    expect(doc.querySelectorAll('p, em').length).toBe(2)
  })

  it('空文档不抛错', () => {
    const doc = new DOMParser().parseFromString('<html><head></head></html>', 'text/html')
    expect(() => convertSectionDocument(doc, convert)).not.toThrow()
  })

  it('穷尽断言自身为真(防止断言被改坏后静默失效)', () => {
    expect(exhaustive).toBe(true)
    expect(ALL_VARIANTS).toHaveLength(9)
  })
})

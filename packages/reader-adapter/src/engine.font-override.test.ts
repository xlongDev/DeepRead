// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildReaderCSS } from './engine'

const theme = { name: 't', background: '#fff', foreground: '#111', colorScheme: 'light' } as const

describe('读者选的字体要盖住书自己的 CSS', () => {
  // 病根:calibre 导出的中文书把 font-family 写在后代上(每段 <span class="calibreN">),
  // 只写 `body { … !important }` 会被继承规则甩掉 —— 字体改了等于没改。
  it('压到 body * 上,不只是 body', () => {
    const css = buildReaderCSS(theme, { fontFamily: 'kaiti' }, 'paginated')
    expect(css).toContain('body, body * { font-family: "Kaiti SC"')
    expect(css).not.toContain('body { font-family:')
  })

  it('代码类元素保持等宽', () => {
    const css = buildReaderCSS(theme, { fontFamily: 'kaiti' }, 'paginated')
    expect(css).toContain('code, pre, kbd, samp')
    expect(css).toContain('ui-monospace')
  })

  it('选「原书」不下发任何 font-family', () => {
    const css = buildReaderCSS(theme, {}, 'paginated')
    expect(css).not.toContain('font-family')
  })
})

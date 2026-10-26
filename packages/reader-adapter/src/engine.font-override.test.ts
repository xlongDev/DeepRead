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

describe('行高也要盖住书后代类上的声明', () => {
  // 行高是纯继承属性,书若把 line-height 写在后代类上(calibre 标题类常见),
  // 只压 body 会被继承规则甩掉。压到 body * 上,读者调行距全局统一生效。
  it('压到 body * 上,不只是 body', () => {
    const css = buildReaderCSS(theme, { lineHeight: 1.8 }, 'paginated')
    expect(css).toContain('body, body * { line-height: 1.8 !important; }')
    expect(css).not.toContain('body { line-height:')
  })

  it('未调行距时不下发 line-height(保留原书排版)', () => {
    const css = buildReaderCSS(theme, {}, 'paginated')
    expect(css).not.toContain('line-height')
  })
})

describe('夜间模式盖住书自己的配色', () => {
  // 病根:书的 CSS 把 color 打在**后代**上(calibre 导出的书几乎每个标题/正文
  // 都套 `<span class="calibreN">`,类里写死 `color: rgb(0,0,0)`),后代声明
  // 永远赢过从 body 继承下来的墨色 —— 黑字留在黑纸上,等于隐形(实测 1.12:1)。
  const night = {
    name: 'Night',
    background: '#131210',
    foreground: '#b8b2a7',
    colorScheme: 'dark',
  } as const

  it('墨色压到 body *,不只是 body', () => {
    const css = buildReaderCSS(night, {}, 'paginated')
    expect(css).toContain('body * { color: #b8b2a7 !important;')
  })

  it('书自己的底色也掀掉(浅底块会吃掉换过的墨色)', () => {
    const css = buildReaderCSS(night, {}, 'paginated')
    expect(css).toContain('background-color: transparent !important; }')
  })

  it('浅色纸不动书的颜色 —— 那是为白纸画的', () => {
    const css = buildReaderCSS(theme, {}, 'paginated')
    expect(css).not.toContain('body * { color:')
    expect(css).not.toContain('background-color: transparent')
  })
})

describe('字重盖住行内 span 但保留标题层级', () => {
  // 字重要盖住 calibre 的 <span class="calibreN"> 行内载体(只列块级会漏),
  // 但 h1–h6 用 :not() 排除,书的标题 font-weight 原样保留。
  it('压到 body 与非标题后代', () => {
    const css = buildReaderCSS(theme, { fontWeight: 700 }, 'paginated')
    expect(css).toContain(
      'body, body *:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6) { font-weight: 700 !important; }',
    )
  })

  it('不碰标题:选择器显式排除 h1–h6', () => {
    const css = buildReaderCSS(theme, { fontWeight: 700 }, 'paginated')
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(css).toContain(`:not(${h})`)
    }
  })

  it('未调字重时不下发 font-weight(保留原书层级)', () => {
    const css = buildReaderCSS(theme, {}, 'paginated')
    expect(css).not.toContain('font-weight')
  })
})

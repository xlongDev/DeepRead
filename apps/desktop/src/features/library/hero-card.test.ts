import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom 下 import.meta.url 不是 file: scheme;vitest 的 cwd 就是 apps/desktop。
const overlaysSource = readFileSync(
  resolve(process.cwd(), 'src/styles/sections/03-library-overlays.css'),
  'utf8',
)

const heroRule = /\.continue-reading\s*\{([^}]*)\}/.exec(overlaysSource)?.[1] ?? ''

describe('首屏焦点卡(继续阅读)', () => {
  it('掠光裁剪不许把卡片变成可压缩的 flex 项', () => {
    // overflow:hidden 会把 flex 项的 min-height:auto 解成 0;.library-main 是
    // flex 列,书一多、内容超出视口,负空间全摊到这张卡上 —— 206px 压成 42px,
    // 书名整行裁没(11-10 截图)。这两条必须成对存在。
    expect(heroRule).toContain('overflow: hidden')
    expect(heroRule, '焦点卡缺 flex:none,会被 .library-main 压扁').toMatch(/flex:\s*none/)
  })

  it('掠光复用书卡的 keyframes,不另起一套', () => {
    expect(overlaysSource).toContain('animation: cover-sheen')
  })

  it('CTA 图标的悬停是「掀起一角」,不是箭头式的右移', () => {
    // 右移 2px 是箭头的语言;这枚图标是本书。16px 下靠角度而不是透视,所以
    // 是 2D 倾斜 + 微放大,悬停只播一次。
    expect(overlaysSource).toContain('animation: continue-book-open')
    expect(overlaysSource).toMatch(/@keyframes continue-book-open/)
    expect(overlaysSource).not.toMatch(
      /\.continue-reading:hover \.continue-reading-go svg \{[^}]*translate:\s*2px/,
    )
  })
})

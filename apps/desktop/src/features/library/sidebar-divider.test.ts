import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// vitest 的 cwd 就是 apps/desktop;jsdom 下 import.meta.url 不是 file: scheme。
/** 注释里出现选择器名是常事(解释为什么不再用某条规则),断言只看真声明。 */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const overlays = strip(
  readFileSync(resolve(process.cwd(), 'src/styles/sections/03-library-overlays.css'), 'utf8'),
)
const library = strip(
  readFileSync(resolve(process.cwd(), 'src/styles/sections/02-library.css'), 'utf8'),
)

const sidebarRule = /\.lib-sidebar\s*\{([^}]*)\}/.exec(overlays)?.[1] ?? ''
const washRule = /\.library:not\(\.is-sidebar-hidden\)\s+\.lib-sidebar\s*\{([^}]*)\}/.exec(
  overlays,
)?.[1]

describe('侧栏与书架的分界', () => {
  it('不画线:没有 border,竖线也不许回来', () => {
    // 整高的 border 从窗口最顶上开始,穿过交通灯那一行,在无边框窗口里读成
    // 一条多出来的窗口分割线;收进 rail 之后更像一条拖不动的分栏边。
    expect(sidebarRule).not.toContain('border-right')
    expect(sidebarRule).toContain('background-color: transparent')
  })

  it('用一层向右淡出的浅色代替线,且不留平台段', () => {
    expect(library).toMatch(/--sidebar-wash:/)
    expect(washRule, '展开态缺浅色带').toContain('background-image')
    // 平台段 + 线性淡出会在交界处压出一条折痕(马赫带),看起来仍像一条
    // 看不见的线;所以只能是一个 wash 到一个 transparent 的连续渐变。
    expect(washRule).toContain('linear-gradient(90deg, var(--sidebar-wash), transparent)')
  })

  it('底部那根横线也去掉', () => {
    // 云同步 / 设置本来就是底部的两个动作,横线把它们切成第三块区域,
    // 还把上面的目标卡框成一个盒子。
    const foot = /\.lib-sidebar-foot\s*\{([^}]*)\}/.exec(overlays)?.[1] ?? ''
    expect(foot).not.toContain('border-top')
  })

  it('rail 不参与浅色带', () => {
    // 64px 图标列不是面板;浅色带只挂在展开态。
    expect(washRule).toBeTruthy()
    expect(overlays).not.toMatch(/\.lib-sidebar\.is-rail\s*\{[^}]*background-image/)
  })
})

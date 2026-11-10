import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom 环境下 import.meta.url 不是 file: scheme,readFileSync(new URL(...))
// 会被宿主的文件代理拒绝;vitest 的 cwd 就是 apps/desktop。
const hookSource = readFileSync(
  resolve(process.cwd(), 'src/features/library/glass/useGlassRefraction.ts'),
  'utf8',
)
const vendorSource = readFileSync(
  resolve(process.cwd(), 'src/features/library/glass/refract.js'),
  'utf8',
)
const dialogsSource = readFileSync(
  resolve(process.cwd(), 'src/styles/sections/08-dialogs.css'),
  'utf8',
)
const settingsSource = readFileSync(
  resolve(process.cwd(), 'src/styles/sections/11-reader-menus-settings.css'),
  'utf8',
)
const keysSource = readFileSync(
  resolve(process.cwd(), 'src/features/settings/KeybindingsSettings.tsx'),
  'utf8',
)
const librarySource = readFileSync(
  resolve(process.cwd(), 'src/features/library/LibraryScreen.tsx'),
  'utf8',
)
const notesSource = readFileSync(resolve(process.cwd(), 'src/styles/sections/04-notes.css'), 'utf8')
const cssSource = readFileSync(
  resolve(process.cwd(), 'src/styles/sections/13-glass-wallpaper.css'),
  'utf8',
)

describe('wallpaper glass surface list', () => {
  it('keeps the refraction selectors and the CSS selectors in sync', () => {
    const selector = /GLASS_SURFACE_SELECTOR\s*=\s*'([^']+)'/.exec(hookSource)?.[1] ?? ''
    const classes = selector
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('.'))
    expect(classes.length).toBe(3)
    for (const name of classes) {
      expect(cssSource, `CSS is missing glass surface ${name}`).toContain(name)
    }
  })

  it('never glasses the layout-only sidebar bottom container', () => {
    // .lib-sidebar-bottom 是 margin-top:auto 的布局容器,窄屏 display:contents。
    // 给它加背景/阴影会套出直角框并把目标卡与 foot 叠成双层边(09-08 截图)。
    const bigSurfaceRule = /:is\(([^)]*\.lib-sidebar[^)]*)\)/.exec(cssSource)?.[1] ?? ''
    expect(bigSurfaceRule).toContain('.lib-sidebar-goal')
    expect(bigSurfaceRule).not.toContain('.lib-sidebar,')
    expect(bigSurfaceRule).not.toContain('.lib-sidebar-bottom')
  })

  it('glasses the toolbar pills without swallowing their active state', () => {
    expect(cssSource).toContain('.shelf-view-toggle')
    expect(cssSource).toContain('.shelf-sort-dir')
    expect(cssSource).toContain('.shelf-manage:not(.is-active)')
    expect(cssSource).toContain('.shelf-tools .dropdown-trigger')
    expect(cssSource).toContain('.settings-tabs button:not(.is-active)')
    // 主 CTA 改成 accent 染色玻璃后仍在清单里,只是配色另走一条规则。
    expect(cssSource).toContain('.shelf-import')
    expect(cssSource).toContain('.continue-reading-go')
  })

  it('gives every floating panel a readable glass, denser than the cards', () => {
    for (const name of ['.modal-panel', '.dropdown-menu', '.action-menu', '.sync-drawer']) {
      expect(cssSource, `${name} must share the dropdown glass`).toContain(name)
    }
    const panelRule = /:is\(\.modal-panel,[\s\S]*?\)\s*\{([^}]*)\}/.exec(cssSource)?.[1] ?? ''
    // 浮层带正文:清透档(30%)让设置说明直接坐在渐变上,实测不到 3:1。
    // 76% 是「透得出色相」和「墨字仍有 13:1」之间的那一档;面板再单独加
    // 一道去彩重模糊,免得背后的青绿直接掺成灰绿。
    expect(panelRule).toContain('color-mix(in srgb, var(--color-surface) 76%, transparent)')
    expect(panelRule).toContain('var(--glass-wallpaper-edge)')
    // 常驻卡 / 按钮用更薄的一档 —— 它们大多不承载长正文。
    expect(cssSource).toContain('var(--glass-wallpaper-bg)')
  })

  it('glasses settings tabs without a grey container bar', () => {
    const tabsRule = /\.settings-tabs \{([^}]*)\}/.exec(cssSource)?.[1] ?? ''
    expect(tabsRule).toContain('background: transparent')
    expect(cssSource).toContain('.settings-tabs button:not(.is-active),')
  })

  it('uses the neutral sidebar hover for command bar items', () => {
    expect(dialogsSource).toContain('.command-item:hover')
    expect(dialogsSource).toContain('color-mix(in srgb, var(--color-text-primary) 7%, transparent)')
    expect(dialogsSource).not.toContain(
      'background: var(--color-accent);\n  color: var(--color-on-accent)',
    )
  })

  it('keeps the restore-default button round and above the fade', () => {
    expect(keysSource).toContain('className="btn"')
    expect(settingsSource).toContain('.keybinding-hint + .modal-actions')
  })

  it('glasses the notes back-to-book button', () => {
    expect(cssSource).toContain('.note-open-book')
  })

  it('keeps the sort trigger glassy while its menu is open', () => {
    expect(cssSource).toContain('.shelf-tools .dropdown-trigger.is-open')
    expect(cssSource).not.toContain('.dropdown-trigger:not(.is-open)')
  })

  it('only lets WebGL own the three stable cards', () => {
    expect(cssSource).toContain("html[data-glass='webgl']")
    const webglRule = /html\[data-glass='webgl'\][^{]*\{/.exec(cssSource)?.[0] ?? ''
    for (const dynamic of ['.modal-panel', '.action-menu', '.dropdown-menu', '.modal-overlay']) {
      expect(webglRule, `${dynamic} must keep native backdrop blur`).not.toContain(dynamic)
    }
  })

  it('glasses stats and note cards without backdrop sampling', () => {
    const rule =
      /html\[data-background\][^{]*:is\(\.stats-overview, \.note-card\)\s*\{([^}]*)\}/.exec(
        cssSource,
      )?.[1] ?? ''
    expect(rule).toContain('var(--glass-wallpaper-bg)')
    expect(rule).toContain('var(--glass-wallpaper-edge)')
    // 背后是平滑渐变:模糊没有信息量,却会在深色世界采样失败、把卡片刷白。
    expect(rule).not.toContain('backdrop-filter')
    // 设置面板里的分组卡是面板内的第二层玻璃(88% + sheen + rim):
    // 和面板同档会叠成一块实白,做实底又退回一张纸。
    expect(cssSource).toContain('.settings-group')
    // 主题预览卡要展示真实纸色,同样不能被玻璃盖掉。
    expect(cssSource).not.toContain('.theme-swatch,')
    const webglRule = /html\[data-glass='webgl'\][^{]*\{/.exec(cssSource)?.[0] ?? ''
    expect(webglRule).not.toContain('.stats-overview')
  })

  it('rounds the command bar input and Esc chip permanently', () => {
    const input = /\.command-input \{([^}]*)\}/.exec(dialogsSource)?.[1] ?? ''
    const esc = /\.command-esc \{([^}]*)\}/.exec(dialogsSource)?.[1] ?? ''
    expect(input).toContain('border-radius: var(--radius-full)')
    expect(esc).toContain('border-radius: var(--radius-full)')
    expect(input).toContain('background: var(--surface-sunk)')
  })

  it('pins the refraction canvas to the viewport size', () => {
    // canvas 是 replaced element:只写 inset:0 会用固有尺寸,draw() 再拿
    // clientWidth 反算位图 → 逐帧指数膨胀(dpr=2 实测 4800×2400),
    // 壁纸纹理被映射错,在视口里切出一条硬色带。
    const canvasRule = /\.glass-refraction \{([^}]*)\}/.exec(cssSource)?.[1] ?? ''
    expect(canvasRule).toContain('width: 100%')
    expect(canvasRule).toContain('height: 100%')
  })

  it('keeps the refraction tone neutral on flat wallpapers', () => {
    // 玻璃框内是 shader 画的壁纸、框外是 CSS 原图;调色只会造成色差硬边。
    expect(hookSource).toContain('const tone = { saturate: 1, contrast: 1, brightness: 1 }')
  })

  it('glasses stats buttons without swallowing state colours', () => {
    for (const name of [
      '.stats-page .btn:not(:disabled)',
      '.goal-chip:not(.is-active)',
      '.goal-week-dot:not(.is-read)',
    ]) {
      expect(cssSource, `CSS is missing wallpaper glass for ${name}`).toContain(name)
    }
    expect(cssSource).not.toContain('.stats-page .btn {')
  })

  it('avoids the white-to-gradient flash on view switches', () => {
    // root 快照 cross-fade 会让旧页文字透过新页玻璃;壁纸须在 paint 前落地。
    expect(librarySource).toContain('wallpapered')
    expect(librarySource).toContain("root.dataset.background !== 'none'")
    expect(librarySource).toContain('useLayoutEffect')
  })

  it('keeps page entrance motion but drops the opacity that breaks backdrop-filter', () => {
    // 祖先 opacity < 1 会创建新的 Backdrop Root,玻璃卡在整段入场动画里
    // 采不到 .library 的壁纸 → 先发白再刷成渐变。Chromium 实测中间帧
    // 与稳态色差 64;只留 translateY 后色差为 0。
    const keyframes = /@keyframes wallpaper-page-in \{([^}]*)\}/.exec(cssSource)?.[1] ?? ''
    expect(keyframes).toContain('transform: translateY(14px)')
    expect(keyframes).not.toContain('opacity')
    const override =
      /:is\(\.notes-page, \.stats-page, \.goal-editor\) \{([^}]*)\}/.exec(cssSource)?.[1] ?? ''
    expect(override).toContain('animation-name: wallpaper-page-in')
    // 只换 name,duration / easing / fill-mode 仍归各分片自己管。
    expect(override).not.toContain('animation-duration')
  })

  it('leaves the plain-colour desktop entrance animation untouched', () => {
    const pageRule = /\.notes-page,\s*\.stats-page \{([^}]*)\}/.exec(notesSource)?.[1] ?? ''
    expect(pageRule).toContain('animation: fade-up')
    expect(settingsSource).toContain('@keyframes settings-page-in')
  })

  it('draws one frame on demand instead of per scroll frame', () => {
    // 800ms 的连画 + 每次 scroll 都 wake() 会让全屏 shader 在滚动时跑满
    // 60fps,还夹着 surfaces() 的强制同步布局 —— 首页卡顿的根因。
    expect(vendorSource).toMatch(/const AWAKE_MS = 50/)
    expect(hookSource).toContain('refraction.frame()')
    expect(hookSource).toContain('setTimeout(() => refraction.frame(), 120)')
    expect(hookSource).not.toContain("addEventListener('scroll', wake")
  })
})

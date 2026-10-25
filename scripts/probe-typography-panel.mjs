#!/usr/bin/env node
/**
 * 排版设置面板 + 键盘翻页 chrome 抑制的浏览器探针。
 *
 * 浏览器里跑的三件事,vitest(jsdom + 假内核)都替不了:
 * 1. 翻页期间,即使正文在静止指针底下位移、文档里真的补发了 pointermove,
 *    顶栏/底栏也不该亮起来(这是「键盘翻页闪一下」的来源);
 * 2. 面板真实排版:行不被面板裁掉(分段控件四档 + 四个字标签要放得下);
 * 3. 原书排版开关 / 段首缩进 / 两把边距的点击链路不报错。
 *
 * 前置:dev server 在 5173。用法:node scripts/probe-typography-panel.mjs
 */

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createReporter, findChromium, loadPlaywright, requireDevServer } from './lib/browser.mjs'

const BASE = 'http://localhost:5173/'
const PROJECT_ROOT = resolve(import.meta.dirname, '..')

const reporter = createReporter()
const { check, section } = reporter

function findSampleBook() {
  const found = readdirSync(PROJECT_ROOT).find((name) => name.endsWith('.epub'))
  return found === undefined ? null : join(PROJECT_ROOT, found)
}

const { module: playwright, fallback } = await loadPlaywright()
const executablePath = findChromium()
const book = findSampleBook()

await requireDevServer(BASE)

const browser = await playwright.chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)))

const chromeVisible = () =>
  page.evaluate(
    () => document.querySelector('.reader')?.classList.contains('chrome-visible') === true,
  )

/** 打开排版设置面板。 */
const openPanel = async () => {
  await page.click('[title="排版设置"]')
  await page.waitForSelector('.reader-settings', { timeout: 5000 })
}

/**
 * 读书页文档里 p 的 text-indent。
 *
 * 三条都是这台机器/这个内核的实际情况,绕不过去:
 * 1. 书页 iframe 挂在 foliate 的 **closed** shadow root 里 —— 主文档
 *    querySelectorAll('iframe') 看不见它,DOM.getDocument(pierce) 也抓不到;
 * 2. 每翻一节就换一个 blob 文档,Playwright 的 `page.frames()` 引用会过期,
 *    evaluate 直接抛 → 只能每次现抓 execution context;
 * 3. 主窗口自己也有 <p>,而且书可能开在封面页(整页就一个 <img>)—— 所以
 *    只认「有长正文段落」的那一份文档。
 */
const cdp = await page.context().newCDPSession(page)
const contexts = new Map()
cdp.on('Runtime.executionContextCreated', (event) => contexts.set(event.context.id, event.context))
cdp.on('Runtime.executionContextDestroyed', (event) => contexts.delete(event.executionContextId))
await cdp.send('Runtime.enable')

/** 在书页文档里求一个表达式的值(取第一个答得上来、也不是主窗口的那一份)。 */
const readDocValue = async (expression) => {
  for (const context of contexts.values()) {
    if (context.auxData?.isDefault === false) continue
    const { result } = await cdp
      .send('Runtime.evaluate', {
        contextId: context.id,
        // 第 4 条:主窗口也答得上来(location 是 dev server、body 也有 font-family),
        // 得把它排除掉 —— 否则读到的永远是界面而不是书页。
        expression: `location.href === ${JSON.stringify(BASE)} ? null : (${expression})`,
        returnByValue: true,
      })
      .catch(() => ({ result: { value: null } }))
    if (result.value !== null && result.value !== undefined) return result.value
  }
  return null
}

const readDocIndent = () =>
  readDocValue(`(() => {
    const p = [...document.querySelectorAll('p')].find((n) => (n.textContent ?? '').length > 80)
    return p === undefined ? null : getComputedStyle(p).textIndent
  })()`)

const readDocFont = () => readDocValue(`getComputedStyle(document.body).fontFamily`)

/**
 * 翻到「有正文段落」的那一页 —— 这本书开在封面(整页一个 <img>),
 * 目录页也只有标题,采样缩进前必须真的翻进正文。
 */
const ensureTextPage = async () => {
  for (let i = 0; i < 12; i += 1) {
    if ((await readDocIndent()) !== null) return true
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
  }
  return (await readDocIndent()) !== null
}

/** 面板里某一行的控件容器(同类档位按钮在两行里重名,必须按行取)。 */
const clickInRow = async (label, option) => {
  await page.evaluate(
    ({ rowLabel, optionText }) => {
      const panel = document.querySelector('.reader-settings')
      const rows = [...(panel?.querySelectorAll('.settings-row') ?? [])]
      const row = rows.find(
        (node) => node.querySelector('.settings-label')?.textContent === rowLabel,
      )
      const button = [...(row?.querySelectorAll('button') ?? [])].find(
        (node) => node.textContent === optionText,
      )
      button?.click()
    },
    { rowLabel: label, optionText: option },
  )
  await page.waitForTimeout(400)
}

/** 字体组是一整排按钮(没有 .settings-row),按分组标题定位。 */
const clickInGroup = async (groupLabel, option) => {
  await page.evaluate(
    ({ target, optionText }) => {
      const panel = document.querySelector('.reader-settings')
      const group = [...(panel?.querySelectorAll('.settings-group') ?? [])].find(
        (node) => node.querySelector('.settings-group-label')?.textContent === target,
      )
      const button = [...(group?.querySelectorAll('button') ?? [])].find(
        (node) => node.textContent === optionText,
      )
      button?.click()
    },
    { target: groupLabel, optionText: option },
  )
  await page.waitForTimeout(400)
}

/** 字号行是 +/- 图标按钮(没有文字),按 title 定位。 */
const clickInRowByTitle = async (label, buttonTitle) => {
  await page.evaluate(
    ({ rowLabel, title }) => {
      const panel = document.querySelector('.reader-settings')
      const rows = [...(panel?.querySelectorAll('.settings-row') ?? [])]
      const row = rows.find(
        (node) => node.querySelector('.settings-label')?.textContent === rowLabel,
      )
      const button = [...(row?.querySelectorAll('button') ?? [])].find(
        (node) => node.getAttribute('title') === title,
      )
      button?.click()
    },
    { rowLabel: label, title: buttonTitle },
  )
  await page.waitForTimeout(400)
}

/** 原书排版总开关翻一下。 */
const toggleOriginal = async () => {
  await page.click('.settings-toggle')
  await page.waitForTimeout(400)
}

/** 读字号行当前显示的值(「18px」)。 */
const readRowValue = (label) =>
  page.evaluate((rowLabel) => {
    const panel = document.querySelector('.reader-settings')
    const rows = [...(panel?.querySelectorAll('.settings-row') ?? [])]
    const row = rows.find((node) => node.querySelector('.settings-label')?.textContent === rowLabel)
    return row?.querySelector('.segmented-value')?.textContent ?? null
  }, label)

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library-empty', { timeout: 15000 })

  const importInput = await page.$('input[type=file][multiple]')
  await importInput.setInputFiles(book)
  await page.waitForSelector('.book-card', { timeout: 90000 })
  await page.waitForTimeout(3500)

  section('开书')
  await page.click('.book-card .book-cover')
  await page.waitForSelector('.reader', { timeout: 30000 })
  await page.waitForFunction(
    () => document.querySelector('.reader')?.classList.contains('chrome-visible') === true,
    { timeout: 20000 },
  )
  await page.mouse.move(640, 500)
  await page.waitForFunction(
    () => document.querySelector('.reader')?.classList.contains('chrome-visible') === false,
    { timeout: 15000 },
  )
  check('鼠标静止在正文上时 chrome 也会自动收起', true)

  section('键盘翻页不唤起 chrome')
  // 模拟 WebKit:翻页中正文在静止指针底下位移,文档里补发 pointermove。
  // 补发的位置就在指针正下方 —— 父窗口与 iframe 两条转发路都走一遍。
  const frame = page.frames().find((f) => f !== page.mainFrame())
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(120)
    await page.evaluate(() => {
      const target = document.querySelector('.reader-host') ?? document.body
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    })
    if (frame !== undefined) {
      await frame
        .evaluate(() => {
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
        })
        .catch(() => {})
    }
    await page.waitForTimeout(120)
    const visible = await chromeVisible()
    check(`第 ${i + 1} 次 ArrowRight + 补发 pointermove 后 chrome 仍收起`, visible === false)
  }
  await page.waitForTimeout(1200)
  await page.mouse.move(660, 520)
  await page.waitForTimeout(200)
  check('抑制窗口过后,真实的指针移动照常唤起 chrome', (await chromeVisible()) === true)

  check('能翻到有正文段落的一页', await ensureTextPage())

  section('排版设置面板')
  await openPanel()
  const panel = await page.evaluate(() => {
    const node = document.querySelector('.reader-settings')
    if (node === null) return null
    const rows = [...node.querySelectorAll('.settings-row')]
    const clipped = rows
      .filter((row) => row.scrollWidth > row.clientWidth + 1)
      .map((row) => row.querySelector('.settings-label')?.textContent ?? '?')
    return {
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      labels: rows.map((row) => row.querySelector('.settings-label')?.textContent ?? '?'),
      clipped,
      switchOn: node.querySelector('.settings-toggle')?.getAttribute('aria-checked'),
    }
  })
  check(
    '面板行没有被裁掉(左右/上下边距四档放得下)',
    panel?.clipped.length === 0,
    (panel?.clipped ?? []).join(','),
  )
  check('原书排版默认开', panel?.switchOn === 'true', String(panel?.switchOn))
  check(
    '原书排版下只给「页面 / 主题 / 文字」入口',
    JSON.stringify(panel?.labels) ===
      JSON.stringify(['字号', '左右边距', '上下边距', '简繁转换', '导入词典']),
    JSON.stringify(panel?.labels),
  )

  // 字体独立于总开关:原书排版下也要能换字体。
  const fontGroupInOriginal = await page.evaluate(
    () =>
      [...document.querySelectorAll('.settings-group-label')].some(
        (node) => node.textContent === '字体',
      ) === true,
  )
  check('原书排版下字体入口也在', fontGroupInOriginal)
  await clickInGroup('字体', '楷体')
  await page.waitForTimeout(700)
  const kaitiFont = await readDocFont()
  check(
    '原书排版下换字体生效(楷体真的进到书页)',
    kaitiFont !== null && kaitiFont.includes('Kaiti'),
    String(kaitiFont),
  )
  const untouchedFontSize = await readRowValue('字号')
  check('字号从没动过时按 16px 兜底', untouchedFontSize === '16px', String(untouchedFontSize))

  section('切到自定义排版')
  await toggleOriginal()
  const custom = await page.evaluate(() => {
    const node = document.querySelector('.reader-settings')
    const rows = [...node.querySelectorAll('.settings-row')]
    return {
      labels: rows.map((row) => row.querySelector('.settings-label')?.textContent ?? '?'),
      clipped: rows
        .filter((row) => row.scrollWidth > row.clientWidth + 1)
        .map((row) => row.querySelector('.settings-label')?.textContent ?? '?'),
      switchOn: node.querySelector('.settings-toggle')?.getAttribute('aria-checked'),
      activeIndent: [...rows]
        .find((row) => row.querySelector('.settings-label')?.textContent === '段首缩进')
        ?.querySelector('.segmented button.is-active')?.textContent,
    }
  })
  check('关掉开关后自定义整组出现', custom.switchOn === 'false', String(custom.switchOn))
  check(
    '正文 + 段落 + 字重 + 方向都在',
    ['行距', '段间距', '段首缩进', '字重', '排版方向'].every((label) =>
      custom.labels.includes(label),
    ),
    JSON.stringify(custom.labels),
  )
  check('段首缩进默认落在「2 字符」', custom.activeIndent === '2 字符', String(custom.activeIndent))
  check('自定义模式下行也没被裁掉', custom.clipped.length === 0, custom.clipped.join(','))

  const customFontSize = await readRowValue('字号')
  check('切到自定义时字号落到 18px', customFontSize === '18px', String(customFontSize))
  const activeFont = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.settings-group')].find(
      (node) => node.querySelector('.settings-group-label')?.textContent === '字体',
    )
    return group?.querySelector('.segmented button.is-active')?.textContent ?? null
  })
  check('切到自定义不冲掉已选的字体(楷体仍是楷体)', activeFont === '楷体', String(activeFont))

  // 18px 只补「没选过」的那一格:读者自己动过字号,两种模式下都以读者为准
  await clickInRowByTitle('字号', '增大字号')
  const bumped = await readRowValue('字号')
  check('自定义模式下把字号改到 20px', bumped === '20px', String(bumped))
  await toggleOriginal()
  const keptInOriginal = await readRowValue('字号')
  check('切回原书排版,读者的 20px 留着', keptInOriginal === '20px', String(keptInOriginal))
  await toggleOriginal()
  const keptInCustom = await readRowValue('字号')
  check('再切回自定义,20px 不被 18px 默认档盖掉', keptInCustom === '20px', String(keptInCustom))

  // 默认 2 字符:缩进要真的写进书页文档(内核注入的 CSS 只对 p 生效)
  const defaultIndent = await readDocIndent()
  check(
    '段首缩进下发到书页文档(默认 2 字符)',
    defaultIndent !== null && defaultIndent !== '0px',
    String(defaultIndent),
  )

  await clickInRow('段首缩进', '不缩进')
  await clickInRow('左右边距', '特宽')
  await clickInRow('上下边距', '特窄')
  await page.waitForTimeout(600)
  const applied = await page.evaluate(() => {
    const node = document.querySelector('.reader-settings')
    const rows = [...node.querySelectorAll('.settings-row')]
    const indentActive = [...rows]
      .find((row) => row.querySelector('.settings-label')?.textContent === '段首缩进')
      ?.querySelector('.segmented button.is-active')?.textContent
    const inlineActive = [...rows]
      .find((row) => row.querySelector('.settings-label')?.textContent === '左右边距')
      ?.querySelector('.segmented button.is-active')?.textContent
    const blockActive = [...rows]
      .find((row) => row.querySelector('.settings-label')?.textContent === '上下边距')
      ?.querySelector('.segmented button.is-active')?.textContent
    return { indentActive, inlineActive, blockActive }
  })
  check(
    '点击生效:段首缩进 → 不缩进',
    applied.indentActive === '不缩进',
    String(applied.indentActive),
  )
  check('点击生效:左右边距 → 特宽', applied.inlineActive === '特宽', String(applied.inlineActive))
  check('点击生效:上下边距 → 特窄', applied.blockActive === '特窄', String(applied.blockActive))

  // 选「不缩进」后要撤干净 —— 只验证了「能加上」还不够,撤不掉等于开关是单向的
  await ensureTextPage()
  const clearedIndent = await readDocIndent()
  check('选「不缩进」后书页段落缩进撤掉', clearedIndent === '0px', String(clearedIndent))

  // 字体选回「原书」:必须是「不再覆盖」,而不是「换成另一个字体」
  await clickInGroup('字体', '原书')
  await page.waitForTimeout(700)
  const restoredFont = await readDocFont()
  check(
    '字体选回「原书」→ 不再覆盖书自带字体',
    restoredFont !== null && !restoredFont.includes('Kaiti'),
    String(restoredFont),
  )

  section('页面异常')
  check('全程无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ') || '无')
} finally {
  await browser.close()
}

process.exit(reporter.finish(fallback ? '(注意:用的是回退的 playwright)' : ''))

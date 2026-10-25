#!/usr/bin/env node
/**
 * 书架「每行几本」+ 列表悬浮图标的浏览器探针。
 *
 * vitest(jsdom)替不了的两件事:
 * 1. 固定列数是 CSS(`repeat(var(--shelf-cols), minmax(0,1fr))`)在真实布局里
 *    的结果 —— 要量 computed grid-template-columns 才知道真的是 4 等分;
 * 2. 列表行悬浮图标的显隐是 hover 状态的级联(`.book-row:hover`),jsdom 没有
 *    hover,只有真浏览器能把指针放上去再读 computed opacity。
 *
 * 前置:dev server 在 5173。用法:node scripts/probe-shelf-columns.mjs
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

/** 网格 computed 的列数(像素轨道以逗号分隔)。 */
const gridColumns = () =>
  page.evaluate(() => {
    const grid = document.querySelector('.shelf-grid')
    if (grid === null) return null
    return {
      isFixed: grid.classList.contains('is-fixed'),
      tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
    }
  })

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library-empty', { timeout: 15000 })

  const importInput = await page.$('input[type=file][multiple]')
  await importInput.setInputFiles(book)
  await page.waitForSelector('.book-card', { timeout: 90000 })
  await page.waitForTimeout(1500)

  section('每行书本数(网格)')
  const trigger = page.locator('[aria-label="每行显示的书本数"]')
  check('网格视图默认提供「每行」下拉', (await trigger.count()) === 1)
  check('默认档是自适应', (await trigger.textContent())?.includes('自适应') === true)
  check('默认网格不带 is-fixed', (await gridColumns())?.isFixed === false)

  await trigger.click()
  await page.getByRole('menuitemradio', { name: '每行 4 本' }).click()
  await page.waitForTimeout(300)
  const four = await gridColumns()
  check('选 4 本后网格带 is-fixed', four?.isFixed === true)
  check('computed 布局真的是 4 条等宽轨道', four?.tracks === 4, String(four?.tracks))
  check(
    '选择持久化到 localStorage',
    (await page.evaluate(() => localStorage.getItem('deepread.shelf.columns'))) === '4',
  )
  await page.screenshot({ path: '/tmp/shelf-4cols.png' })

  await trigger.click()
  await page.getByRole('menuitemradio', { name: '自适应' }).click()
  await page.waitForTimeout(300)
  check('切回自适应后 is-fixed 摘掉', (await gridColumns())?.isFixed === false)

  /** 读第一张卡片悬浮图标的可见性与位置(getClientRects 过滤掉 display:none)。 */
  const readCardActions = () =>
    page.evaluate(() => {
      const shell = document.querySelector('.book-cover-shell')
      const bounds = shell?.getBoundingClientRect()
      if (bounds === undefined) return null
      const visible = [...(shell?.querySelectorAll('.card-action-icon') ?? [])].filter(
        (el) => el.getClientRects().length > 0,
      )
      const rects = visible.map((el) => el.getBoundingClientRect())
      const glyph = visible[0]?.querySelector('svg')?.getBoundingClientRect()
      return {
        count: visible.length,
        labels: visible.map((el) => el.getAttribute('aria-label')),
        iconWidth: Math.round(rects[0]?.width ?? 0),
        glyphWidth: Math.round(glyph?.width ?? 0),
        coverWidth: Math.round(bounds.width),
        /* 单行:所有图标顶边一致(折行会出现第二排不同的 top)。 */
        singleRow: new Set(rects.map((rect) => Math.round(rect.top))).size === 1,
        allInside: rects.every(
          (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
        ),
      }
    })

  /** 切到某个列数档并悬浮第一张封面。 */
  const setColumns = async (option) => {
    await trigger.click()
    await page.getByRole('menuitemradio', { name: option }).click()
    await page.waitForTimeout(300)
    await page.locator('.book-cover-shell').first().hover()
    await page.waitForTimeout(450)
  }

  /** 一行五档都是同一个判据:图标不折叠、不折行、不越界,且**字形**始终不缩。
   * Request E:缩的是圆底(圆圈),不是图标本体 —— 无论封面多窄,★/🏷/⬆ 的
   * 字形必须保持 ~15px(phosphor size={15}),缩到 13 以下就开始糊。 */
  const expectFullRow = async (option, label) => {
    await setColumns(option)
    const state = await readCardActions()
    check(
      `${label}:5 个图标单行显示且不越界`,
      state?.count === 5 && state.singleRow === true && state.allInside === true,
      JSON.stringify(state),
    )
    check(
      `${label}:字形不随封面缩(始终 ~15px)`,
      state?.glyphWidth >= 13 && state?.glyphWidth <= 17,
      `glyph ${state?.glyphWidth}px @ 圆底 ${state?.iconWidth}px / 封面 ${state?.coverWidth}px`,
    )
    return state
  }

  section('图标随封面缩小(不折叠、不折行)')
  const three = await expectFullRow('每行 3 本', '每行 3 本')
  check('宽封面用图标原尺寸 28px', three?.iconWidth === 28, `${three?.iconWidth}px`)

  await expectFullRow('每行 6 本', '每行 6 本')
  const seven = await expectFullRow('每行 7 本', '每行 7 本')
  check('每行 7 本图标确实缩小了(<28px)', seven?.iconWidth < 28, `${seven?.iconWidth}px`)
  await page.screenshot({ path: '/tmp/shelf-7cols-hover.png' })

  const eight = await expectFullRow('每行 8 本', '每行 8 本')
  check(
    '每行 8 本仍单行显示(图标继续缩小)',
    eight?.count === 5 && eight.singleRow === true && eight.allInside === true,
    JSON.stringify(eight),
  )
  await page.screenshot({ path: '/tmp/shelf-8cols-hover.png' })
  check(
    '缩放下限 15px,不会缩到看不见',
    eight?.iconWidth >= 15,
    `${eight?.iconWidth}px @ 封面 ${eight?.coverWidth}px`,
  )

  // 折叠设计已取消:窄封面不该再有 ⋯ 更多按钮。
  check('窄封面没有 ⋯ 折叠按钮', (await page.locator('.card-action-more').count()) === 0)

  // 完整动作改由右键菜单兜底(触屏/键盘同样够得到)。
  await page.locator('.book-cover').first().click({ button: 'right' })
  await page.waitForSelector('.card-menu.is-card', { timeout: 5000 })
  const menuItems = await page.evaluate(() =>
    [...document.querySelectorAll('.card-menu.is-card [role="menuitem"]')].map((el) =>
      el.textContent?.trim(),
    ),
  )
  check(
    '右键菜单是动作全集',
    JSON.stringify(menuItems) ===
      JSON.stringify(['打标签', '导出批注(.md)', '编辑书籍信息', '从书架移除']),
    JSON.stringify(menuItems),
  )
  await page.screenshot({ path: '/tmp/shelf-menu.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  section('列表视图的悬浮图标')
  await page.click('[title="列表视图"]')
  await page.waitForSelector('.book-row', { timeout: 5000 })
  check('列表视图没有行数下拉', (await trigger.count()) === 0)

  const rowActions = page.locator('.book-row .book-row-actions .card-action-icon')
  check('列表行动作与网格同一套(4 个图标)', (await rowActions.count()) === 4)

  const firstIconOpacity = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('.book-row-actions .card-action-icon')).opacity,
    )
  check('未悬浮时图标隐形', (await firstIconOpacity()) === '0')

  await page.hover('.book-row')
  await page.waitForTimeout(450)
  check('悬浮后图标真的可见(opacity 1)', (await firstIconOpacity()) === '1')
  await page.screenshot({ path: '/tmp/shelf-row-hover.png' })

  await page.locator('[aria-label^="给《"]').first().click()
  await page.waitForSelector('.book-row .tag-popover', { timeout: 5000 })
  check('列表行「打标签」开的是标签浮层', true)
  // 锚在行下方才有意义:列表区 overflow:auto,向上锚会被内容顶部裁掉。
  const popBelow = await page.evaluate(() => {
    const pop = document.querySelector('.book-row .tag-popover')
    const row = document.querySelector('.book-row')
    const popRect = pop?.getBoundingClientRect()
    const rowRect = row?.getBoundingClientRect()
    return {
      below: popRect !== undefined && rowRect !== undefined && popRect.top >= rowRect.bottom - 2,
      inViewport: popRect !== undefined && popRect.top >= 0 && popRect.left >= 0,
    }
  })
  check('浮层在行的下方且完整可见', popBelow.below === true && popBelow.inViewport === true)
  await page.screenshot({ path: '/tmp/shelf-row-tags.png' })

  check('无页面报错', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

process.exit(reporter.finish(fallback ? '(注意:用的是回退的 playwright)' : ''))

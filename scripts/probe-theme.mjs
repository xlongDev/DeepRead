#!/usr/bin/env node
/**
 * 配色主题探针:主题是否真的决定整套配色(而非只铺一层底色)。
 *
 * vitest 替不了的三件事:
 * 1. 强调色是 `--accent-h/c` 内联变量算出来的,只有真浏览器能读 computed;
 * 2. 七颗色板 + 自定义是否仍在一行(settings-body 是 overflow-x:auto,
 *    溢出会被裁成静默丢失,不会报错);
 * 3. 阅读页必须自带纸色 —— 换主题后书页若跟着变,主题就污染了阅读。
 *
 * 前置:dev server 在 5173。用法:node scripts/probe-theme.mjs
 */

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createReporter, findChromium, loadPlaywright, requireDevServer } from './lib/browser.mjs'

const BASE = 'http://localhost:5173/'
const PROJECT_ROOT = resolve(import.meta.dirname, '..')

const reporter = createReporter()
const { check, section } = reporter

const book = readdirSync(PROJECT_ROOT).find((name) => name.endsWith('.epub'))

const { module: playwright, fallback } = await loadPlaywright()
const executablePath = findChromium()

await requireDevServer(BASE)

const browser = await playwright.chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)))

/** 当前界面实际算出来的强调色与页面底色。 */
const readTheme = () =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const library = document.querySelector('.library')
    return {
      accent: root.getPropertyValue('--color-accent').trim(),
      accentH: root.getPropertyValue('--accent-h').trim(),
      accentC: root.getPropertyValue('--accent-c').trim(),
      background: document.documentElement.dataset.background ?? '',
      wallpaper: root.getPropertyValue('--wallpaper').trim().slice(0, 60),
      libraryBg: library === null ? '' : getComputedStyle(library).backgroundColor,
    }
  })

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library', { timeout: 15000 })
  if ((await page.locator('.library-empty').count()) === 1 && book !== undefined) {
    const input = await page.$('input[type=file][multiple]')
    await input.setInputFiles(join(PROJECT_ROOT, book))
    await page.waitForSelector('.book-card', { timeout: 120000 })
    await page.waitForTimeout(1200)
  }

  section('默认档:纯色桌面 + 品牌蓝')
  const plain = await readTheme()
  check('默认不带 data-background', plain.background === 'none', plain.background)
  check('默认没有 --wallpaper', plain.wallpaper === '', plain.wallpaper)
  check(
    '默认强调色就是品牌蓝(271 / .14)',
    plain.accentH === '271' && plain.accentC === '0.14',
    `${plain.accentH} / ${plain.accentC}`,
  )
  await page.screenshot({ path: '/tmp/theme-0-plain.png' })

  const openSettings = async () => {
    await page.getByRole('button', { name: /^设置/ }).first().click()
    await page.waitForSelector('.modal-panel', { timeout: 5000 })
    await page.waitForTimeout(300)
  }

  // 纯色桌面下 auto 直接解成品牌蓝,那一颗必须读成选中;否则整行空着,
  // 用户会以为强调色丢了。
  await openSettings()
  const brandActive = await page
    .locator('[aria-label="强调色 品牌蓝"]')
    .evaluate((el) => el.classList.contains('is-active'))
  check('纯色桌面下品牌蓝显示为选中', brandActive === true)
  check(
    '纯色桌面没有「跟随主题」那颗(会与品牌蓝重复)',
    (await page.locator('.accent-auto').count()) === 0,
  )
  await page.locator('.accent-row').screenshot({ path: '/tmp/theme-0b-accent.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  section('配色主题:选项自带渐变条')
  await openSettings()
  const themeTrigger = page.locator('[aria-label="配色主题"]')
  await themeTrigger.scrollIntoViewIfNeeded()
  await themeTrigger.click()
  await page.waitForSelector('.dropdown-menu', { timeout: 5000 })
  await page.waitForTimeout(500)
  const swatchCount = await page.locator('.dropdown-option-swatch').count()
  check('16 个选项都有渐变条', swatchCount === 16, String(swatchCount))
  const swatchBox = await page.locator('.dropdown-option-swatch').nth(1).boundingBox()
  check(
    '色条有实际尺寸(没被 flex 压成 0)',
    swatchBox !== null && swatchBox.width > 18 && swatchBox.height > 8,
    JSON.stringify(swatchBox),
  )
  await page.screenshot({ path: '/tmp/theme-1-dropdown.png' })
  await page.locator('.dropdown-menu').screenshot({ path: '/tmp/theme-1b-menu.png' })

  await page.getByRole('menuitemradio', { name: /清新青绿/ }).click()
  await page.waitForTimeout(400)

  section('选主题后强调色跟随')
  const fresh = await readTheme()
  check('data-background 换成 fresh', fresh.background === 'fresh', fresh.background)
  check('--wallpaper 铺上了', fresh.wallpaper.startsWith('linear-gradient'), fresh.wallpaper)
  check(
    '强调色色相切到 181(青绿)',
    fresh.accentH === '181' && fresh.accentC === '0.11',
    `${fresh.accentH} / ${fresh.accentC}`,
  )
  check('--color-accent 真的变成 oklch(…)', fresh.accent.startsWith('oklch'), fresh.accent)

  const accentRow = await page.evaluate(() => {
    const row = document.querySelector('.accent-row')
    const swatches = [...document.querySelectorAll('.accent-row .accent-swatch')]
    const rowRect = row?.getBoundingClientRect()
    return {
      count: swatches.length,
      singleRow: new Set(swatches.map((el) => Math.round(el.getBoundingClientRect().top))).size,
      inside:
        rowRect === undefined
          ? false
          : swatches.every((el) => {
              const rect = el.getBoundingClientRect()
              return rect.left >= rowRect.left - 1 && rect.right <= rowRect.right + 1
            }),
      autoActive: document.querySelector('.accent-auto')?.classList.contains('is-active') === true,
    }
  })
  check('色板 7 颗(跟随主题 + 6 预设)', accentRow.count === 7, String(accentRow.count))
  check('7 颗仍在一行内且不越界', accentRow.singleRow === 1 && accentRow.inside === true)
  check('「跟随主题」处于选中态', accentRow.autoActive === true)
  const themeCard = await page.evaluate(() => {
    const group = document.querySelector('.settings-group')
    const label = group?.querySelector('.settings-theme-block .settings-shelf-columns-label')
    const trigger = group?.querySelector('[aria-label="配色主题"]')
    return { label: label?.textContent?.trim() ?? '', sameCard: trigger !== null }
  })
  check(
    '配色与明暗同在一张卡(界面主题)',
    themeCard.label === '明暗' && themeCard.sameCard === true,
    JSON.stringify(themeCard),
  )
  await page.evaluate(() => document.querySelector('.settings-body')?.scrollTo({ top: 0 }))
  await page.waitForTimeout(400)
  await page.screenshot({ path: '/tmp/theme-2a-top.png' })
  await page.locator('.accent-row').screenshot({ path: '/tmp/theme-2b-accent.png' })
  await page.screenshot({ path: '/tmp/theme-2-settings.png' })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/theme-3-shelf-fresh.png' })

  section('换主题会重排强调色,自定义色不被覆盖')
  await openSettings()
  await page.locator('[aria-label="强调色 松绿"]').click()
  await page.waitForTimeout(200)
  const forest = await readTheme()
  check('手选预设后色相 = 165', forest.accentH === '165', forest.accentH)
  const trigger = page.locator('[aria-label="配色主题"]')
  // 下拉在窗口滚动时自动收起,所以先把触发器滚进视野、停稳,再打开。
  await trigger.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await trigger.click()
  await page.waitForSelector('.dropdown-menu', { timeout: 5000 })
  await page.getByRole('menuitemradio', { name: /暖调霞紫/ }).click()
  await page.waitForTimeout(400)
  const warm = await readTheme()
  check('换主题后回到跟随(色相 = 315)', warm.accentH === '315', warm.accentH)

  section('深色世界:同一色相,彩度收窄')
  await page.locator('.theme-swatch', { hasText: '石墨' }).click()
  await page.waitForTimeout(400)
  const dark = await readTheme()
  check('深色下 --accent-c 收到 0.065', dark.accentC === '0.065', dark.accentC)
  check('色相不变(315)', dark.accentH === '315', dark.accentH)
  await page.screenshot({ path: '/tmp/theme-4-settings-dark.png' })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/theme-5-shelf-dark.png' })

  section('统计页在主题下仍有卡片边界')
  await page.getByRole('button', { name: /^统计/ }).first().click()
  await page.waitForSelector('.stats-page', { timeout: 8000 })
  await page.waitForTimeout(1400)
  const overview = await page.evaluate(() => {
    const el = document.querySelector('.stats-overview')
    const style = el === null ? null : getComputedStyle(el)
    const bg = style?.backgroundColor ?? ''
    // computed 可能是 rgba(…) 也可能是 color(srgb … / a),两种都要读 alpha。
    const slashAlpha = /\/\s*([\d.]+)\s*\)/.exec(bg)
    const rgbaAlpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(bg)
    const alpha = Number(slashAlpha?.[1] ?? rgbaAlpha?.[1] ?? '1')
    return { bg, backdrop: style?.backdropFilter ?? 'none', alpha }
  })
  check(
    '概览卡是玻璃(半透明 + 无 backdrop 采样)',
    overview.alpha > 0.5 && overview.alpha < 0.9 && overview.backdrop === 'none',
    `${overview.bg} / ${overview.backdrop}`,
  )
  await page.screenshot({ path: '/tmp/theme-7-stats.png', animations: 'disabled' })
  await page.getByRole('button', { name: /^书架/ }).first().click()
  await page.waitForTimeout(600)

  section('下拉打开时把当前项带进视野')
  await openSettings()
  const picker = page.locator('[aria-label="配色主题"]')
  await picker.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await picker.click()
  await page.waitForSelector('.dropdown-menu', { timeout: 5000 })
  await page.getByRole('menuitemradio', { name: /热带珊瑚/ }).click()
  await page.waitForTimeout(400)
  await picker.click()
  await page.waitForSelector('.dropdown-menu', { timeout: 5000 })
  await page.waitForTimeout(400)
  const visible = await page.evaluate(() => {
    const menu = document.querySelector('.dropdown-menu')
    const active = menu?.querySelector('[aria-checked="true"]')
    if (menu === null || active === null || active === undefined) return null
    const box = menu.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    return {
      label: active.textContent?.trim().slice(0, 10) ?? '',
      inView: item.top >= box.top - 1 && item.bottom <= box.bottom + 1,
      scrolled: menu.scrollTop > 0,
    }
  })
  check(
    '重新打开时当前项(第 15 项)已滚进可视区',
    visible?.inView === true && visible.scrolled === true,
    JSON.stringify(visible),
  )
  // 此刻是深色世界:色标必须换 dark 那套(#60a5fa),否则浅色条在深色
  // 浮层上会亮成一排小灯 —— 比菜单文字还抢眼。
  const darkSwatch = await page.evaluate(() => {
    const row = document.querySelectorAll('.dropdown-option-swatch')[1]
    return row === undefined ? '' : getComputedStyle(row).backgroundImage
  })
  check(
    '深色世界色标用 dark 三色(#60a5fa)',
    /96,\s*165,\s*250/.test(darkSwatch),
    darkSwatch.slice(0, 70),
  )
  await page.locator('.dropdown-menu').screenshot({ path: '/tmp/theme-8-menu-scrolled.png' })
  // 选回暖调霞紫,后面的阅读器检查仍按深色 + 紫主题走。
  await page.getByRole('menuitemradio', { name: /暖调霞紫/ }).click()
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  section('阅读页不受主题影响')
  const before = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return root.getPropertyValue('--reader-bg').trim()
  })
  check('书架态没有 --reader-bg(纸色由阅读器自己注入)', before === '', before)
  await page.locator('.book-card').first().click()
  await page.waitForSelector('.reader', { timeout: 30000 })
  await page.waitForTimeout(2500)
  const reader = await page.evaluate(() => {
    const root = document.documentElement
    const el = document.querySelector('.reader')
    const style = el === null ? null : getComputedStyle(el)
    const ui = getComputedStyle(root)
    return {
      background: style?.backgroundColor ?? '',
      wallpaper: root.style.getPropertyValue('--wallpaper'),
      dataBackground: root.dataset.background ?? '',
      accent: style?.getPropertyValue('--color-accent').trim() ?? '',
      accentSoft: style?.getPropertyValue('--color-accent-soft').trim() ?? '',
      uiAccent: ui.getPropertyValue('--color-accent').trim(),
      uiSoft: ui.getPropertyValue('--color-accent-soft').trim(),
    }
  })
  check('阅读器没有继承壁纸', reader.wallpaper === '' && reader.dataBackground === '')
  check('阅读器背景是纸色,不是渐变', reader.background !== '', reader.background)
  // 用户 11-09 拍板:阅读器内的一切跟纸张走。纸白纸的墨是 #1d1b17,
  // 而界面此刻是暖调霞紫的粉;两者必须不同,且 soft 不能是被继承粘住的旧值。
  check(
    '阅读器强调色 = 纸的墨色,不是界面主题色',
    reader.accent === '#1d1b17' && reader.accent !== reader.uiAccent,
    `${reader.accent} (界面 ${reader.uiAccent})`,
  )
  check(
    'accent-soft 跟着重算,没被界面那份粘住',
    reader.accentSoft !== reader.uiSoft && reader.accentSoft !== '',
    `${reader.accentSoft} (界面 ${reader.uiSoft})`,
  )
  await page.screenshot({ path: '/tmp/theme-6-reader.png' })

  check('无页面报错', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

process.exit(reporter.finish(fallback ? '(注意:用的是回退的 playwright)' : ''))

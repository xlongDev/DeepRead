#!/usr/bin/env node
/**
 * 真书样本回归 —— MOBI / AZW3 / FB2 / CBZ 这几种格式。
 *
 * README 的格式表给它们标着「内核原生解析(真书样本回归待补)」,risks.md 的 R1
 * 也写着「有 fixtures 但尚无真书回归」。fixtures 是脚本现造的,形状规整;真书里
 * 有作者用的怪招、损坏的元数据、非标准的章节切分 —— 只有真书能撞出来。
 *
 * **样本不进仓库**(它们是有版权的书)。脚本自己去项目根目录找,或用
 * `--samples <dir>` 指定。找不到的格式会被明确标成「没测」,而不是悄悄跳过。
 *
 * 前置:dev server 在 5173。
 * 用法:node scripts/smoke-formats.mjs [--samples <dir>] [--only mobi,azw3]
 */

import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createReporter, findChromium, loadPlaywright, requireDevServer } from './lib/browser.mjs'

const BASE = 'http://localhost:5173/'
const PROJECT_ROOT = resolve(import.meta.dirname, '..')

/** 这几种是 README 标了「待补」的。EPUB/PDF 已有真书 E2E,不在范围内。 */
const FORMATS = ['mobi', 'azw3', 'fb2', 'cbz']

const reporter = createReporter()
const { check, section } = reporter

function flagValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

/**
 * 每种格式取一个样本就够 —— 这是回归,不是穷举。同名格式多本时只挑第一本,
 * 但会把总数报出来,免得「测了 3 本」被误读成「覆盖了 12 本」。
 */
function findSamples(dir) {
  const byFormat = new Map()
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return { byFormat, dir, unreadable: true }
  }
  for (const name of entries) {
    const extension = name.split('.').pop()?.toLowerCase()
    if (extension === undefined || !FORMATS.includes(extension)) continue
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    const bucket = byFormat.get(extension) ?? []
    bucket.push(path)
    byFormat.set(extension, bucket)
  }
  return { byFormat, dir, unreadable: false }
}

/**
 * 正文在 foliate 的 iframe 里(blob: URL),而那个 iframe 挂在 **closed shadow
 * DOM** 下 —— `document.querySelector` 够不到(closed shadow 的 `shadowRoot`
 * 是 null),Playwright 的 `locator` 也够不到(它穿 shadow DOM,但穿不过 iframe
 * 边界)。`page.frames()` 是浏览器级的,能。
 *
 * 这个坑值得记着:第一次跑出来「正文 0 字符」,差点当成 MOBI 渲染坏了 ——
 * 截图一看扉页清清楚楚。
 */
async function readRenderedText(page) {
  let longest = ''
  for (const frame of page.frames()) {
    if (!frame.url().startsWith('blob:')) continue
    try {
      const text = await frame.evaluate(
        () => document.body?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      )
      if (text.length > longest.length) longest = text
    } catch {
      // 跨域或已销毁的 frame:跳过,别让它拖垮整轮。
    }
  }
  return longest
}

/** 打开一本书,把「内核到底渲染出了什么」抓回来。 */
async function openAndRead(page, bookPath) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library-empty', { timeout: 20000 })

  const input = await page.$('input[type=file][multiple]')
  await input.setInputFiles(bookPath)
  await page.waitForSelector('.book-card', { timeout: 180000 })
  await page.waitForTimeout(4000)

  const cardText = await page.evaluate(
    () =>
      document.querySelector('.book-card')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ??
      null,
  )

  await page.click('.book-card .book-cover')
  await page.waitForTimeout(10000)

  // 扉页往往只有书名/作者那几十个字,翻几页才够判断"正文真的渲染出来了"。
  let longest = await readRenderedText(page)
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1200)
    const next = await readRenderedText(page)
    if (next.length > longest.length) longest = next
  }

  return { cardText, text: longest }
}

// ---------- 主流程 ----------

const { module: playwright, fallback } = await loadPlaywright()
const executablePath = findChromium()
if (executablePath === null) {
  console.error('✗ 找不到 chromium。先跑一次 `npx playwright install chromium`。')
  process.exit(1)
}
await requireDevServer(BASE)

const samplesDir = resolve(flagValue('--samples') ?? PROJECT_ROOT)
const only =
  flagValue('--only')
    ?.split(',')
    .map((item) => item.trim().toLowerCase()) ?? null
const { byFormat, unreadable } = findSamples(samplesDir)

console.log(`真书样本回归 · ${BASE}`)
console.log(`  样本目录: ${samplesDir}`)
if (unreadable) {
  console.error('✗ 读不了那个目录。')
  process.exit(1)
}

const wanted = FORMATS.filter((format) => only === null || only.includes(format))
const missing = wanted.filter((format) => !byFormat.has(format))

if (byFormat.size === 0) {
  console.error(
    `✗ ${samplesDir} 里没有 ${FORMATS.join(' / ')} 样本。\n` +
      '  这些是受版权保护的书,不该进仓库 —— 用 --samples <dir> 指到你自己放书的地方。',
  )
  process.exit(1)
}

const browser = await playwright.chromium.launch({ executablePath })

try {
  for (const format of wanted) {
    const bucket = byFormat.get(format)
    section(
      `${format.toUpperCase()}${bucket === undefined ? '' : ` (${bucket.length} 本,取第 1 本)`}`,
    )

    if (bucket === undefined) {
      // 没样本 = 没测。明说,别让它看起来像通过了。
      console.log('  – 没有样本,跳过(未验证)')
      continue
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 160)))
    try {
      const result = await openAndRead(page, bucket[0])
      check('导入成功,书架出现', result.cardText !== null, result.cardText ?? '没有卡片')
      // 渲染出空壳不算通过 —— 翻了几页之后总该有整段正文。
      check(
        '内核渲染出正文',
        result.text.length > 100,
        `${result.text.length} 字符${result.text === '' ? '(一个字都没渲染出来)' : ''}`,
      )
      if (result.text !== '') console.log(`      正文摘录:${result.text.slice(0, 70)}…`)
      check('无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ') || '无')
    } catch (error) {
      check('完整走通', false, String(error).slice(0, 160))
    } finally {
      await page.close()
    }
  }

  if (missing.length > 0) {
    section('没覆盖到的')
    console.log(`  – ${missing.join(' / ')}:目录里没有样本`)
  }
} finally {
  await browser.close()
}

process.exit(
  reporter.finish(
    fallback
      ? '(注意:用的是回退的 playwright;没样本的格式标成了「未验证」而非通过)'
      : '没样本的格式标成了「未验证」而非通过',
  ),
)

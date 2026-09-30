#!/usr/bin/env node
/**
 * web 端冒烟测试 —— 把「浏览器模式」的核心承诺钉成可重复的检查。
 *
 * 覆盖的是**跨刷新的持久化**:导入 → 刷新书架还在 → 翻页 → 刷新进度还在 →
 * 备份导出 → 真删库 → 恢复 → 数据回来。这些是 IndexedDB 分流那套东西的
 * 全部价值所在,坏了用户立刻会发现,但 vitest 看不见。
 *
 * 为什么不是 vitest 用例:jsdom 里没有 IndexedDB,而本机装不上 fake-indexeddb
 * —— pnpm 的 store 在项目外、被文件系统代理拦下(CODEBUDDY_BROKER_DENY),
 * npm 又不认 `workspace:` 协议。所以这里跑**真实浏览器 + 真实 IndexedDB**,
 * 比 polyfill 更接近真相,代价是慢(约 1 分钟)且需要 dev server。
 *
 * 前置:dev server 在 5173(`npx vite --port 5173`)。
 * 用法:node scripts/smoke-web.mjs [--book <path>] [--keep-open]
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = 'http://localhost:5173/'
const PROJECT_ROOT = resolve(import.meta.dirname, '..')

// ---------- 断言 ----------

let failures = 0
const results = []

function check(label, ok, detail = '') {
  results.push({ label, ok })
  if (!ok) failures += 1
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------- 环境探测 ----------

/**
 * playwright 不在本项目的依赖里(装不上),所以除了正常解析,还回退到这台机器上
 * 已知的可用副本。回退时会明确警告 —— 别让「跑过了」被误读成「本项目能跑」。
 */
async function loadPlaywright() {
  const fallbacks = ['/Users/xiaolong/ai-resume-mvp/node_modules/playwright/index.mjs']
  try {
    return { module: await import('playwright'), fallback: false }
  } catch {
    for (const path of fallbacks) {
      if (!existsSync(path)) continue
      console.warn(`⚠ 本项目没有 playwright,回退到 ${path}\n`)
      return { module: await import(path), fallback: true }
    }
  }
  throw new Error('找不到 playwright。请在本项目安装,或改这里的回退路径。')
}

/** 扫描 ms-playwright 缓存目录,而不是写死版本号 —— 那个号会随浏览器升级变。 */
function findChromium() {
  const root = join(homedir(), 'Library/Caches/ms-playwright')
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium-')) continue
    const candidate = join(
      root,
      entry,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    )
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 找一本用来测的 epub:优先命令行传入,否则项目根目录里的第一本。 */
function findSampleBook() {
  const flag = process.argv.indexOf('--book')
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1])
  const found = readdirSync(PROJECT_ROOT).find((name) => name.endsWith('.epub'))
  return found === undefined ? null : join(PROJECT_ROOT, found)
}

// ---------- 主流程 ----------

const { module: playwright, fallback } = await loadPlaywright()
const executablePath = findChromium()
const book = findSampleBook()

if (executablePath === null) {
  console.error('✗ 找不到 chromium。先跑一次 `npx playwright install chromium`。')
  process.exit(1)
}
if (book === null) {
  console.error('✗ 找不到测试用的 epub。用 --book <path> 指定一本。')
  process.exit(1)
}
try {
  await fetch(BASE, { signal: AbortSignal.timeout(3000) })
} catch {
  console.error(`✗ dev server 不在 ${BASE}。先起一个:npx vite --port 5173`)
  process.exit(1)
}

console.log(`web 端冒烟测试 · ${BASE}`)
console.log(`  测试用书: ${book}`)

const browser = await playwright.chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

/** 页面级异常一律算失败 —— 静默的 console error 是这类 bug 的典型藏身处。 */
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)))

const shelf = () =>
  page.evaluate(() => {
    const card = document.querySelector('.book-card')
    const fill = card?.querySelector('.book-progress-fill')
    return {
      count: document.querySelectorAll('.book-card').length,
      text: card?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? null,
      progress: fill === null || fill === undefined ? null : getComputedStyle(fill).width,
    }
  })

try {
  // ---------- 1. 空书架 ----------
  section('1. 首次访问')
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library-empty', { timeout: 15000 })
  check('显示空书架引导(而不是空网格)', true)

  // ---------- 2. 导入 ----------
  section('2. 导入')
  const importInput = await page.$('input[type=file][multiple]')
  await importInput.setInputFiles(book)
  await page.waitForSelector('.book-card', { timeout: 90000 })
  await page.waitForTimeout(3500)
  const imported = await shelf()
  check('书架出现 1 本', imported.count === 1, `count=${imported.count}`)
  check('书名/作者已从书里解析出来', (imported.text ?? '').length > 4, imported.text ?? '')

  // ---------- 3. 刷新后书架还在(核心承诺) ----------
  section('3. 刷新 —— 书架是否活下来')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.book-card', { timeout: 30000 })
  await page.waitForTimeout(2500)
  const survived = await shelf()
  check('刷新后书架还在', survived.count === 1, `count=${survived.count}`)
  check('元数据(书名/作者)也还在', survived.text === imported.text, survived.text ?? '')

  // ---------- 4. 翻页 → 刷新后进度还在 ----------
  section('4. 翻页 —— 进度是否活下来')
  await page.click('.book-card .book-cover')
  await page.waitForTimeout(7000)
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
  }
  await page.waitForTimeout(4000) // 保存是防抖的
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.book-card', { timeout: 30000 })
  await page.waitForTimeout(3000)
  const withProgress = await shelf()
  check(
    '刷新后进度还在',
    withProgress.progress !== null && withProgress.progress !== '0px',
    withProgress.progress ?? '无进度条',
  )

  // ---------- 5. 备份导出 ----------
  section('5. 备份导出')
  await page.click('.lib-sidebar-foot button:has-text("设置")')
  await page.waitForSelector('.settings-tabs', { timeout: 5000 })
  await page.click('.settings-tabs button:has-text("备份与更新")')
  await page.waitForTimeout(600)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('button:has-text("导出备份")'),
  ])
  const backupPath = await download.path()
  const { readFileSync } = await import('node:fs')
  const snapshot = JSON.parse(readFileSync(backupPath, 'utf8'))
  check('导出了 JSON 备份', typeof snapshot.checksum === 'string')
  check('备份含书籍元数据', (snapshot.books?.length ?? 0) === 1)
  check('备份含书籍字节(base64)', (snapshot.files?.[0]?.data?.length ?? 0) > 1000)

  // 这份 JSON 是一份**跨端契约** —— 桌面端的 `import_json_snapshot`
  // (apps/desktop/src-tauri/src/storage.rs) 按这些名字反序列化。改字段名而
  // 不改那边,用户的备份就会在桌面端被拒绝,而且是"结构对不上"这种最难看懂
  // 的错。这里把名字钉住,是最起码的一致性检查(真正的端到端要跑 Tauri app)。
  const SNAPSHOT_KEYS = ['version', 'books', 'files', 'states', 'stats', 'cards']
  check(
    '顶层字段名与桌面端导入器对齐',
    SNAPSHOT_KEYS.every((key) => key in snapshot),
    SNAPSHOT_KEYS.filter((key) => !(key in snapshot)).join(',') || '',
  )
  const BOOK_KEYS = [
    'hash',
    'fileName',
    'displayName',
    'author',
    'subtitle',
    'publisher',
    'language',
    'format',
    'size',
    'addedAt',
    'tags',
  ]
  const missingBookKeys = BOOK_KEYS.filter((key) => !(key in (snapshot.books?.[0] ?? {})))
  check('书籍字段名与桌面端导入器对齐', missingBookKeys.length === 0, missingBookKeys.join(','))
  const STATE_KEYS = ['hash', 'progress', 'annotations', 'bookmarks', 'updatedAt']
  const missingStateKeys = STATE_KEYS.filter((key) => !(key in (snapshot.states?.[0] ?? {})))
  check(
    '阅读状态字段名与桌面端导入器对齐',
    missingStateKeys.length === 0,
    missingStateKeys.join(','),
  )

  // ---------- 6. 清库 → 恢复 ----------
  section('6. 清库后从备份恢复')
  await page.evaluate(() => indexedDB.deleteDatabase('deepread-web'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const emptied = await page.evaluate(() => document.querySelectorAll('.book-card').length)
  check('删库后书架确实空了', emptied === 0, `count=${emptied}`)

  await page.click('.lib-sidebar-foot button:has-text("设置")')
  await page.waitForSelector('.settings-tabs', { timeout: 5000 })
  await page.click('.settings-tabs button:has-text("备份与更新")')
  await page.waitForTimeout(500)
  await page.setInputFiles('input[type=file][accept*="json"]', backupPath)
  await page.waitForTimeout(4000)
  await page.click('.modal-foot button:has-text("完成")')
  await page.waitForTimeout(3000)
  const restored = await shelf()
  check('恢复后书架回来了', restored.count === 1, `count=${restored.count}`)
  // 卡片上的「读到 N%」是恢复之后才有的 —— 所以不能拿文本做全等比较,
  // 得先把这段进度文字摘掉再比书名。进度本身单独断言(见下一行)。
  const withoutProgress = (restored.text ?? '').replace(/读到 \d+% · /, '')
  check('恢复后书名也对', withoutProgress === imported.text, restored.text ?? '')
  check(
    '恢复后进度也回来了(备份把进度一起带过来了)',
    restored.progress !== null && restored.progress !== '0px',
    restored.progress ?? '无进度条',
  )

  // ---------- 7. 没有页面异常 ----------
  section('7. 页面异常')
  check('全程无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ') || '无')

  if (process.argv.includes('--keep-open')) await page.waitForTimeout(60000)
} finally {
  await browser.close()
}

// ---------- 汇总 ----------

const passed = results.filter((item) => item.ok).length
console.log(`\n${failures === 0 ? '✓ 全部通过' : '✗ 有失败'}: ${passed}/${results.length}`)
if (fallback) console.log('  (注意:用的是回退的 playwright,本项目自身没有安装)')
process.exit(failures === 0 ? 0 : 1)

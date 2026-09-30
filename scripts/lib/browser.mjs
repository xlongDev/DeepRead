/**
 * 冒烟脚本共用的东西:playwright / chromium 探测、断言输出、dev server 检查。
 *
 * 抽出来是因为几个脚本要探测的东西一模一样,而探测逻辑里全是这台机器的特殊性
 * (playwright 不在依赖里、chromium 的版本号会变)。复制两份,迟早只修其中一份。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * playwright 不在本项目的依赖里(装不上),所以除了正常解析,还回退到这台机器上
 * 已知的可用副本。回退时明确警告 —— 别让「跑过了」被误读成「本项目能跑」。
 */
export async function loadPlaywright() {
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
export function findChromium() {
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

/** 断言与汇总。每个脚本自己决定何时调 `finish`。 */
export function createReporter() {
  let failures = 0
  const results = []

  return {
    check(label, ok, detail = '') {
      results.push({ label, ok })
      if (!ok) failures += 1
      console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
    },
    section(title) {
      console.log(`\n${title}`)
    },
    /** 返回退出码,调用方 `process.exit(reporter.finish())` 即可。 */
    finish(footnote = '') {
      const passed = results.filter((item) => item.ok).length
      console.log(`\n${failures === 0 ? '✓ 全部通过' : '✗ 有失败'}: ${passed}/${results.length}`)
      if (footnote !== '') console.log(`  ${footnote}`)
      return failures === 0 ? 0 : 1
    },
  }
}

/** dev server 没起就别往下跑了,给一句能直接照做的话。 */
export async function requireDevServer(base) {
  try {
    await fetch(base, { signal: AbortSignal.timeout(3000) })
  } catch {
    console.error(`✗ dev server 不在 ${base}。先起一个:npx vite --port 5173`)
    process.exit(1)
  }
}

#!/usr/bin/env node
/**
 * `pnpm tauri <...>` 的入口 —— 转发给 tauri CLI,顺带补上更新器签名私钥。
 *
 * 为什么需要它:`tauri.conf.json` 配了 `createUpdaterArtifacts` 和 updater 公钥,
 * 所以 `tauri build` 走到「签更新工件」那步会要私钥。而 Tauri **只认环境变量**
 * (`TAURI_SIGNING_PRIVATE_KEY`),不会自己去 `~/.tauri/` 找 —— 于是
 * `pnpm --filter @deepread/desktop tauri build` 报
 * 「A public key has been found, but no private key」。
 *
 * 私钥不存在时**静默跳过**:CI 走 secret、别人 clone 下来没这个文件,都不该因为
 * 缺一个本地密钥就整个失败(那时 tauri 自己会报它该报的错)。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const env = { ...process.env }

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = join(process.env.HOME ?? '', '.tauri/deepread.key')
  if (existsSync(keyPath)) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8')
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
  }
}

// shell: true 是为了在 Windows 上也能找到 pnpm.cmd。
const result = spawnSync('pnpm', ['--filter', '@deepread/desktop', 'exec', 'tauri', ...args], {
  stdio: 'inherit',
  shell: true,
  env,
})

process.exit(result.status ?? 1)

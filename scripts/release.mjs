#!/usr/bin/env node
/**
 * Deepread release pipeline (spec §56/§138, Phase 8).
 *
 * Local-first: runs the full gate set, builds the release bundle, collects
 * artifacts with SHA-256 checksums, and assembles the updater manifest
 * (latest.json) when updater artifacts exist (they require the updater
 * signing key via TAURI_SIGNING_PRIVATE_KEY — see docs/release.md).
 *
 * Usage:
 *   node scripts/release.mjs            # gates + build + collect
 *   node scripts/release.mjs --skip-gates
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const conf = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'))
const version = conf.version
const outDir = join(root, 'release', `v${version}`)

/** Run a command and abort the release on non-zero exit. */
function must(cmd) {
  console.log(`\n$ ${cmd}`)
  const result = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root })
  if (result.status !== 0) {
    console.error(`\n[x] "${cmd}" failed with exit code ${result.status} — aborting release.`)
    process.exit(result.status ?? 1)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function collect(dir, into) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        // Ship .app directories zipped (unsigned local distribution).
        const zip = join(into, `${entry.name}.zip`)
        must(`ditto -c -k --sequesterRsrc --keepParent "${full}" "${zip}"`)
      } else {
        collect(full, into)
      }
    } else if (/\.(dmg|msi|exe|appimage|deb|rpm|sig|tar\.gz|zip)$/.test(entry.name)) {
      cpSync(full, join(into, entry.name))
    }
  }
}

// ---------- 1. gates ----------
if (!process.argv.includes('--skip-gates')) {
  must('pnpm lint')
  must('pnpm format:check')
  must('pnpm typecheck')
  must('pnpm test')
  must('cargo fmt --all -- --check')
  must('cargo clippy --workspace --all-targets -- -D warnings')
  must('cargo test --workspace')
} else {
  console.log('Skipping gates (--skip-gates).')
}

// ---------- 2. build ----------
// The updater key is auto-detected so local releases sign updater artifacts
// without extra setup; CI passes TAURI_SIGNING_PRIVATE_KEY as a secret.
const env = { ...process.env }
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const localKey = join(process.env.HOME ?? '', '.tauri/deepread.key')
  if (existsSync(localKey)) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(localKey, 'utf8')
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    console.log('Using updater signing key from ~/.tauri/deepread.key')
  }
}
const build = (cmd) => {
  console.log(`\n$ ${cmd}`)
  const result = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root, env })
  if (result.status !== 0) {
    console.error(`\n[x] "${cmd}" failed with exit code ${result.status} — aborting release.`)
    process.exit(result.status ?? 1)
  }
}
if (process.platform === 'darwin') {
  // dmg bundling needs Finder/AppleScript; app bundle is enough locally.
  build('pnpm tauri build --bundles app')
} else {
  build('pnpm tauri build')
}

// ---------- 3. collect + checksums ----------
mkdirSync(outDir, { recursive: true })
const bundleDir = join(root, 'target/release/bundle')
collect(bundleDir, outDir)

const files = readdirSync(outDir)
const sums = files
  .filter((name) => !name.endsWith('.sha256'))
  .map((name) => {
    const digest = sha256(join(outDir, name))
    writeFileSync(join(outDir, `${name}.sha256`), `${digest}  ${name}\n`)
    return `${digest}  ${name}`
  })
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`)

// ---------- 4. updater manifest (spec §56) ----------
const signed = files.some((name) => name.endsWith('.sig'))
const confDist = join(root, 'apps/desktop/dist')
if (signed && existsSync(confDist)) {
  // The bundler already produced *.tar.gz/.msi.zip + .sig pairs; map them into
  // a latest.json per Tauri updater platform keys.
  const platforms = {}
  // The bundler names updater artifacts after the product; map by platform.
  const suffixes =
    process.platform === 'darwin'
      ? [['.app.tar.gz', `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`]]
      : process.platform === 'win32'
        ? [
            ['x64.msi.zip', 'windows-x86_64'],
            ['x64-setup.exe.zip', 'windows-x86_64'],
            ['arm64-setup.exe.zip', 'windows-aarch64'],
          ]
        : [['AppImage.tar.gz', 'linux-x86_64']]
  for (const [suffix, key] of suffixes) {
    const artifact = files.find((name) => name.endsWith(suffix))
    const signature = files.find((name) => name.endsWith(`${suffix}.sig`))
    if (artifact && signature) {
      platforms[key] = {
        signature: readFileSync(join(outDir, signature), 'utf8').trim(),
        url: `https://your-update-host/deepread/v${version}/${artifact}`,
      }
    }
  }
  if (Object.keys(platforms).length > 0) {
    writeFileSync(
      join(outDir, 'latest.json'),
      JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n',
    )
    console.log('\nlatest.json generated — replace the URL host with your update host.')
  }
} else if (!signed) {
  console.log(
    '\n[!] No updater signatures found: set TAURI_SIGNING_PRIVATE_KEY (and optional ' +
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD) before building to produce .sig updater artifacts.',
  )
}

console.log(`\n✅ Release v${version} artifacts in ${outDir}:`)
for (const name of readdirSync(outDir)) console.log(`  ${name}`)

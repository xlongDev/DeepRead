/**
 * 同步 PDF.js 支持资产:CJK cmaps + standard fonts → 应用静态目录,以及
 * pdf.worker.min.mjs → reader-adapter 的 vendor 目录(pdf-book.ts 经
 * import.meta.url 引用,Vite 打包进产物)。
 *
 * Runs automatically on pnpm install (root "postinstall"). **Version-aware**:
 * pdfjs-dist 升级而 vendor 文件没跟时会硬失败 —— worker 与 API 的版本号
 * 必须完全一致,否则 PDF.js 拒绝启动(实测报错「The API version "6.4.299"
 * does not match the Worker version "6.3.289"」,书打不开、封面也提不出)。
 * 以 package.json 的版本为真值,戳文件不一致就重拷;worker 刷新后会出现在
 * git diff 里,随依赖升级一起提交即可。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(
  readFileSync(
    join(repoRoot, 'packages/reader-adapter/node_modules/pdfjs-dist/package.json'),
    'utf8',
  ),
)
const version = pkg.version
const source = join(repoRoot, 'packages/reader-adapter/node_modules/pdfjs-dist')

const staticDir = join(repoRoot, 'apps/desktop/public/pdfjs')
const staticStamp = join(staticDir, '.pdfjs-version')
const vendorWorker = join(
  repoRoot,
  'packages/reader-adapter/src/books/vendor/pdfjs/pdf.worker.min.mjs',
)
const vendorStamp = join(vendorWorker, '../.pdfjs-version')

const stale = (stamp) => !existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== version

let touched = false

if (!existsSync(source)) {
  console.log('[copy-pdfjs-assets] pdfjs-dist not installed yet — skipping')
} else {
  // ① cmaps + standard_fonts → public/pdfjs(CJK PDF 没有它们就是白页)。
  if (stale(staticStamp)) {
    mkdirSync(staticDir, { recursive: true })
    cpSync(join(source, 'cmaps'), join(staticDir, 'cmaps'), { recursive: true })
    cpSync(join(source, 'standard_fonts'), join(staticDir, 'standard_fonts'), {
      recursive: true,
    })
    writeFileSync(staticStamp, `${version}\n`)
    console.log(`[copy-pdfjs-assets] cmaps + standard_fonts → ${staticDir} (pdfjs-dist ${version})`)
    touched = true
  }
  // ② worker → vendor 目录(与安装的 pdfjs-dist 同版本,硬约束)。
  if (stale(vendorStamp)) {
    mkdirSync(dirname(vendorWorker), { recursive: true })
    cpSync(join(source, 'build/pdf.worker.min.mjs'), vendorWorker)
    writeFileSync(vendorStamp, `${version}\n`)
    console.log(`[copy-pdfjs-assets] pdf.worker.min.mjs (${version}) → vendor/`)
    console.log('[copy-pdfjs-assets] ⚠ vendor worker 更新了,记得随依赖升级一起 git commit')
    touched = true
  }
  if (!touched) {
    console.log(`[copy-pdfjs-assets] up to date (pdfjs-dist ${version})`)
  }
}

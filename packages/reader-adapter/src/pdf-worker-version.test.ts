import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * pdfjs API 与 worker 的版本必须严格一致:不一致时 PDF.js 直接拒绝启动
 * (实测 6.4.299 的 API 配 6.3.289 的 worker = 所有 PDF 打不开、封面提不出,
 * 报「The API version does not match the Worker version」)。
 * 这条测试把「升级 pdfjs-dist 却忘了刷新 vendored worker」钉死在 CI;
 * postinstall 的 copy-pdfjs-assets.mjs 负责自动刷新,双保险。
 */
describe('vendored pdf worker 与 pdfjs-dist 同版本', () => {
  it('vendor/pdfjs/pdf.worker.min.mjs 含有 pdfjs-dist 当前的版本号', () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version: string }
    const worker = readFileSync(
      fileURLToPath(new URL('./books/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url)),
      'utf8',
    )
    expect(worker).toContain(pkg.version)
  })
})

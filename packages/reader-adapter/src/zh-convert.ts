/**
 * 简繁转换 —— 引擎取自 readest 的 simplecc-wasm(OpenCC 词表的 wasm 重写,
 * vendor 于 packages/reader-adapter/src/books/vendor/simplecc/)。
 *
 * wasm 约 1.1MB,只在用户开启转换时懒加载一次,不进启动路径;初始化完成后
 * 转换是同步调用 —— FoliateAdapter 在内核 load 钩子(量版/渲染之前)同步改
 * 写文本节点,所以必须先把 wasm 备好。
 */

import type { ZhConvertVariant } from '@deepread/reader-core'

type SimpleccModule = typeof import('./books/vendor/simplecc/simplecc_wasm.js')

let modulePromise: Promise<SimpleccModule> | null = null
let readyModule: SimpleccModule | null = null

/** 预热并保持模块引用;重复调用幂等。 */
export function prepareZhConvert(): Promise<void> {
  if (!modulePromise) {
    modulePromise = import('./books/vendor/simplecc/simplecc_wasm.js').then(async (mod) => {
      // 不传路径:glue 回退到 `new URL('simplecc_wasm_bg.wasm', import.meta.url)`,
      // Vite 会把相邻的 wasm 作为资源一并产出(readest #6368 的同一结论)。
      await mod.default()
      readyModule = mod
      return mod
    })
  }
  return modulePromise.then(() => undefined)
}

/** 单段文本转换;wasm 未就绪时原样返回(下次 load 前调用方已 await 预热)。 */
export function convertZhText(text: string, variant: ZhConvertVariant): string {
  if (variant === 'none' || !readyModule) return text
  return readyModule.simplecc(text, variant)
}

/**
 * 在 section 文档上做文本级简繁转换。跳过 SCRIPT/STYLE 与空白节点,
 * 只动 textContent —— 元素结构与 CFI 锚点不受影响。
 * 供内核 load 钩子同步调用(此时分页器还没量版)。
 */
export function convertSectionDocument(doc: Document, convert: (text: string) => string): void {
  const root = doc.body ?? doc.documentElement
  if (!root) return
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
        return NodeFilter.FILTER_REJECT
      }
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const nodes: Text[] = []
  let current: Node | null
  while ((current = walker.nextNode())) nodes.push(current as Text)
  for (const node of nodes) {
    const original = node.textContent
    if (original) node.textContent = convert(original)
  }
}

/**
 * 封面缓存 —— 一套 API,两个后端。
 *
 * 桌面端:Rust 把提取出的封面写在数据库旁边,第二次绘制书架是读文件,而不是
 * 再解一次 zip / 渲染一次 PDF。
 * 浏览器端:`library.cover.get/put` 在 `ipc.ts` 被分流到 IndexedDB(见
 * `web-handlers.ts`)。
 *
 * 这里过去自己开过一个 `deepread-covers` 库 —— 那个分支已经删掉了:现在两套
 * 存储会并存,「封面到底存在哪、该清哪一个」就变成没法回答的问题。
 */

import { invokeCommand } from './ipc'
import { convertFileSrc } from './book-import'

/** Cached cover as a usable image URL, or null when it still has to be extracted. */
export async function readCachedCover(hash: string): Promise<string | null> {
  const response = await invokeCommand('library.cover.get', { bookHash: hash })
  return response.path === null || response.path === undefined
    ? null
    : convertFileSrc(response.path)
}

/** Persist a freshly extracted cover (input is the object URL from extractCover). */
export async function writeCachedCover(hash: string, objectUrl: string): Promise<void> {
  const blob = await fetch(objectUrl).then((response) => response.blob())
  await invokeCommand('library.cover.put', { bookHash: hash, data: await toBase64(blob) })
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      // Strip the "data:<type>;base64," prefix — Rust wants raw base64.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

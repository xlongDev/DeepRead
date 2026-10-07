/**
 * Blob / base64 互转 —— 原先在 web-store / web-handlers / cover-store 各长
 * 过一份的公共底层,收拢到这里。
 *
 * 方向约定:落库(Rust 侧与 IndexedDB 备份快照)永远收**裸 base64**;
 * 渲染(<img>、iframe)才需要带 MIME 的 Blob。
 */

/** Blob → 裸 base64(剥掉 "data:<type>;base64," 前缀 —— Rust 要裸的)。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 裸 base64 → Blob(不带 MIME:备份里没有 MIME 信息,字节本身才是有用的)。 */
export function base64ToBlob(base64: string): Blob {
  return new Blob([base64ToBytes(base64)])
}

/** base64 → Blob,嗅出图片 MIME —— 封面要能喂给 <img>,空 type 的 Blob 不渲染。 */
export function base64ToImageBlob(base64: string): Blob {
  const bytes = base64ToBytes(base64)
  return new Blob([bytes], { type: sniffImageType(bytes) })
}

function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  // RIFF....WEBP
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) return 'image/webp'
  return 'image/png'
}

/**
 * 增量 SHA-256 —— 浏览器备份路径原来把整份快照字符串一次性 encode 进内存
 * 再喂 `crypto.subtle.digest`,书库大了之后峰值内存跟着全文翻倍。这里按块
 * 喂同一个滚动状态,峰值内存从 O(全文) 降到 O(块)。
 *
 * 纯算术实现,浏览器与 Node 同结果;正确性由 hash.test.ts 的 NIST 标准向量
 * 与 `crypto.subtle` 交叉验证锁定。
 */

// FIPS 180-4 的轮常量表,原样罗列。
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/** 滚动式 SHA-256:`update()` 随便喂多少次,`digestHex()` 终结输出小写十六进制。 */
export class Sha256 {
  readonly #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  readonly #block = new Uint8Array(64)
  #blockLength = 0
  #totalBytes = 0

  update(data: Uint8Array): this {
    this.#totalBytes += data.length
    let offset = 0
    if (this.#blockLength > 0) {
      const take = Math.min(64 - this.#blockLength, data.length)
      this.#block.set(data.subarray(0, take), this.#blockLength)
      this.#blockLength += take
      offset = take
      if (this.#blockLength === 64) {
        this.#compress(this.#block)
        this.#blockLength = 0
      }
    }
    while (offset + 64 <= data.length) {
      this.#compress(data.subarray(offset, offset + 64))
      offset += 64
    }
    if (offset < data.length) {
      this.#block.set(data.subarray(offset), 0)
      this.#blockLength = data.length - offset
    }
    return this
  }

  digestHex(): string {
    // 总比特数拆成高低两个 32 位字:bits = bytes * 8,低字 = (bytes % 2^29) * 8。
    const low = (this.#totalBytes % 0x20000000) * 8
    const high = Math.floor(this.#totalBytes / 0x20000000)
    // 补位:0x80 + 若干 0 + 8 字节大端比特数,凑齐 64 的倍数。
    const zeros = (55 - this.#blockLength + 64) % 64
    const tail = new Uint8Array(1 + zeros + 8)
    tail[0] = 0x80
    const view = new DataView(tail.buffer)
    view.setUint32(tail.length - 8, high)
    view.setUint32(tail.length - 4, low)
    this.update(tail)
    return Array.from(this.#state)
      .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
      .join('')
  }

  #compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, 64)
    const w = new Uint32Array(64)
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let a = this.#state[0]!
    let b = this.#state[1]!
    let c = this.#state[2]!
    let d = this.#state[3]!
    let e = this.#state[4]!
    let f = this.#state[5]!
    let g = this.#state[6]!
    let h = this.#state[7]!
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    this.#state[0] = (this.#state[0]! + a) | 0
    this.#state[1] = (this.#state[1]! + b) | 0
    this.#state[2] = (this.#state[2]! + c) | 0
    this.#state[3] = (this.#state[3]! + d) | 0
    this.#state[4] = (this.#state[4]! + e) | 0
    this.#state[5] = (this.#state[5]! + f) | 0
    this.#state[6] = (this.#state[6]! + g) | 0
    this.#state[7] = (this.#state[7]! + h) | 0
  }
}

/**
 * 对任意长度文本流式求 SHA-256,避免一次性 encode 全文。
 * 块边界避开代理对 —— 独代理会被 TextEncoder 编成 U+FFFD,哈希就静默错了。
 */
export function sha256HexOfText(text: string, chunkChars = 1 << 20): string {
  const hasher = new Sha256()
  const encoder = new TextEncoder()
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length)
    if (end < text.length) {
      const last = text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        // 块尾是高代理:本块收不下它的低代理。回退一位让整对进下一块;
        // 但块只有这一个字符时回退会死循环,改为向后吞下低代理。
        if (end - start > 1) end -= 1
        else end += 1
      }
    }
    hasher.update(encoder.encode(text.slice(start, end)))
    start = end
  }
  return hasher.digestHex()
}

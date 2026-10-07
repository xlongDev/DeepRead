import { describe, expect, it } from 'vitest'
import { Sha256, sha256HexOfText } from './hash'

/** FIPS 180-4 与 NIST 公布的标准向量 —— 实现错一个位都会在这里现形。 */
const NIST_VECTORS: readonly { readonly input: string; readonly hex: string }[] = [
  { input: '', hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  { input: 'abc', hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  {
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
]

async function subtleHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('Sha256', () => {
  it.each(NIST_VECTORS)('matches the NIST vector for %j', ({ input, hex }) => {
    expect(new Sha256().update(new TextEncoder().encode(input)).digestHex()).toBe(hex)
  })

  it('handles the one-million-"a" vector', () => {
    const input = 'a'.repeat(1_000_000)
    expect(sha256HexOfText(input, 100_000)).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it.each([1, 5, 55, 56, 63, 64, 65, 100, 1000])(
    'feeds incrementally in %i-byte chunks and agrees with crypto.subtle',
    async (chunk) => {
      const text = '深读 incremental hashing —— 块边界与 64 字节对齐都要过一遍。'.repeat(9)
      const bytes = new TextEncoder().encode(text)
      const hasher = new Sha256()
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        hasher.update(bytes.subarray(offset, offset + chunk))
      }
      expect(hasher.digestHex()).toBe(await subtleHex(bytes))
    },
  )

  it('digestHex is safe to read once after any number of updates', () => {
    const hasher = new Sha256()
    hasher.update(new Uint8Array(64))
    hasher.update(new Uint8Array(3))
    expect(hasher.digestHex()).toHaveLength(64)
  })
})

describe('sha256HexOfText', () => {
  it('matches crypto.subtle on the whole text even with tiny chunks', async () => {
    const text = '书架、封面、进度:一份会很大的备份快照。'.repeat(500)
    expect(await subtleHex(new TextEncoder().encode(text))).toBe(sha256HexOfText(text, 7))
  })

  it('never splits surrogate pairs at chunk boundaries', async () => {
    // "📚" 是代理对;chunk=3 一定会有人想去劈开它 —— 劈开就编成 U+FFFD,哈希错。
    const text = 'ab📚cd'.repeat(40)
    expect(await subtleHex(new TextEncoder().encode(text))).toBe(sha256HexOfText(text, 3))
  })
})

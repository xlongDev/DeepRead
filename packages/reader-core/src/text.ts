/**
 * 纯文本度量与阅读速度估算(域层,无 IO)。
 * 字数口径与 UI 展示一致:中日韩字符按字计,连续西文按词计。
 */

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g

export function countChars(text: string): number {
  const cjk = (text.match(CJK_PATTERN) ?? []).length
  const latinWords = (text.replace(CJK_PATTERN, ' ').match(/[A-Za-z0-9'’-]+/g) ?? []).length
  return cjk + latinWords
}

/** 仅统计中日韩字符数(用于中英混排的加权阅读速度)。 */
export function countCjkChars(text: string): number {
  return (text.match(CJK_PATTERN) ?? []).length
}

/**
 * 大数字带单位缩写:≥1亿 → x.x亿,≥1万 → x.x万(整万不带小数),
 * 其余千分位。用于底栏字数(全书动辄几十万字)。
 */
export function formatCharCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  if (count >= 100_000_000) {
    const yi = count / 100_000_000
    return `${yi >= 100 ? Math.round(yi) : Number(yi.toFixed(1))}亿`
  }
  if (count >= 10_000) {
    const wan = count / 10_000
    return `${wan >= 100 ? Math.round(wan) : Number(wan.toFixed(1))}万`
  }
  return count.toLocaleString('zh-Hans-CN')
}

/**
 * 剩余阅读时间(分钟):中英混排加权——CJK 按 ~400 字/分钟,西文按
 * ~250 词/分钟(foliate 内核 sizePerLoc≈1500 字节的隐含口径一致)。
 * 传全书实测的 CJK/西文单位数,比按书籍语言标签猜测更准。
 */
export function estimateReadingMinutes(cjkUnits: number, otherUnits: number): number {
  return Math.max(1, Math.round(cjkUnits / 400 + otherUnits / 250))
}

/** 分钟 → 中文时长标签:<1 分钟、N 分钟、X 小时 Y 分钟。 */
export function formatDurationLabel(minutes: number, prefix = '约剩'): string {
  if (minutes < 1) return '不足 1 分钟'
  if (minutes < 60) return `${prefix} ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${prefix} ${hours} 小时` : `${prefix} ${hours} 小时 ${rest} 分钟`
}

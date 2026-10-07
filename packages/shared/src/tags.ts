/**
 * 标签规范化的前端唯一源 —— 镜像 Rust `library.rs::set_tags` 的规则:
 * trim、丢空、**超长丢弃**(不是截断)、去重、总量上限。
 * 字符计数按 Unicode scalar(JS code point)对齐 Rust 的 `chars().count()`。
 *
 * 改这条规则必须两侧同步:Rust `set_tags` ↔ 本文件(+ 各自测试)。
 */

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 32

/** 与 Rust `set_tags` 同一套规范化(存储写入口径)。 */
export function normalizeTags(tags: readonly string[]): readonly string[] {
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag === '' || [...tag].length > MAX_TAG_LENGTH) continue
    if (result.includes(tag)) continue
    result.push(tag)
    if (result.length >= MAX_TAGS) break
  }
  return result
}

/**
 * 解析标签输入框:中英文逗号 / 分号 / 斜杠 / 顿号 / 空白都算分隔符。
 * 解析结果即落库结果 —— 走的是同一套 normalize。
 */
export function parseTagInput(raw: string): readonly string[] {
  return normalizeTags(raw.split(/[,，;；/、\s]+/))
}

/**
 * TXT 章节规则的读写(spec §15)。
 *
 * 两个平台走同一条命令 —— 桌面端落到 SQLite 的 `app_settings` KV(键
 * `chapter.rules`,JSON 数组,随备份的 VACUUM INTO 全量快照走),浏览器端在
 * `lib/ipc.ts` 被分流到 localStorage(见 `web-handlers.ts`)。
 *
 * 规则是纯数据:能不能编译、有没有灾难性回溯风险,由 ai-core 在 UI 保存前判定
 * (见 `chapter-rules.ts` 的 validateChapterPattern);Rust 只做形状校验。
 */

import type { ChapterRule as WireChapterRule } from '@deepread/shared'
import type { ChapterRule } from '@deepread/ai-core'
import { invokeCommand } from './ipc'

// 编译期漂移断言:ai-core 的逻辑类型与 ts-rs 生成的线类型必须互为子类型,
// 否则 Rust 改字段时这里先红,而不是等到运行时形状不符。
type WireParity = [ChapterRule] extends [WireChapterRule]
  ? [WireChapterRule] extends [ChapterRule]
    ? true
    : '线类型与逻辑类型漂移(方向二)'
  : '线类型与逻辑类型漂移(方向一)'
const wireParity: WireParity = true
void wireParity

export async function loadChapterRules(): Promise<readonly ChapterRule[]> {
  const response = await invokeCommand('chapter.rules.get', undefined)
  return response.rules
}

/** 返回落库后的生效规则(形状非法的条目在 Rust 侧已被剔除)。 */
export async function saveChapterRules(
  rules: readonly ChapterRule[],
): Promise<readonly ChapterRule[]> {
  const response = await invokeCommand('chapter.rules.set', { rules: [...rules] })
  return response.rules
}

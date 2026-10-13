/**
 * User-defined TXT chapter rules (spec §15, B7.2).
 *
 * The built-in rule (rag.ts) covers "第 N 章"-style titles; web novels with
 * irregular naming need custom patterns. Rules are pure data: validation,
 * merging and preview all happen here so the editor, the adapter and the
 * tests share one implementation. Patterns are only ever executed by the
 * webview's RegExp — the static checks below exist to keep catastrophic
 * backtracking (frozen UI) out of that engine.
 */

import { z } from 'zod'
import { extractJsonObject } from './insights'
import { BUILT_IN_CHAPTER_PATTERN } from './rag'

export interface ChapterRule {
  readonly id: string
  readonly name: string
  /** Regex source; matched against a whole trimmed paragraph. */
  readonly pattern: string
  /** Higher runs first; ties keep list order. */
  readonly priority: number
  readonly enabled: boolean
}

export const MAX_PATTERN_CHARS = 200
export const MAX_RULES = 20
/** Paragraphs longer than this never count as titles (mirrors the built-in). */
export const MAX_TITLE_CHARS = 60

/** The built-in rule: lowest priority so user rules claim lines first. */
export const BUILT_IN_CHAPTER_RULE: ChapterRule = {
  id: 'built-in',
  name: '内置规则',
  pattern: BUILT_IN_CHAPTER_PATTERN.source,
  priority: 0,
  enabled: true,
}

/**
 * Nested *unbounded* quantifiers like `(a+)+` / `(a*)*` / `(a{2,})+` make
 * backtracking engines blow up on non-matching input. Bounded groups such as
 * `(?:[\s：:].{0,30})?` are safe and must stay allowed — the built-in rule
 * uses them. JS has no regex timeout, so the only defense is refusing to
 * store the dangerous shapes; the check is deliberately conservative and may
 * reject odd-but-safe patterns, which is fine: the user gets a clear message
 * instead of a frozen reader.
 */
const NESTED_UNBOUNDED_QUANTIFIER =
  /\([^()]*(?:[*+]|\{\s*\d+\s*,\s*\})[^()]*\)\s*(?:[*+]|\{\s*\d+\s*,\s*\})/

export function validateChapterPattern(pattern: string): string | null {
  const trimmed = pattern.trim()
  if (trimmed === '') return '正则不能为空。'
  if (trimmed.length > MAX_PATTERN_CHARS) {
    return `正则过长(最多 ${MAX_PATTERN_CHARS} 字符)。`
  }
  try {
    new RegExp(trimmed) // oxlint-disable-line no-new -- compile check only
  } catch {
    return '不是合法的正则表达式。'
  }
  if (NESTED_UNBOUNDED_QUANTIFIER.test(trimmed)) {
    return '检测到嵌套的无界量词(如 (a+)+),有灾难性回溯风险,已拒绝。'
  }
  return null
}

/** Compile one rule; returns null when disabled or invalid. */
export function compileChapterRule(rule: ChapterRule): RegExp | null {
  if (!rule.enabled) return null
  if (validateChapterPattern(rule.pattern) !== null) return null
  return new RegExp(rule.pattern.trim())
}

/**
 * Built-in rule plus user rules; disabled dropped. Sorted by priority
 * descending (stable on ties) so a user rule with priority > 0 claims a line
 * before the built-in does — the built-in is the fallback, not the override.
 */
export function mergeChapterRules(userRules: readonly ChapterRule[]): readonly ChapterRule[] {
  return [BUILT_IN_CHAPTER_RULE, ...userRules]
    .filter((rule) => rule.enabled)
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index)
    .map((entry) => entry.rule)
}

/** First rule (by priority) whose pattern matches the paragraph, else null. */
export function matchChapterRule(
  paragraph: string,
  rules: readonly ChapterRule[],
): ChapterRule | null {
  const trimmed = paragraph.trim()
  if (trimmed === '' || trimmed.length > MAX_TITLE_CHARS) return null
  for (const rule of rules) {
    const regex = compileChapterRule(rule)
    if (regex?.test(trimmed)) return rule
  }
  return null
}

/** Paragraph → title? predicate for the adapter's section splitter. */
export function chapterMatcherFromRules(
  rules: readonly ChapterRule[],
): (paragraph: string) => boolean {
  const merged = mergeChapterRules(rules)
  const compiled = merged
    .map((rule) => ({ rule, regex: compileChapterRule(rule) }))
    .filter((entry): entry is { rule: ChapterRule; regex: RegExp } => entry.regex !== null)
  return (paragraph) => {
    const trimmed = paragraph.trim()
    if (trimmed === '' || trimmed.length > MAX_TITLE_CHARS) return false
    return compiled.some((entry) => entry.regex.test(trimmed))
  }
}

export interface RulePreviewHit {
  /** Index into the sampled lines. */
  readonly lineIndex: number
  readonly line: string
}

export interface RulePreview {
  readonly rule: ChapterRule
  /** Lines this rule claims (earlier rules win, so counts do not double up). */
  readonly hits: readonly RulePreviewHit[]
  /** Non-null when the pattern is invalid — shown instead of hits. */
  readonly error: string | null
}

/**
 * Dry-run the merged rules over sample lines: every line is claimed by the
 * first matching rule (priority order), so per-rule counts are honest. The
 * editor refuses to save while any rule has an error.
 */
export function previewChapterRules(
  lines: readonly string[],
  userRules: readonly ChapterRule[],
): readonly RulePreview[] {
  const merged = mergeChapterRules(userRules)
  const claimed = new Map<number, string>()
  return merged.map((rule) => {
    const error = validateChapterPattern(rule.pattern)
    if (error !== null) return { rule, hits: [], error }
    const regex = new RegExp(rule.pattern.trim())
    const hits: RulePreviewHit[] = []
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.length > MAX_TITLE_CHARS) return
      if (claimed.has(lineIndex)) return
      if (regex.test(trimmed)) {
        claimed.set(lineIndex, rule.id)
        hits.push({ lineIndex, line: trimmed })
      }
    })
    return { rule, hits, error: null }
  })
}

/* ---------- AI candidate rules (spec §15: auditable, never auto-saved) ---------- */

const AI_SAMPLE_LINES = 40
const MAX_CANDIDATES = 5

export const chapterRuleCandidateSchema = z.object({
  name: z.string().min(1).max(40),
  pattern: z.string().min(1).max(MAX_PATTERN_CHARS),
  priority: z.number().int().min(0).max(1000),
})

export type ChapterRuleCandidate = z.output<typeof chapterRuleCandidateSchema>

/**
 * Ask the model to infer chapter rules from sample lines. Candidates are
 * drafts: they enter the editor unvalidated and must survive the same forced
 * preview (compile + backtracking check) before the user can save them.
 */
export function buildChapterRuleMessages(
  sampleLines: readonly string[],
  title: string,
): readonly { role: 'system' | 'user'; content: string }[] {
  const sample = sampleLines.slice(0, AI_SAMPLE_LINES).join('\n')
  return [
    {
      role: 'system',
      content: [
        `你是读书助手。以下是《${title}》开头若干行(并非全书)。`,
        '推断这本书的章节标题格式,输出严格 JSON(无其他文字):',
        '{"rules":[{"name":"规则名(如:第N卷)","pattern":"匹配整段标题行的正则(不要 ^$ 锚点以外的分组捕获)","priority":10}]}',
        `最多 ${MAX_CANDIDATES} 条;pattern 必须是合法正则且避免嵌套量词;没把握就少给。`,
      ].join('\n'),
    },
    { role: 'user', content: sample },
  ]
}

/** Parse + validate AI-proposed rule candidates. */
export function parseChapterRuleCandidates(text: string): readonly ChapterRuleCandidate[] {
  const parsed = z
    .object({ rules: z.array(chapterRuleCandidateSchema).max(MAX_CANDIDATES) })
    .parse(extractJsonObject(text))
  return parsed.rules
}

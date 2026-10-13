/**
 * Shared anchoring for AI find/replace proposals (spec §35 AI 校对 · plan-v0.3
 * §B5.3 繁简转换).
 *
 * The model never rewrites the book: it proposes *targeted* find/replace pairs,
 * every pair is validated against the real text (exact occurrence count) before
 * it can be shown, and application happens only for user-accepted items on
 * verified matches. That "检测-应用分离" contract is what both features share —
 * only the prompt and the label differ.
 */

import { z } from 'zod'

export const findReplaceSchema = z.object({
  corrections: z
    .array(
      z.object({
        find: z.string().min(1).max(500),
        replace: z.string().max(500),
        reason: z.string().max(500),
      }),
    )
    .max(100),
})

export interface AnchoredProposal {
  readonly find: string
  readonly replace: string
  readonly reason: string
  /** How many times `find` occurs in the source text (0 → invalid, dropped). */
  readonly occurrences: number
}

export interface IdentifiedProposal extends AnchoredProposal {
  readonly id: string
}

/** What the model hands over before anchoring (see findReplaceSchema). */
export interface ProposalDraft {
  readonly find: string
  readonly replace: string
  readonly reason: string
}

/** Pull the JSON object out of model output (fences and chatter tolerated). */
export function parseFindReplace(text: string): z.output<typeof findReplaceSchema> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const parsed = findReplaceSchema.safeParse(JSON.parse(candidate.slice(start, end + 1)))
  return parsed.success ? parsed.data : null
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let position = haystack.indexOf(needle)
  while (position !== -1) {
    count++
    position = haystack.indexOf(needle, position + needle.length)
  }
  return count
}

function hash(text: string): string {
  let value = 0
  for (let i = 0; i < text.length; i++) {
    value = (value * 31 + text.charCodeAt(i)) | 0
  }
  return (value >>> 0).toString(36)
}

/**
 * Validate raw items and anchor each one in the real text. Items whose `find`
 * is absent (or identical to `replace`) are dropped — a proposal the text
 * cannot back is worse than no proposal.
 */
export function anchorFindReplace<T extends ProposalDraft>(
  items: readonly T[],
  source: string,
  idPrefix: string,
): readonly (T & IdentifiedProposal)[] {
  const result: (T & IdentifiedProposal)[] = []
  for (const item of items) {
    const occurrences = countOccurrences(source, item.find)
    if (occurrences === 0) continue
    if (item.find === item.replace) continue
    result.push({
      ...item,
      id: `${idPrefix}-${result.length}-${hash(item.find + item.replace)}`,
      occurrences,
    })
  }
  return result
}

export interface ApplyOutcome {
  readonly text: string
  readonly applied: number
  readonly skipped: number
}

/**
 * Apply only accepted proposals whose find is unique in the text. Re-verified
 * against the *current* text: earlier replacements may have consumed or
 * altered overlapping matches.
 */
export function applyAnchored<T extends IdentifiedProposal>(
  text: string,
  proposals: readonly T[],
  acceptedIds: readonly string[],
): ApplyOutcome {
  const accepted = new Set(acceptedIds)
  let output = text
  let applied = 0
  let skipped = 0
  for (const proposal of proposals) {
    if (!accepted.has(proposal.id)) continue
    const occurrences = countOccurrences(output, proposal.find)
    if (occurrences !== 1) {
      skipped++
      continue
    }
    output = output.replace(proposal.find, proposal.replace)
    applied++
  }
  return { text: output, applied, skipped }
}

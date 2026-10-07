/**
 * Text repair rules for plain-text books (spec §14 第一批: 硬换行修复 + 空白
 * 清理). Detection and application are separate: `computeProposals` returns
 * non-overlapping proposals, the UI lets the user accept/reject each one, and
 * `applyRepair` rebuilds the text honoring only the accepted set — no
 * modification ever happens without review (spec §19).
 *
 * # ponytail: paragraph-level diff granularity is enough for these rules;
 * word-level Myers diff arrives with the full Diff engine (spec §20).
 */

import { isChapterTitle } from '../books/text-book'

export type RepairRule = 'hard-break' | 'spaces'

export interface RepairChange {
  readonly id: string
  readonly rule: RepairRule
  /** Original lines (joined with \n for display). */
  readonly before: string
  /** Proposed replacement (single line). */
  readonly after: string
}

const TERMINAL_PUNCT = /[。！？!?…”"』」）)】\]]\s*$/

function endsSentence(line: string): boolean {
  return TERMINAL_PUNCT.test(line) || line.endsWith('：') || line.endsWith(':')
}

/** Join two lines: no space across a CJK boundary, one space otherwise. */
function joinLines(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const cjkBoundary = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef“”「」『』]$/.test(a)
  return /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef“”「」『』]/.test(b) || cjkBoundary
    ? a + b
    : `${a} ${b}`
}

function cleanSpaces(line: string): string {
  // Collapse doubled/trailing whitespace only — single spaces can be
  // meaningful (章节标题、人名), so they stay.
  return line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '')
}

function isJoinable(line: string): boolean {
  return line.trim().length > 0 && !isChapterTitle(line.trim())
}

interface Proposal {
  readonly id: string
  readonly rule: RepairRule
  readonly start: number
  readonly end: number
  readonly before: string
  readonly after: string
}

function computeProposals(text: string): readonly Proposal[] {
  const lines = text.split('\n')
  const proposals: Proposal[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 硬换行: a run of lines whose sentence continues across the break. A line
    // with trailing whitespace is sloppy spacing, not a hard break.
    const hasTrailingWhitespace = line !== cleanSpaces(line)
    if (isJoinable(line) && !hasTrailingWhitespace && !endsSentence(line)) {
      let end = i
      while (
        end + 1 < lines.length &&
        isJoinable(lines[end + 1] ?? '') &&
        !endsSentence(lines[end] ?? '') &&
        !isChapterTitle((lines[end + 1] ?? '').trim())
      ) {
        end++
      }
      if (end > i) {
        const before = lines.slice(i, end + 1).join('\n')
        let after = lines[i] ?? ''
        for (let k = i + 1; k <= end; k++) after = joinLines(after, lines[k] ?? '')
        proposals.push({
          id: `hard-break-${i}`,
          rule: 'hard-break',
          start: i,
          end,
          before,
          after,
        })
        i = end + 1
        continue
      }
    }

    // 空白清理: doubled internal spaces or trailing whitespace.
    const cleaned = cleanSpaces(line)
    if (cleaned !== line) {
      proposals.push({
        id: `spaces-${i}`,
        rule: 'spaces',
        start: i,
        end: i,
        before: line,
        after: cleaned,
      })
    }
    i++
  }
  return proposals
}

const toChange = (proposal: Proposal): RepairChange => ({
  id: proposal.id,
  rule: proposal.rule,
  before: proposal.before,
  after: proposal.after,
})

/** Rebuild the text applying only the accepted proposals. Proposals are
 * re-derived from the text (ids are deterministic), so the caller only needs
 * the accepted ids it showed the user. */
export function applyRepair(text: string, acceptedIds: readonly string[]): string {
  const accepted = new Set(acceptedIds)
  const proposals = computeProposals(text)
  const lines = text.split('\n')
  const out: string[] = []
  let k = 0
  for (const proposal of proposals) {
    while (k < proposal.start) out.push(lines[k++] ?? '')
    if (accepted.has(proposal.id)) {
      out.push(proposal.after)
    } else {
      for (let j = proposal.start; j <= proposal.end; j++) out.push(lines[j] ?? '')
    }
    k = proposal.end + 1
  }
  while (k < lines.length) out.push(lines[k++] ?? '')
  return out.join('\n')
}

export interface RepairReview {
  readonly proposals: readonly RepairChange[]
  readonly original: string
}

/** Detect everything the rules would change; nothing is modified yet. */
export function reviewRepair(text: string): RepairReview {
  return { proposals: computeProposals(text).map(toChange), original: text }
}

/** Convenience: apply every proposal. */
export function repairText(text: string): RepairResult & { readonly original: string } {
  const proposals = computeProposals(text)
  return {
    original: text,
    text: applyRepair(
      text,
      proposals.map((p) => p.id),
    ),
    changes: proposals.map(toChange),
  }
}

export interface RepairResult {
  readonly text: string
  readonly changes: readonly RepairChange[]
}

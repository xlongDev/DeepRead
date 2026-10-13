import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_CHAPTER_RULE,
  chapterMatcherFromRules,
  compileChapterRule,
  matchChapterRule,
  MAX_RULES,
  mergeChapterRules,
  parseChapterRuleCandidates,
  previewChapterRules,
  validateChapterPattern,
  type ChapterRule,
} from './chapter-rules'

const rule = (overrides: Partial<ChapterRule> & { id: string }): ChapterRule => ({
  name: overrides.id,
  pattern: '第.*章',
  priority: 10,
  enabled: true,
  ...overrides,
})

describe('validateChapterPattern', () => {
  it('accepts ordinary patterns', () => {
    expect(validateChapterPattern('^第\\s*\\d+\\s*章')).toBeNull()
  })

  it('rejects empty, oversized and uncompilable patterns', () => {
    expect(validateChapterPattern('  ')).not.toBeNull()
    expect(validateChapterPattern('x'.repeat(201))).not.toBeNull()
    expect(validateChapterPattern('第(章')).not.toBeNull()
  })

  it('rejects nested quantifiers (catastrophic backtracking)', () => {
    expect(validateChapterPattern('(a+)+')).not.toBeNull()
    expect(validateChapterPattern('(第.*)*')).not.toBeNull()
    expect(validateChapterPattern('(?:x{2,}){3,}')).not.toBeNull()
  })

  it('accepts bounded groups — the built-in rule uses them', () => {
    expect(validateChapterPattern(BUILT_IN_CHAPTER_RULE.pattern)).toBeNull()
    expect(validateChapterPattern('(?:第.{0,30})?\\s*$')).toBeNull()
  })
})

describe('mergeChapterRules', () => {
  it('keeps only the built-in rule when there are no user rules', () => {
    const merged = mergeChapterRules([])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(BUILT_IN_CHAPTER_RULE)
  })

  it('drops disabled rules and sorts by priority (stable on ties)', () => {
    const merged = mergeChapterRules([
      rule({ id: 'a', priority: 5 }),
      rule({ id: 'b', priority: 5, enabled: false }),
      rule({ id: 'c', priority: 20 }),
    ])
    // Priority descending; the built-in rule (0) sorts last so user rules claim first.
    expect(merged.map((r) => r.id)).toEqual(['c', 'a', 'built-in'])
  })
})

describe('matchChapterRule', () => {
  const rules = mergeChapterRules([rule({ id: 'vol', pattern: '^第.+卷', priority: 10 })])

  it('claims a line with the first matching rule by priority', () => {
    expect(matchChapterRule('第一卷 风', rules)?.id).toBe('vol')
    expect(matchChapterRule('第三章 灯', rules)?.id).toBe('built-in')
  })

  it('ignores blank lines, long lines and content that merely contains a marker', () => {
    expect(matchChapterRule('', rules)).toBeNull()
    expect(matchChapterRule('x'.repeat(61), rules)).toBeNull()
    expect(matchChapterRule('他说第三章的事情', rules)).toBeNull()
  })
})

describe('chapterMatcherFromRules', () => {
  it('splits on any enabled rule and ignores disabled ones', () => {
    const matcher = chapterMatcherFromRules([
      rule({ id: 'vol', pattern: '^第.+卷' }),
      rule({ id: 'off', pattern: '^序$', enabled: false }),
    ])
    expect(matcher('第二卷 雪')).toBe(true)
    expect(matcher('序')).toBe(false)
    expect(matcher('第三章 灯')).toBe(true) // built-in still applies
  })

  it('skips invalid patterns instead of throwing', () => {
    const matcher = chapterMatcherFromRules([rule({ id: 'bad', pattern: '第(章' })])
    expect(matcher('第三章 灯')).toBe(true)
  })
})

describe('compileChapterRule', () => {
  it('returns null for disabled or invalid rules', () => {
    expect(compileChapterRule(rule({ id: 'ok' }))).not.toBeNull()
    expect(compileChapterRule(rule({ id: 'off', enabled: false }))).toBeNull()
    expect(compileChapterRule(rule({ id: 'bad', pattern: '第(章' }))).toBeNull()
  })
})

describe('previewChapterRules', () => {
  const lines = ['第一卷 风', '第三章 灯', '他说第三章的事情', '序章', '普通段落']

  it('claims each line once, earlier rules win', () => {
    const preview = previewChapterRules(lines, [rule({ id: 'vol', pattern: '^第.+卷' })])
    const vol = preview.find((entry) => entry.rule.id === 'vol')
    const builtIn = preview.find((entry) => entry.rule.id === 'built-in')
    expect(vol?.hits.map((hit) => hit.line)).toEqual(['第一卷 风'])
    expect(builtIn?.hits.map((hit) => hit.line)).toEqual(['第三章 灯', '序章'])
  })

  it('reports invalid patterns as errors instead of hits', () => {
    const preview = previewChapterRules(lines, [rule({ id: 'bad', pattern: '第(章' })])
    const bad = preview.find((entry) => entry.rule.id === 'bad')
    expect(bad?.error).not.toBeNull()
    expect(bad?.hits).toEqual([])
  })
})

describe('parseChapterRuleCandidates', () => {
  it('parses AI candidates', () => {
    const candidates = parseChapterRuleCandidates(
      '{"rules":[{"name":"第N卷","pattern":"^第.+卷$","priority":10}]}',
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ name: '第N卷', pattern: '^第.+卷$', priority: 10 })
  })

  it('rejects malformed candidate payloads', () => {
    expect(() => parseChapterRuleCandidates('{"rules":[{"name":"x"}]}')).toThrow()
    expect(() => parseChapterRuleCandidates('{"rules":[]}')).not.toThrow()
  })
})

describe('rule budget', () => {
  it('caps the stored rule count', () => {
    expect(MAX_RULES).toBe(20)
  })
})

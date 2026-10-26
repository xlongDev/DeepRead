import { describe, expect, it } from 'vitest'
import {
  buildRagChunks,
  buildRagMessages,
  chunkSectionText,
  citationLabels,
  cosineSimilarity,
  retrieve,
  retrieveByTerms,
} from './rag'

describe('chunkSectionText', () => {
  it('returns short text as one chunk', () => {
    expect(chunkSectionText('短文')).toEqual(['短文'])
    expect(chunkSectionText('   ')).toEqual([])
  })

  it('splits long text on paragraph bounds with overlap', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `段落${i}。${'x'.repeat(200)}`)
    const chunks = chunkSectionText(paragraphs.join('\n\n'))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true)
  })
})

describe('buildRagChunks', () => {
  it('labels multi-piece sections with an index suffix', () => {
    const longText = '段落。'.repeat(300)
    const chunks = buildRagChunks([
      { label: '第一章', text: '短' },
      { label: '第二章', text: longText },
    ])
    expect(chunks[0]?.label).toBe('第一章')
    expect(chunks[1]?.label).toBe('第二章(1)')
    expect(chunks[1]?.text.length).toBeGreaterThan(0)
  })
})

describe('cosineSimilarity', () => {
  it('computes 1 for identical, 0 for orthogonal, 0 for empty', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([], [1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('retrieve', () => {
  const chunks = [
    { label: 'a', text: '灯', vector: [1, 0, 0] },
    { label: 'b', text: '信', vector: [0, 1, 0] },
    { label: 'c', text: '雪', vector: [0.9, 0.1, 0] },
  ]

  it('returns top-k sorted by score', () => {
    const result = retrieve(chunks, [1, 0, 0], 2)
    expect(result.map((r) => r.label)).toEqual(['a', 'c'])
  })

  it('drops chunks below minScore', () => {
    const result = retrieve(chunks, [0, 0, 1], 3)
    expect(result.map((r) => r.label)).toEqual([])
  })
})

describe('retrieveByTerms(离线兜底)', () => {
  const chunks = [
    { label: '第一章', text: '镇上的人把灯点亮。', vector: [] },
    { label: '第二章', text: 'The letter arrived at night.', vector: [] },
    { label: '第三章', text: '雪落在灯塔上。', vector: [] },
  ]

  it('中文 bigram 命中:包含查询双字的 chunk 排前', () => {
    const result = retrieveByTerms(chunks, '灯塔在哪', 3)
    // 「灯塔」只命中第三章;「塔在」「在哪」无处命中 → 只返回第三章。
    expect(result.map((r) => r.label)).toEqual(['第三章'])
    expect(result[0]?.score).toBeCloseTo(1 / 3)
  })

  it('拉丁整词命中且大小写不敏感', () => {
    const result = retrieveByTerms(chunks, 'LETTER night', 3)
    expect(result.map((r) => r.label)).toEqual(['第二章'])
  })

  it('没有任何词条命中时返回空,提示词拿到「未检索到」的诚实分支', () => {
    expect(retrieveByTerms(chunks, 'totally unrelated words here')).toEqual([])
  })

  it('单字查询回退到字本身', () => {
    const result = retrieveByTerms(chunks, '雪', 3)
    expect(result.map((r) => r.label)).toEqual(['第三章'])
  })

  it('标点与空白不产生词条', () => {
    expect(retrieveByTerms(chunks, '?!。 ')).toEqual([])
  })
})

describe('buildRagMessages', () => {
  it('embeds numbered fragments and the citation rule in the system prompt', () => {
    const messages = buildRagMessages('灯象征什么?', [
      { label: '第一章', text: '镇上的人把灯点亮。', score: 0.9 },
      { label: '第二章', text: '信到了。', score: 0.5 },
    ])
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('[1] 第一章')
    expect(messages[0]?.content).toContain('[2] 第二章')
    expect(messages[0]?.content).toContain('标注所引用片段的编号')
    expect(messages[messages.length - 1]?.content).toBe('灯象征什么?')
  })

  it('states missing retrieval honestly', () => {
    const messages = buildRagMessages('q', [])
    expect(messages[0]?.content).toContain('未检索到相关正文片段')
  })

  it('keeps prior conversation but drops old system messages', () => {
    const messages = buildRagMessages(
      'q',
      [{ label: 'a', text: 'x', score: 1 }],
      [
        { role: 'system', content: 'old' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
    )
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(messages).toHaveLength(4)
  })
})

describe('citationLabels', () => {
  it('dedups labels preserving order', () => {
    expect(
      citationLabels([
        { label: '第一章', text: '', score: 1 },
        { label: '第二章', text: '', score: 0.9 },
        { label: '第一章', text: '', score: 0.8 },
      ]),
    ).toEqual(['第一章', '第二章'])
  })
})

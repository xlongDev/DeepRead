import { describe, expect, it } from 'vitest'
import { buildConceptsMessages, parseConcepts } from './concepts'

describe('parseConcepts', () => {
  it('accepts concepts with relations and explanations', () => {
    const payload = parseConcepts(
      '{"concepts":[{"name":"复利","explanation":"利息再生息","relations":[{"with":"时间","type":"依赖"}]}]}',
    )
    expect(payload.concepts[0]).toMatchObject({ name: '复利', explanation: '利息再生息' })
  })

  it('defaults relations to an empty list', () => {
    const payload = parseConcepts('{"concepts":[{"name":"复利","explanation":"x"}]}')
    expect(payload.concepts[0]!.relations).toEqual([])
  })

  it('rejects concepts without an explanation', () => {
    expect(() => parseConcepts('{"concepts":[{"name":"复利"}]}')).toThrow()
  })
})

describe('buildConceptsMessages', () => {
  it('tells the model to omit unsupported concepts', () => {
    const messages = buildConceptsMessages([{ label: '第一章', text: '复利。' }], '常识')
    expect(messages[0]!.content).toContain('没把握就省略')
  })
})

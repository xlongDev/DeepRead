import { describe, expect, it } from 'vitest'
import { buildTimelineMessages, parseTimeline } from './timeline'

describe('parseTimeline', () => {
  it('accepts events with chapter refs and optional descriptions', () => {
    const payload = parseTimeline(
      '{"events":[{"event":"出海","chapterRef":"第二章","descriptions":["买了船"]}]}',
    )
    expect(payload.events).toHaveLength(1)
    expect(payload.events[0]).toMatchObject({ event: '出海', chapterRef: '第二章' })
  })

  it('defaults descriptions to an empty list', () => {
    const payload = parseTimeline('{"events":[{"event":"出海","chapterRef":"第二章"}]}')
    expect(payload.events[0]!.descriptions).toEqual([])
  })

  it('rejects events without a chapter ref', () => {
    expect(() => parseTimeline('{"events":[{"event":"出海"}]}')).toThrow()
  })
})

describe('buildTimelineMessages', () => {
  it('asks the model to reuse chapter labels instead of inventing dates', () => {
    const messages = buildTimelineMessages([{ label: '第二章', text: '他出了海。' }], '夜航书')
    expect(messages[0]!.content).toContain('不要编造日期')
    expect(messages[1]!.content).toContain('【第二章】')
  })
})

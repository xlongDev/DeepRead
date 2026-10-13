import { describe, expect, it } from 'vitest'
import type { CharactersPayload } from './characters'
import type { ConceptsPayload } from './concepts'
import {
  buildCharacterGraph,
  buildConceptGraph,
  buildGraph,
  buildTimelineGraph,
  graphSvgString,
  layoutCircle,
  layoutTimeline,
} from './graph'
import type { TimelinePayload } from './timeline'

const payload: CharactersPayload = {
  characters: [
    {
      name: '守灯人',
      aliases: [],
      role: '主角',
      description: '点灯的人',
      relationships: [
        { with: '孩子们', type: '同伴' },
        { with: '无名氏', type: '未知' },
      ],
    },
    {
      name: '孩子们',
      aliases: [],
      role: '路人',
      description: '数滴水',
      relationships: [{ with: '守灯人', type: '同伴' }],
    },
  ],
}

describe('buildCharacterGraph', () => {
  it('deduplicates mutual relations and reports dangling targets', () => {
    const graph = buildCharacterGraph(payload)
    expect(graph.nodes.map((n) => n.name)).toEqual(['守灯人', '孩子们'])
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ from: '守灯人', to: '孩子们', label: '同伴' })
    expect(graph.dangling).toEqual([{ from: '守灯人', to: '无名氏' }])
  })
})

describe('layoutCircle', () => {
  it('places nodes evenly with stable ordering', () => {
    const graph = buildCharacterGraph(payload)
    const layout = layoutCircle(graph, 1000)
    expect(layout.positions).toHaveLength(2)
    // zh-order: 孩子们 before 守灯人; first at top center, second at bottom
    expect(layout.positions[0]).toMatchObject({ name: '孩子们', x: 500, y: 120 })
    expect(layout.positions[1]).toMatchObject({ name: '守灯人', x: 500, y: 880 })
  })
})

describe('graphSvgString', () => {
  it('produces a self-contained svg with nodes, edges and labels', () => {
    const graph = buildCharacterGraph(payload)
    const svg = graphSvgString(graph, layoutCircle(graph), {
      background: '#ffffff',
      foreground: '#111111',
      accent: '#3d6deb',
    })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<line')
    expect(svg).toContain('同伴')
    expect(svg).toContain('守灯人')
    expect(svg).toContain('点灯的人') // <title> tooltip
    expect(svg).not.toContain('&amp;&amp;')
  })

  it('escapes xml-sensitive characters in labels', () => {
    const graph = buildCharacterGraph({
      characters: [
        {
          name: 'A<B>',
          aliases: [],
          role: '主角',
          description: 'desc & "quote"',
          relationships: [],
        },
      ],
    })
    const svg = graphSvgString(graph, layoutCircle(graph), {
      background: '#fff',
      foreground: '#000',
      accent: '#000',
    })
    expect(svg).toContain('A&lt;B&gt;')
    expect(svg).toContain('desc &amp; &quot;quote&quot;')
  })
})

const timelinePayload: TimelinePayload = {
  events: [
    { event: '出海', chapterRef: '第三章', descriptions: ['买了船'] },
    { event: '点灯', chapterRef: '第一章', descriptions: [] },
    { event: '归来', chapterRef: '第二章', descriptions: [] },
    { event: '迷路', chapterRef: '附录', descriptions: [] },
  ],
}

describe('buildTimelineGraph', () => {
  it('orders events by chapter position, unknown refs last', () => {
    const graph = buildTimelineGraph(timelinePayload, ['第一章', '第二章', '第三章'])
    expect(graph.nodes.map((n) => n.name)).toEqual(['点灯', '归来', '出海', '迷路'])
    expect(graph.nodes.map((n) => n.role)).toEqual(['第一章', '第二章', '第三章', '附录'])
    expect(graph.dangling).toEqual([{ from: '迷路', to: '附录' }])
  })

  it('links consecutive events for the spine', () => {
    const graph = buildTimelineGraph(timelinePayload, ['第一章', '第二章', '第三章'])
    expect(graph.edges).toHaveLength(graph.nodes.length - 1)
    expect(graph.edges[0]).toMatchObject({ from: '点灯', to: '归来' })
  })
})

describe('buildConceptGraph', () => {
  const concepts: ConceptsPayload = {
    concepts: [
      {
        name: '复利',
        explanation: '利息再生息',
        relations: [
          { with: '时间', type: '依赖' },
          { with: '未抽取', type: '关联' },
        ],
      },
      { name: '时间', explanation: '最重要的变量', relations: [{ with: '复利', type: '依赖' }] },
    ],
  }

  it('deduplicates mutual relations and reports dangling targets', () => {
    const graph = buildConceptGraph(concepts)
    expect(graph.nodes.map((n) => n.name)).toEqual(['复利', '时间'])
    expect(graph.edges).toHaveLength(1)
    expect(graph.dangling).toEqual([{ from: '复利', to: '未抽取' }])
  })
})

describe('buildGraph', () => {
  it('dispatches on the spec kind', () => {
    const characters = buildGraph({
      kind: 'characters',
      payload: { characters: [] },
    })
    expect(characters.nodes).toEqual([])
    const timeline = buildGraph({
      kind: 'timeline',
      payload: timelinePayload,
      chapterLabels: ['第一章', '第二章', '第三章'],
    })
    expect(timeline.nodes[0]!.name).toBe('点灯')
    const conceptGraph = buildGraph({ kind: 'concepts', payload: { concepts: [] } })
    expect(conceptGraph.nodes).toEqual([])
  })
})

describe('layoutTimeline', () => {
  it('spreads nodes on one axis and grows the width with the count', () => {
    const graph = buildTimelineGraph(timelinePayload, ['第一章', '第二章', '第三章'])
    const layout = layoutTimeline(graph)
    expect(layout.kind).toBe('timeline')
    expect(layout.positions).toHaveLength(4)
    expect(layout.positions.every((p) => p.y === layout.axisY)).toBe(true)
    const xs = layout.positions.map((p) => p.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    expect(layout.width).toBeGreaterThan(1200)
  })

  it('keeps a floor width for a single event', () => {
    const graph = buildTimelineGraph(
      { events: [{ event: '点灯', chapterRef: '第一章', descriptions: [] }] },
      ['第一章'],
    )
    expect(layoutTimeline(graph).width).toBe(1200)
  })
})

describe('timeline svg', () => {
  it('draws a spine, chapter labels and event boxes', () => {
    const graph = buildTimelineGraph(timelinePayload, ['第一章', '第二章', '第三章'])
    const svg = graphSvgString(graph, layoutTimeline(graph), {
      background: '#ffffff',
      foreground: '#1d1b17',
      accent: '#3d6deb',
    })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<polygon') // spine arrowhead
    expect(svg).toContain('<rect') // event boxes
    expect(svg).toContain('第一章')
    expect(svg).toContain('买了船')
  })
})

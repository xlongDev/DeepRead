/**
 * Insight graphs (spec §40): builds a graph from an AI artifact payload and
 * renders it as a self-contained SVG. Three views share one node/edge shape:
 * characters (circular), timeline (horizontal chapter axis) and concepts
 * (circular clusters). Pure functions here are unit-tested; the React
 * component only wires zoom/pan/export around the generated string. No graph
 * library (ADR-0001).
 */

import type { CharactersPayload } from './characters'
import type { ConceptsPayload } from './concepts'
import type { TimelinePayload } from './timeline'

export interface GraphNode {
  readonly name: string
  readonly role: string
  readonly description: string
}

export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly label: string
}

export interface CharacterGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  /** Relations dropped because the target character was not extracted. */
  readonly dangling: readonly { readonly from: string; readonly to: string }[]
}

/** Which artifact payload a graph is built from (one per insight kind). */
export type GraphSpec =
  | { readonly kind: 'characters'; readonly payload: CharactersPayload }
  | {
      readonly kind: 'timeline'
      readonly payload: TimelinePayload
      /** Chapter labels in book order; events are sorted by their position here. */
      readonly chapterLabels: readonly string[]
    }
  | { readonly kind: 'concepts'; readonly payload: ConceptsPayload }

export function buildGraph(spec: GraphSpec): CharacterGraph {
  switch (spec.kind) {
    case 'timeline':
      return buildTimelineGraph(spec.payload, spec.chapterLabels)
    case 'concepts':
      return buildConceptGraph(spec.payload)
    case 'characters':
      return buildCharacterGraph(spec.payload)
  }
}

/**
 * Timeline graph: events become nodes ordered by chapter position; consecutive
 * events are linked so the view can draw a spine. Events whose chapterRef is
 * not one of the book's chapter labels keep their model order at the end and
 * are reported as dangling (the view says so instead of guessing a position).
 */
export function buildTimelineGraph(
  payload: TimelinePayload,
  chapterLabels: readonly string[],
): CharacterGraph {
  const order = new Map(chapterLabels.map((label, index) => [label, index]))
  const decorated = payload.events.map((event, index) => ({
    event,
    index,
    chapterIndex: order.get(event.chapterRef) ?? Number.MAX_SAFE_INTEGER,
  }))
  decorated.sort((a, b) => a.chapterIndex - b.chapterIndex || a.index - b.index)
  const nodes: GraphNode[] = decorated.map(({ event }) => ({
    name: event.event,
    role: event.chapterRef,
    description: event.descriptions.join(';'),
  }))
  const edges: GraphEdge[] = nodes
    .slice(1)
    .map((node, index) => ({ from: nodes[index]!.name, to: node.name, label: '' }))
  const dangling = payload.events
    .filter((event) => !order.has(event.chapterRef))
    .map((event) => ({ from: event.event, to: event.chapterRef }))
  return { nodes, edges, dangling }
}

/** Concept graph: same node/edge shape as characters, different payload. */
export function buildConceptGraph(payload: ConceptsPayload): CharacterGraph {
  const nodes: GraphNode[] = payload.concepts.map((concept) => ({
    name: concept.name,
    role: '概念',
    description: concept.explanation,
  }))
  const names = new Set(nodes.map((node) => node.name))
  const edges: GraphEdge[] = []
  const dangling: { from: string; to: string }[] = []
  const seen = new Set<string>()
  for (const concept of payload.concepts) {
    for (const relation of concept.relations) {
      if (!names.has(relation.with)) {
        dangling.push({ from: concept.name, to: relation.with })
        continue
      }
      const key = [concept.name, relation.with].sort().join('|') + relation.type
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: concept.name, to: relation.with, label: relation.type })
    }
  }
  return { nodes, edges, dangling }
}

export function buildCharacterGraph(payload: CharactersPayload): CharacterGraph {
  const nodes: GraphNode[] = payload.characters.map((character) => ({
    name: character.name,
    role: character.role,
    description: character.description,
  }))
  const names = new Set(nodes.map((node) => node.name))
  const edges: GraphEdge[] = []
  const dangling: { from: string; to: string }[] = []
  const seen = new Set<string>()
  for (const character of payload.characters) {
    for (const relation of character.relationships) {
      if (!names.has(relation.with)) {
        dangling.push({ from: character.name, to: relation.with })
        continue
      }
      // Deduplicate mutual pairs (A→B and B→A draw one line).
      const key = [character.name, relation.with].sort().join('|') + relation.type
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: character.name, to: relation.with, label: relation.type })
    }
  }
  return { nodes, edges, dangling }
}

export interface GraphLayout {
  readonly kind: 'circle'
  /** Nodes with computed center coordinates in the SVG coordinate space. */
  readonly positions: readonly {
    readonly name: string
    readonly x: number
    readonly y: number
  }[]
  readonly size: number
  readonly width: number
  readonly height: number
}

/** Even circular layout, ordered by name for stability across renders. */
export function layoutCircle(graph: CharacterGraph, size = 1000): GraphLayout {
  const radius = size * 0.38
  const center = size / 2
  const sorted = [...graph.nodes].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  const positions = sorted.map((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, sorted.length) - Math.PI / 2
    return {
      name: node.name,
      x: Math.round(center + radius * Math.cos(angle)),
      y: Math.round(center + radius * Math.sin(angle)),
    }
  })
  return { kind: 'circle', positions, size, width: size, height: size }
}

export interface TimelineLayout {
  readonly kind: 'timeline'
  readonly width: number
  readonly height: number
  /** Y of the spine every node sits on. */
  readonly axisY: number
  readonly positions: readonly {
    readonly name: string
    readonly x: number
    readonly y: number
  }[]
}

const TIMELINE_NODE_WIDTH = 260
const TIMELINE_NODE_GAP = 60
const TIMELINE_MARGIN = 60

/**
 * Horizontal chapter axis: nodes in graph order (already chapter-sorted by
 * buildTimelineGraph), evenly spaced. Width grows with the event count so
 * long timelines stay readable instead of overlapping.
 */
export function layoutTimeline(graph: CharacterGraph, height = 640): TimelineLayout {
  const count = graph.nodes.length
  const width = Math.max(
    1200,
    count * (TIMELINE_NODE_WIDTH + TIMELINE_NODE_GAP) + TIMELINE_MARGIN * 2 - TIMELINE_NODE_GAP,
  )
  const axisY = Math.round(height / 2)
  const positions = graph.nodes.map((node, index) => ({
    name: node.name,
    x: Math.round(
      TIMELINE_MARGIN + index * (TIMELINE_NODE_WIDTH + TIMELINE_NODE_GAP) + TIMELINE_NODE_WIDTH / 2,
    ),
    y: axisY,
  }))
  return { kind: 'timeline', width, height, axisY, positions }
}

export interface GraphSvgOptions {
  readonly background: string
  readonly foreground: string
  readonly accent: string
}

const escapeXml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** SVG text cannot wrap; long labels are cut with an ellipsis (full text is in <title>). */
const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Render the graph as a self-contained SVG string (used for view + export). */
export function graphSvgString(
  graph: CharacterGraph,
  layout: GraphLayout | TimelineLayout,
  options: GraphSvgOptions,
): string {
  const positionOf = new Map(layout.positions.map((p) => [p.name, p]))
  const width = layout.kind === 'circle' ? layout.size : layout.width
  const height = layout.kind === 'circle' ? layout.size : layout.height
  const lines: string[] = []
  const circles: string[] = []
  for (const node of graph.nodes) {
    const position = positionOf.get(node.name)
    if (!position) continue
    const tooltip = `<title>${escapeXml(node.description)}</title>`
    if (layout.kind === 'circle') {
      circles.push(
        `<g><circle cx="${position.x}" cy="${position.y}" r="46" fill="${escapeXml(options.background)}" stroke="${escapeXml(options.accent)}" stroke-width="3"/><text x="${position.x}" y="${position.y + 7}" font-size="24" fill="${escapeXml(options.foreground)}" text-anchor="middle">${escapeXml(truncate(node.name, 8))}</text>${tooltip}</g>`,
      )
    } else {
      const x = position.x - TIMELINE_NODE_WIDTH / 2
      const y = position.y - 48
      circles.push(
        `<g><rect x="${x}" y="${y}" width="${TIMELINE_NODE_WIDTH}" height="96" rx="12" fill="${escapeXml(options.background)}" stroke="${escapeXml(options.accent)}" stroke-width="3"/>` +
          `<text x="${position.x}" y="${y - 10}" font-size="18" fill="${escapeXml(options.accent)}" text-anchor="middle">${escapeXml(truncate(node.role, 12))}</text>` +
          `<text x="${position.x}" y="${y + 40}" font-size="22" fill="${escapeXml(options.foreground)}" text-anchor="middle">${escapeXml(truncate(node.name, 11))}</text>` +
          `<text x="${position.x}" y="${y + 68}" font-size="16" fill="${escapeXml(options.foreground)}" text-anchor="middle" opacity="0.7">${escapeXml(truncate(node.description, 16))}</text>${tooltip}</g>`,
      )
    }
  }
  if (layout.kind === 'timeline') {
    // Spine between consecutive node centers (positions are already ordered).
    const first = layout.positions[0]
    const last = layout.positions[layout.positions.length - 1]
    if (first && last && first !== last) {
      lines.push(
        `<line x1="${first.x}" y1="${layout.axisY}" x2="${last.x}" y2="${layout.axisY}" stroke="${escapeXml(options.accent)}" stroke-width="2" stroke-opacity="0.6"/>`,
        `<polygon points="${last.x + 14},${layout.axisY} ${last.x},${layout.axisY - 7} ${last.x},${layout.axisY + 7}" fill="${escapeXml(options.accent)}"/>`,
      )
    }
    for (const position of layout.positions) {
      lines.push(
        `<line x1="${position.x}" y1="${layout.axisY}" x2="${position.x}" y2="${layout.axisY - 12}" stroke="${escapeXml(options.accent)}" stroke-width="2"/>`,
      )
    }
  } else {
    for (const edge of graph.edges) {
      const from = positionOf.get(edge.from)
      const to = positionOf.get(edge.to)
      if (!from || !to) continue
      lines.push(
        `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${escapeXml(options.accent)}" stroke-width="2" stroke-opacity="0.6"/>`,
      )
      const midX = (from.x + to.x) / 2
      const midY = (from.y + to.y) / 2
      lines.push(
        `<text x="${midX}" y="${midY - 6}" font-size="20" fill="${escapeXml(options.foreground)}" text-anchor="middle" opacity="0.75">${escapeXml(edge.label)}</text>`,
      )
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${escapeXml(options.background)}"/>`,
    ...lines,
    ...circles,
    '</svg>',
  ].join('\n')
}

import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowCounterClockwise, Download, X } from '@phosphor-icons/react'
import {
  buildGraph,
  graphSvgString,
  layoutCircle,
  layoutTimeline,
  type GraphLayout,
  type GraphSpec,
  type TimelineLayout,
} from '@deepread/ai-core'

interface GraphViewProps {
  readonly spec: GraphSpec
  readonly onClose: () => void
}

/** Per-kind copy: the view is generic, only the words differ. */
const VIEW_META = {
  characters: {
    title: '角色关系图',
    empty: '还没有可绘图的角色,先抽取角色。',
    file: 'characters-graph',
    dangling: (count: number): string => `${count} 条关系指向未抽取到的角色,未绘制。`,
  },
  timeline: {
    title: '事件时间线',
    empty: '还没有可绘制的事件,先抽取时间线。',
    file: 'timeline-graph',
    dangling: (count: number): string =>
      `${count} 个事件的章节不在目录里,按模型给出的顺序排在最后。`,
  },
  concepts: {
    title: '概念关系图',
    empty: '还没有可绘制的概念,先抽取概念。',
    file: 'concepts-graph',
    dangling: (count: number): string => `${count} 条关系指向未抽取到的概念,未绘制。`,
  },
} as const

export function GraphView({ spec, onClose }: GraphViewProps) {
  const meta = VIEW_META[spec.kind]
  const graph = useMemo(() => buildGraph(spec), [spec])
  const layout = useMemo<GraphLayout | TimelineLayout>(
    () => (spec.kind === 'timeline' ? layoutTimeline(graph) : layoutCircle(graph)),
    [graph, spec.kind],
  )
  // ViewBox starts at the full layout; zoom/pan work from there for every kind.
  const [viewBox, setViewBox] = useState(() => ({ x: 0, y: 0, w: layout.width, h: layout.height }))
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  // 主题色在渲染时解析成具体值:SVG 表现属性不支持 var(),导出的文件也因此
  // 自带真实颜色(所见即所得)。羊皮/夜间主题下图谱不再是白底色块。
  const themeColors = useMemo(() => {
    const source = document.querySelector('.reader-scope') ?? document.documentElement
    const styles = getComputedStyle(source)
    const pick = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim()
      return value !== '' ? value : fallback
    }
    return {
      background: pick('--reader-bg', '#ffffff'),
      foreground: pick('--reader-fg', '#1d1b17'),
      accent: pick('--color-accent', '#3d6deb'),
    }
  }, [])

  const svg = useMemo(
    () => graphSvgString(graph, layout, themeColors),
    [graph, layout, themeColors],
  )

  // Wheel zoom around the cursor: shrink/grow the viewBox, clamped so the
  // graph never disappears or gets absurdly cropped.
  const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    setViewBox((current) => {
      const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2
      const width = Math.min(8000, Math.max(160, current.w * factor))
      const height = width
      const ratioX = (event.clientX - 40) / (window.innerWidth - 80)
      const ratioY = (event.clientY - 40) / (window.innerHeight - 80)
      const x = current.x + (current.w - width) * ratioX
      const y = current.y + (current.h - height) * ratioY
      return { x, y, w: width, h: height }
    })
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      dragRef.current = { x: event.clientX, y: event.clientY, vx: viewBox.x, vy: viewBox.y }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [viewBox],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const svgElement = event.currentTarget
      const scale = viewBox.w / Math.max(1, svgElement.clientWidth)
      setViewBox((current) => ({
        ...current,
        x: drag.vx - (event.clientX - drag.x) * scale,
        y: drag.vy - (event.clientY - drag.y) * scale,
      }))
    },
    [viewBox.w],
  )

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const reset = useCallback(
    () => setViewBox({ x: 0, y: 0, w: layout.width, h: layout.height }),
    [layout.width, layout.height],
  )

  const exportSvg = useCallback(() => {
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${meta.file}.svg`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [svg, meta.file])

  return (
    <section className="graph-overlay" aria-label={meta.title}>
      <header className="graph-head">
        <strong>{meta.title}</strong>
        <span className="graph-hint">滚轮缩放 · 拖拽平移</span>
        <div className="ai-head-actions">
          <button type="button" className="chrome-button" onClick={reset} title="重置视图">
            <ArrowCounterClockwise size={16} weight="regular" aria-hidden />
          </button>
          <button type="button" className="chrome-button" onClick={exportSvg} title="导出 SVG">
            <Download size={16} weight="regular" aria-hidden />
          </button>
          <button type="button" className="chrome-button" onClick={onClose} title="关闭">
            <X size={16} weight="regular" aria-hidden />
          </button>
        </div>
      </header>
      {graph.nodes.length === 0 ? (
        <p className="lookup-empty">{meta.empty}</p>
      ) : (
        <svg
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          className="graph-svg"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-roledescription="图示"
          aria-label={`${meta.title}:${graph.nodes.map((n) => n.name).join('、')}`}
        >
          <g dangerouslySetInnerHTML={{ __html: svg.replace(/^<svg[^>]*>|<\/svg>$/g, '') }} />
        </svg>
      )}
      {graph.dangling.length > 0 && (
        <p className="graph-dangling">{meta.dangling(graph.dangling.length)}</p>
      )}
    </section>
  )
}

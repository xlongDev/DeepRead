/**
 * 放不下才滚动的单行文本。
 *
 * 溢出量在挂载时量一次、写进 `--scroll`,之后交给 CSS 动画跑(合成器,不动布局);
 * 没溢出的元素连 class 都不会加。**只有鼠标停在上面时才滚** —— 滚动是"看不全"
 * 的补救,不是装饰,让它在列表里自己动起来只会分散注意力。
 *
 * 滚动与省略号是二选一:hover 时切到 clip 让整行滑过去,平时保持 ellipsis,
 * 这样被截断的标题一眼看得出还有下文。
 *
 * ⚠️ 调用方必须让**父容器** `overflow: hidden`。滚动动画是 transform,而元素裁不到
 * 自己 —— 本组件上的 overflow 只裁内容,裁不住被推出去的盒子本身,少了父级裁剪
 * 这段文字会滑到邻居身上。
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'

export interface ScrollingTextProps {
  readonly text: string
  readonly className?: string
}

export function ScrollingText({ text, className }: ScrollingTextProps) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = (): void => setOverflow(Math.max(0, box.scrollWidth - box.clientWidth))
    measure()
    // 容器宽度或字体变了都要重量(字体是异步加载的,第一次量往往偏小)。
    // 不依赖 text:换文字必然改变内容宽度,ResizeObserver 会自己抓到。
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  return (
    <span
      ref={boxRef}
      // 原生 title 是兜底:prefers-reduced-motion 下不滚,鼠标停一下仍能看到全文。
      title={text}
      className={['scrolling-text', overflow > 0 ? 'is-overflow' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      style={overflow > 0 ? ({ '--scroll': `-${overflow}px` } as CSSProperties) : undefined}
    >
      {text}
    </span>
  )
}

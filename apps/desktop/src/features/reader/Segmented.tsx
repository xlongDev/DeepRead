import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type ThumbRect = { left: number; top: number; width: number; height: number }

/**
 * 带弹性滑动滑块的分段控件:原样渲染子按钮,另画一颗滑块
 * (.segmented-thumb)贴在当前 `.is-active` 按钮底下,点别的档位时
 * 滑块以弹簧曲线滑过去。
 *
 * 用 offsetLeft/offsetTop 量(布局值,不吃祖先 transform —— 见
 * page-turn 那次 getBoundingClientRect 被 host transform 污染的教训);
 * 每次渲染 + 容器 ResizeObserver 后重测,换行(.segmented-wrap)也能跟。
 */
export function Segmented({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<ThumbRect | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const active = el.querySelector<HTMLElement>('button.is-active')
      const next: ThumbRect | null = active
        ? {
            left: active.offsetLeft,
            top: active.offsetTop,
            width: active.offsetWidth,
            height: active.offsetHeight,
          }
        : null
      // 引用相等守卫:对象常新会触发 setState 循环(effect 每次渲染都跑)。
      setThumb((prev) =>
        prev &&
        next &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  })

  return (
    <div ref={ref} className={`segmented segmented-animated${className ? ` ${className}` : ''}`}>
      {thumb !== null && (
        <span
          className="segmented-thumb"
          aria-hidden
          style={{
            width: `${thumb.width}px`,
            height: `${thumb.height}px`,
            translate: `${thumb.left}px ${thumb.top}px`,
          }}
        />
      )}
      {children}
    </div>
  )
}

/**
 * 滑动指示条(iOS SegmentedControl 同款)。
 *
 * 切换选项时,胶囊背景**在容器里从旧位置滑到新位置**,而不是各自按钮单独
 * 切背景 —— 后者读作"按钮自己变了",前者读作"焦点从一处走到另一处"。
 * 配合 spring easing,会有小幅 overshoot,把"切换"读出来。
 *
 * 位置和尺寸**全部从 DOM 量**(left/top/width/height),所以同一套组件既能用在
 * 横向分段控件(等高、只横移),也能用在侧栏那种纵向列表(逐项移动、高度跟着
 * 项走)。容器必须是 `position: relative`;按钮自己保持透明,高亮交给指示条
 * 加 color token。
 *
 * 测量发生在 `useLayoutEffect`,与样式表同时 commit —— 不会出现"先闪一个位置、
 * 再滑到正确位置"的两次绘制。
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react'

interface Box {
  key: string
  left: number
  top: number
  width: number
  height: number
}

export interface SlidingIndicatorProps {
  /**
   * 当前激活项的标识。变了就重新测量 —— 光有 `activeSelector` 不够:同一个
   * selector 永远指向"当前那个 active 按钮",位置变了它自己是察觉不到的。
   */
  readonly activeKey: string
  /** 当前激活项的 selector —— 在容器内查询,找到的那个就是指示条停的位置。 */
  readonly activeSelector: string
  /** 容器类名,决定 padding / 形状。 */
  readonly className: string
  /**
   * 容器元素。默认 `div`;侧栏用 `nav` 保留导航语义(此时不传 role,
   * 否则会覆盖 nav 自带的 navigation role)。
   */
  readonly as?: 'div' | 'nav'
  readonly role?: 'toolbar' | 'tablist'
  /** 只有带 role 的容器(或 nav)才传 —— 裸 div 上挂 aria-label 是无效 ARIA。 */
  readonly ariaLabel?: string
  readonly children: ReactNode
}

export function SlidingIndicator({
  activeKey,
  activeSelector,
  className,
  as = 'div',
  role,
  ariaLabel,
  children,
}: SlidingIndicatorProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const [box, setBox] = useState<Box | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const measure = (): void => {
      const active = container.querySelector<HTMLElement>(activeSelector)
      if (active === null) return
      const cRect = container.getBoundingClientRect()
      const aRect = active.getBoundingClientRect()
      const left = aRect.left - cRect.left
      const top = aRect.top - cRect.top
      const width = aRect.width
      const height = aRect.height
      // 值没变必须返回**同一个引用** —— React 才会 bail out。否则每次渲染都
      // setBox 一个新对象 → 又触发一次渲染 → 无限循环(React 会直接报
      // "Maximum update depth exceeded")。
      // key 也参与比较:两个等宽等高相邻按钮的几何值可能完全相同,但那是
      // **另一次**切换,状态该更新。顺带让 activeKey 成为真正被读到的依赖。
      setBox((current) =>
        current !== null &&
        current.key === activeKey &&
        current.left === left &&
        current.top === top &&
        current.width === width &&
        current.height === height
          ? current
          : { key: activeKey, left, top, width, height },
      )
    }
    measure()
    // 容器尺寸也会变(窗口缩放、字体异步加载、侧栏开合)。这些不经过 React,
    // 所以光靠 activeKey 的依赖不够。
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [activeKey, activeSelector])

  /*
   * 指示条放在按钮之前 + pointer-events: none —— 不挡按钮的点击;按钮
   * 自己是 z-index 上层。测量前不写任何几何样式,避免"先在角落闪一下再滑到位"。
   */
  const body = (
    <>
      <span
        className="sliding-indicator"
        aria-hidden
        style={
          box === null
            ? undefined
            : ({
                transform: `translate(${box.left}px, ${box.top}px)`,
                width: `${box.width}px`,
                height: `${box.height}px`,
              } as CSSProperties)
        }
      />
      {children}
    </>
  )

  if (as === 'nav') {
    return (
      <nav ref={containerRef} className={className} aria-label={ariaLabel}>
        {body}
      </nav>
    )
  }

  return (
    <div
      ref={containerRef as Ref<HTMLDivElement>}
      className={className}
      role={role}
      aria-label={ariaLabel}
    >
      {body}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { invokeCommand } from '../lib/ipc'

/**
 * 性能监视器(plan B9.4):dev-only 的悬浮读数 —— FPS / JS 堆 / 进程
 * RSS+CPU。只在 `import.meta.env.DEV` 挂载(Vite 把条件替换成 false,
 * 生产构建整个组件被树摇掉)。§70 预算的锚点:交互 60fps,翻页帧
 * 16ms —— FPS 掉下 55 就该去看 Performance 面板,而不是猜。
 */

interface MemoryLike {
  usedJSHeapSize: number
}

export function DevStatsOverlay() {
  const [fps, setFps] = useState(0)
  const [heapMb, setHeapMb] = useState<number | null>(null)
  const [rssMb, setRssMb] = useState<number | null>(null)
  const [cpu, setCpu] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const frames = useRef(0)

  useEffect(() => {
    // rAF 数帧,FPS 按 1s 窗口结算。
    let raf = 0
    const tick = (): void => {
      frames.current += 1
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const timer = setInterval(() => {
      setFps(frames.current)
      frames.current = 0
      // performance.memory 是 Chromium(含 WKWebView 部分)的私有扩展。
      const memory = (performance as unknown as { memory?: MemoryLike }).memory
      setHeapMb(memory === undefined ? null : memory.usedJSHeapSize / (1024 * 1024))
    }, 1000)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      invokeCommand('dev.process.stats', undefined)
        .then((stats) => {
          setRssMb(stats.rssBytes === null ? null : stats.rssBytes / (1024 * 1024))
          setCpu(stats.cpuPercent)
        })
        .catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      className="dev-stats"
      aria-hidden
      onClick={() => setCollapsed((current) => !current)}
      title="性能监视器(dev-only):点击折叠"
    >
      {collapsed ? (
        <span>{fps} fps</span>
      ) : (
        <>
          <span className={fps < 55 ? 'is-warn' : ''}>{fps} fps</span>
          {heapMb !== null && <span>heap {heapMb.toFixed(1)} MB</span>}
          {rssMb !== null && <span>rss {rssMb.toFixed(0)} MB</span>}
          {cpu !== null && <span>cpu {cpu.toFixed(1)}%</span>}
        </>
      )}
    </div>
  )
}

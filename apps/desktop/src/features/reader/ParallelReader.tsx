/**
 * 双栏对照阅读:两本书并排,各自还是一个完整的 ReaderScreen。
 *
 * ## 为什么是「两个 ReaderScreen」而不是「一个渲染器画两本书」
 *
 * 内核适配器本来就是 **per 宿主元素** 实例化的(`new FoliateAdapter(host)`),
 * 一栏一个 `<foliate-view>`,互不干扰;而 ReaderScreen 已经把一本书需要的东西
 * 全背在身上(目录、批注、划词、朗读、AI)。为并行阅读再抽一层「多书宿主」,
 * 等于把 2900 行状态拆成两套再拼回去 —— 为拆而拆。这里只做三件一栏之内做不到
 * 的事:分栏几何、活动栏归属、联动对位。
 *
 * ## 交互取舍
 *
 * - **活动栏**:在一栏里按下 = 切到那一栏。只有活动栏响应键盘、显示顶栏/底栏/
 *   翻页钮 —— 两套 chrome 同时在场会挤满 20 个按钮,而且没法回答「方向键翻哪本」。
 * - **联动**:默认开,按全书比例对位(两本不同版本/不同语言的同一部书,比例是
 *   唯一可用的公共坐标系)。开/关在分隔条上,随时可停 —— 版本差异大时联动反而是
 *   干扰。回声守卫见 `parallel.ts`。
 * - **关闭对照 = 留下活动栏那本**,不是回书架:读者按的是「我不比了」,不是
 *   「我要离开这本书」。
 */

import { useCallback, useRef, useState } from 'react'
import { LinkSimple, LinkSimpleBreak, X } from '@phosphor-icons/react'
import { ReaderScreen } from './ReaderScreen'
import type { OpenedBook } from '../../lib/book-import'
import {
  RELAY_INTERVAL_MS,
  SPLIT_DEFAULT,
  SPLIT_STEP,
  clampSplit,
  loadSplit,
  persistSplit,
  relayDecision,
  type PaneSide,
  type RelayEcho,
} from './parallel'

interface SyncRequest {
  readonly fraction: number
  readonly nonce: number
}

/** nonce 0 = 没有待办(开书位置由各栏自己恢复,不靠联动)。 */
const IDLE: SyncRequest = { fraction: 0, nonce: 0 }

export interface ParallelReaderProps {
  readonly primary: OpenedBook
  readonly secondary: OpenedBook
  readonly hidden?: boolean
  readonly onBack: (ttsPlaying: boolean) => void
  readonly onRequestShow?: () => void
  /** 关闭对照:留下 `keep` 这本,回到单本阅读。 */
  readonly onExit: (keep: OpenedBook) => void
}

export function ParallelReader({
  primary,
  secondary,
  hidden = false,
  onBack,
  onRequestShow,
  onExit,
}: ParallelReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(loadSplit)
  const [active, setActive] = useState<PaneSide>('a')
  const [linked, setLinked] = useState(true)
  const [requests, setRequests] = useState<Record<PaneSide, SyncRequest>>({ a: IDLE, b: IDLE })
  /** 拖动中的临时比例:只走 CSS 变量,不走 state —— 每帧重渲染两棵阅读器树太贵。 */
  const dragRef = useRef<{ rect: DOMRect; percent: number } | null>(null)
  const echoRef = useRef<RelayEcho | null>(null)
  const lastRelayRef = useRef(0)
  /** 各栏最后停在哪条 CFI:「关闭对照」要立刻回到这一页,不等存储回读。 */
  const cfiRef = useRef<Record<PaneSide, string | undefined>>({ a: undefined, b: undefined })

  /**
   * 一栏报了位置变化 → 决定要不要拽对面。
   *
   * 回声判定必须在**节流之前**:对面被拽过去后几乎立刻回调,那一跳往往就落在
   * 120ms 的节流窗里 —— 如果先被节流丢掉,守卫就一直挂在对面等一个永远不会
   * 被消费的回声,下一次真实翻页会被误吞(表现:联动偶尔失灵一次)。
   */
  const relay = useCallback(
    (side: PaneSide, fraction: number) => {
      if (!linked) return
      const now = Date.now()
      const previous = echoRef.current
      const decision = relayDecision(side, previous, now)
      echoRef.current = decision.echo
      if (decision.relay === null) return
      if (now - lastRelayRef.current < RELAY_INTERVAL_MS) {
        // 这一跳被节流掉:守卫还原 —— 没发出去的请求不该在等回声。
        echoRef.current = previous
        return
      }
      lastRelayRef.current = now
      const target = decision.relay
      setRequests((current) => ({
        ...current,
        [target]: { fraction, nonce: current[target].nonce + 1 },
      }))
    },
    [linked],
  )

  const commitSplit = (percent: number): void => {
    const next = clampSplit(percent)
    setSplit(next)
    persistSplit(next)
  }

  const onDividerPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const box = containerRef.current
    if (box === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { rect: box.getBoundingClientRect(), percent: split }
  }

  const onDividerPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    const box = containerRef.current
    if (drag === null || box === null) return
    const percent = clampSplit(((event.clientX - drag.rect.left) / drag.rect.width) * 100)
    drag.percent = percent
    // 直接写变量:内核的 ResizeObserver 会跟着重排,但 React 不必重渲染。
    box.style.setProperty('--split', `${percent}%`)
  }

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag !== null) commitSplit(drag.percent)
  }

  const nudgeSplit = (delta: number): void => commitSplit(split + delta)

  return (
    <div
      className="reader-parallel"
      ref={containerRef}
      style={{ '--split': `${split}%` } as React.CSSProperties}
    >
      <div className="parallel-cell" data-active={active === 'a'}>
        <ReaderScreen
          key={primary.bookId}
          book={primary}
          onBack={onBack}
          hidden={hidden}
          onRequestShow={onRequestShow}
          pane={{
            active: active === 'a',
            onActivate: () => setActive('a'),
            sync: requests.a,
            onRelocate: (fraction, cfi) => {
              cfiRef.current.a = cfi
              relay('a', fraction)
            },
          }}
        />
      </div>

      <div className="parallel-cell" data-active={active === 'b'}>
        <ReaderScreen
          key={secondary.bookId}
          book={secondary}
          onBack={onBack}
          hidden={hidden}
          onRequestShow={onRequestShow}
          pane={{
            active: active === 'b',
            onActivate: () => setActive('b'),
            sync: requests.b,
            onRelocate: (fraction, cfi) => {
              cfiRef.current.b = cfi
              relay('b', fraction)
            },
          }}
        />
      </div>

      {/* 分隔条:15px 的抓取带压在两栏交界上。那道 1px 缝由左栏自己的
          `.reader::after` 画(见 global.css)—— 缝要在书页主题里取色,只有栏内
          才拿得到 --reader-fg。 */}
      <button
        type="button"
        className="parallel-divider"
        aria-label="调整两栏宽度(可拖动,方向键微调,双击复位)"
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => commitSplit(SPLIT_DEFAULT)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            nudgeSplit(-SPLIT_STEP)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            nudgeSplit(SPLIT_STEP)
          }
        }}
      />

      {/*
        常驻低透明度的玻璃胶囊(与翻页钮同一种存在感),悬停浮现:并排模式的
        **唯一**出口。挂在分隔条上而不是某一栏的顶栏里 —— 这两颗按钮管的是
        「两栏之间的关系」,不属于任何一本书。
      */}
      <div className="parallel-controls">
        <button
          type="button"
          className={`parallel-control${linked ? ' is-on' : ''}`}
          title={linked ? '联动翻页:开(点按只翻当前栏)' : '联动翻页:关(点按两栏同步)'}
          aria-pressed={linked}
          onClick={() => setLinked((value) => !value)}
        >
          {linked ? (
            <LinkSimple size={15} weight="regular" aria-hidden />
          ) : (
            <LinkSimpleBreak size={15} weight="regular" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="parallel-control"
          title={`关闭对照,只留「${active === 'a' ? primary.name : secondary.name}」`}
          onClick={() => {
            const keep = active === 'a' ? primary : secondary
            const cfi = cfiRef.current[active]
            // 带上 CFI:换回单本时直接落到这一页,不等进度回读(那是异步的,
            // 会和刚写的落盘赛跑)。
            onExit(cfi === undefined ? keep : { ...keep, cfi })
          }}
        >
          <X size={15} weight="regular" aria-hidden />
        </button>
      </div>
    </div>
  )
}

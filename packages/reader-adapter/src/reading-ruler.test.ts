import { describe, expect, it } from 'vitest'
import { INITIAL_WHEEL_STATE, rulerScrim, wheelStep, type WheelGestureState } from './reading-ruler'

describe('阅读尺蒙版色', () => {
  it('纸色 + (1 - 不透明度)', () => {
    expect(rulerScrim('#131210', 0.2)).toBe('rgba(19, 18, 16, 0.800)')
    expect(rulerScrim('#ffffff', 0.35)).toBe('rgba(255, 255, 255, 0.650)')
  })

  it('不透明度越界夹到 [0,1]:1 = 全透明(等于没开),0 = 全遮', () => {
    expect(rulerScrim('#ffffff', 1)).toBe('rgba(255, 255, 255, 0.000)')
    expect(rulerScrim('#ffffff', 0)).toBe('rgba(255, 255, 255, 1.000)')
    expect(rulerScrim('#ffffff', Number.NaN)).toBe('rgba(255, 255, 255, 0.800)')
  })
})

/** 顺着时间推一串滚轮事件,返回每一步推了几行。 */
function feed(events: readonly (readonly [deltaY: number, deltaMode?: number, at?: number])[]): {
  lines: number[]
  state: WheelGestureState
} {
  let state = INITIAL_WHEEL_STATE
  const lines: number[] = []
  let now = 1000
  for (const [deltaY, deltaMode = 0, at] of events) {
    if (at !== undefined) now = at
    else now += 16
    const step = wheelStep(deltaY, deltaMode, state, now)
    state = step.state
    lines.push(step.lines)
  }
  return { lines, state }
}

describe('滚轮 → 行(手势语义)', () => {
  it('触控板一拨(带动量的一整串)= 一行,不再哗啦跳好几行', () => {
    // 一次 20 格的拨动(每格 20px,共 400px):旧实现会推 3 行
    const burst: (readonly [number, number, number])[] = []
    for (let index = 0; index < 20; index += 1) {
      burst.push([20, 0, 1000 + index * 16])
    }
    const { lines } = feed(burst)
    expect(lines.reduce((sum, value) => sum + value, 0)).toBe(1)
  })

  it('再拨一次(静默超过 150ms 算新手势)才走下一行', () => {
    const burst = (from: number): (readonly [number, number, number])[] => [
      [20, 0, from],
      [20, 0, from + 16],
      [20, 0, from + 32],
      [20, 0, from + 48],
      [20, 0, from + 64],
      [20, 0, from + 80],
    ]
    const { lines } = feed([...burst(1000), ...burst(1400)])
    expect(lines).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1])
  })

  it('攒不够一行不空转:一次拨只给 50px 不走', () => {
    const { lines, state } = feed([
      [25, 0, 1000],
      [25, 0, 1016],
    ])
    expect(lines).toEqual([0, 0])
    expect(state.pixels).toBe(50)
  })

  it('鼠标滚轮一格(≥100px)一次一行,快速连滚不被并', () => {
    // 三格,每格间隔 60ms(< 150ms 静默阈值):手势没断,但离散事件各走各行
    const { lines } = feed([
      [120, 0, 1000],
      [120, 0, 1060],
      [120, 0, 1120],
    ])
    expect(lines).toEqual([1, 1, 1])
  })

  it('deltaMode=1(按行滚)一次一行,不留余量', () => {
    const { lines, state } = feed([
      [3, 1, 1000],
      [-1, 1, 1060],
    ])
    expect(lines).toEqual([3, 1])
    expect(state.pixels).toBe(0)
  })

  it('反向滚:手势作废重开,余量与方向一起清零', () => {
    const { lines, state } = feed([
      [40, 0, 1000],
      [40, 0, 1016],
      [-20, 0, 1032],
    ])
    expect(lines).toEqual([0, 0, 0])
    expect(state.direction).toBe(-1)
    expect(state.pixels).toBe(-20)
  })

  it('长拖动(持续 > 400ms)恢复按像素连续走', () => {
    const events: (readonly [number, number, number])[] = []
    // 600ms 内每 16ms 给 20px,共 760px:热身 110px 走第 1 行;放行前那
    // ~320px 落在静默期里被丢弃(不积压,免得放行时突然跳几行);剩下
    // ~330px 在放行后按 110px/行再走 2 行。
    for (let index = 0; index < 38; index += 1) {
      events.push([20, 0, 1000 + index * 16])
    }
    const { lines } = feed(events)
    expect(lines.reduce((sum, value) => sum + value, 0)).toBe(3)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  ECHO_WINDOW_MS,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  clampSplit,
  loadSplit,
  persistSplit,
  relayDecision,
} from './parallel'

describe('分栏比例', () => {
  it('合法值直接取整', () => {
    expect(clampSplit(46.4)).toBe(46)
  })

  it('越界夹到 30~70', () => {
    expect(clampSplit(5)).toBe(SPLIT_MIN)
    expect(clampSplit(95)).toBe(SPLIT_MAX)
  })

  it('NaN 落回默认,不把 NaN% 写进 grid', () => {
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT)
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(SPLIT_DEFAULT)
  })

  it('存取一轮后读回同一个比例', () => {
    persistSplit(62)
    expect(loadSplit()).toBe(62)
  })

  it('存储里的脏值读回默认', () => {
    localStorage.setItem('deepread.reader.split', 'oops')
    expect(loadSplit()).toBe(SPLIT_DEFAULT)
  })
})

describe('联动回声守卫', () => {
  it('本栏翻页 → 转给对面,并把守卫挂到对面', () => {
    const decision = relayDecision('a', null, 1000)
    expect(decision.relay).toBe('b')
    expect(decision.echo).toEqual({ side: 'b', until: 1000 + ECHO_WINDOW_MS })
  })

  it('对面刚被拽过去后回调的位置变化是回声,吞掉(守卫保留到窗口结束)', () => {
    const first = relayDecision('a', null, 1000)
    const second = relayDecision('b', first.echo, 1100)
    expect(second.relay).toBeNull()
    // 守卫**保留**:一次 goTo 会上报好几次 relocate,只吞第一次的话后面几次
    // 会被当成本栏的真实翻页,反向把对面拽回来(两栏对跳)。
    expect(second.echo).toBe(first.echo)
    // 窗口内后续的上报继续被吞
    expect(relayDecision('b', second.echo, 1200).relay).toBeNull()
  })

  it('守卫过期后对面的真实翻页照常转(不被永久吞掉)', () => {
    const first = relayDecision('a', null, 1000)
    const later = relayDecision('b', first.echo, 1000 + ECHO_WINDOW_MS + 1)
    expect(later.relay).toBe('a')
  })

  it('守卫挂在对面时,本栏的动作不受影响', () => {
    const first = relayDecision('a', null, 1000)
    expect(relayDecision('a', first.echo, 1050).relay).toBe('b')
  })

  it('持久化失败时静默(隐私模式)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => persistSplit(55)).not.toThrow()
    spy.mockRestore()
  })
})

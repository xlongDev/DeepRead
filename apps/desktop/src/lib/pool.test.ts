import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './pool'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapWithConcurrency', () => {
  it('并发执行但结果保持输入顺序(完成顺序故意与输入相反)', async () => {
    const result = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
      await delay(30 - n * 10)
      return n * 10
    })
    expect(result).toEqual([10, 20, 30])
  })

  it('同时在飞的任务数不超过 limit', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, async () => {
      active += 1
      peak = Math.max(peak, active)
      await delay(5)
      active -= 1
    })
    expect(peak).toBe(2)
  })

  it('limit 大于任务数与空输入都安全', async () => {
    expect(await mapWithConcurrency(['a'], 8, async (s) => s)).toEqual(['a'])
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })

  it('任务抛出则整体拒绝 —— 吞错策略归调用方', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})

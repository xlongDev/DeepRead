/**
 * page-turn 契约:两段动画夹一次内核翻页,且翻页前必须「停车」——
 * 把 host 钉在进场段首帧,让内核翻页的空窗完全停在不可见状态。
 * 这是「翻页闪一下」回归的防线:不停车新页会在空窗里以自然位置
 * 整个弹出再跳走;仿真档 out/in 绕反方向,半透明旧页会当着用户的
 * 面翻面。
 */

import { describe, expect, it } from 'vitest'
import { animatePageTurn } from './page-turn'

type AnimCtor = (
  frames: Keyframe[],
  opts: { duration: number; easing: string; fill: string },
) => {
  finished: Promise<unknown>
  cancel: () => void
}

function fakeHost(animate?: AnimCtor) {
  return {
    animate,
  } as unknown as Element
}

function recordingHost(seen: { frames: Keyframe[]; opts: { duration: number; fill: string } }[]) {
  return fakeHost((frames, opts) => {
    seen.push({ frames, opts })
    return { finished: Promise.resolve(), cancel: () => {} }
  })
}

describe('animatePageTurn', () => {
  it('仿真档两段动画夹一次内核翻页:先退场,停车,再 flip,最后进场', async () => {
    const calls: string[] = []
    const host = fakeHost(() => {
      calls.push('anim')
      return { finished: Promise.resolve(), cancel: () => {} }
    })
    await animatePageTurn(host, 'flip', 'next', async () => {
      calls.push('flip')
    })
    // out / park / flip / in —— 停车动画就是 flip 前那一次 animate。
    expect(calls).toEqual(['anim', 'anim', 'flip', 'anim'])
  })

  it('停车:flip 前 host 已钉在进场段首帧(零时长 fill:both)', async () => {
    const seen: { frames: Keyframe[]; opts: { duration: number; fill: string } }[] = []
    const host = recordingHost(seen)
    await animatePageTurn(host, 'cover', 'next', async () => {})
    // out / park / in 三次 animate,停车是中间那次。
    expect(seen).toHaveLength(3)
    expect(seen[1]!.opts).toEqual({ duration: 0, fill: 'both' })
    // 停车帧必须等于进场段首帧:空窗结束放进场动画时才没有跳变。
    expect(seen[1]!.frames[0]).toEqual(seen[2]!.frames[0])
  })

  it('仿真档换页不可见:out 收在 opacity 0,进场起在 opacity 0', async () => {
    const seen: { frames: Keyframe[]; opts: { duration: number; fill: string } }[] = []
    const host = recordingHost(seen)
    await animatePageTurn(host, 'flip', 'next', async () => {})
    expect(seen).toHaveLength(3) // out / park / in
    expect(seen[0]!.frames.at(-1)).toMatchObject({ opacity: 0 })
    expect(seen[2]!.frames[0]).toMatchObject({ opacity: 0 })
  })

  it('仿真档停车帧几何中性:transform none,不可含缩放/旋转', async () => {
    // 防「仿真翻页后排版错乱」回归:停车帧压在 foliate 翻页窗口上,而
    // 内核在窗口里用 container.getBoundingClientRect() 量页面尺寸 ——
    // 祖先 transform 一旦旋转/缩放(rotateY(82°) 会把 700px 量成 ~99px),
    // 窄列宽就被 columnize 写进 iframe 文档且永不重排。
    const seen: { frames: Keyframe[]; opts: { duration: number; fill: string } }[] = []
    const host = recordingHost(seen)
    await animatePageTurn(host, 'flip', 'next', async () => {})
    const park = seen[1]!.frames[0]!
    expect(park).toMatchObject({ transform: 'none', opacity: 0 })
  })

  it('覆盖档停车帧只能是纯平移:不得含缩放/旋转/斜切', async () => {
    // 覆盖档需要整张停在屏外(平移可以),但任何非平移变换都会污染
    // 内核尺寸测量,同仿真档的理由。
    const seen: { frames: Keyframe[]; opts: { duration: number; fill: string } }[] = []
    const host = recordingHost(seen)
    await animatePageTurn(host, 'cover', 'next', async () => {})
    const park = seen[1]!.frames[0]!
    expect(String(park.transform)).toMatch(/^translateX\(-?\d+%\)$/)
  })

  it('没有动画计划的档位(无)直接翻页,不碰 WAAPI', async () => {
    const calls: string[] = []
    const host = fakeHost(() => {
      calls.push('anim')
      return { finished: Promise.resolve(), cancel: () => {} }
    })
    await animatePageTurn(host, 'none', 'next', async () => {
      calls.push('flip')
    })
    expect(calls).toEqual(['flip'])
  })

  it('引擎不支持 element.animate(jsdom / 旧内核)时直接翻页', async () => {
    const calls: string[] = []
    const host = fakeHost(undefined)
    await animatePageTurn(host, 'cover', 'next', async () => {
      calls.push('flip')
    })
    expect(calls).toEqual(['flip'])
  })

  it('内核翻页抛错也不会把页面钉在半路:动画被取消(fill 清掉)', async () => {
    const cancelled: unknown[] = []
    const host = fakeHost(() => {
      const anim = {
        finished: Promise.reject(new Error('kernel broke')),
        cancel: () => cancelled.push('cancel'),
      }
      // 未消费的 rejection 会让测试进程报 unhandled —— 照 real WAAPI 的
      // finished 语义包一层 catch(animatePageTurn 内部 .catch 掉)。
      anim.finished.catch(() => {})
      return anim
    })
    await expect(
      animatePageTurn(host, 'flip', 'next', async () => {
        throw new Error('kernel broke')
      }),
    ).rejects.toThrow('kernel broke')
    expect(cancelled.length).toBeGreaterThan(0)
  })
})

/**
 * TtsDrawer 契约测试。
 *
 * TtsDrawer 的播放循环(预取、重试、token 中断)与 ref 生命周期绑得紧,且依赖
 * 真 IPC + 真 <audio>,之前没有任何测试网,B1 改它的渲染路径前先补上。
 *
 * 三条替身边界:
 * 1. IPC 打桩:`tts.edge.audio` 返回假音频路径,断言合成的请求参数(文本块/
 *    voice/lang/rate)—— 这是与 Rust 端的契约面。
 * 2. `Audio` 换成可手工驱动的 FakeAudio(jsdom 的 HTMLMediaElement.play 未实现,
 *    而且真加载音频也不该发生在单测里)。用例通过 `end()` / `currentTime` 模拟
 *    播放推进。
 * 3. 不 mock speechSynthesis:默认 Edge 引擎路径碰不到它,组件里所有
 *    `window.speechSynthesis?.` 都是可选链,jsdom 没有它也能走通。
 *
 * 用假时钟驱动:切句 seek 的 60ms 延迟、音色切换的 80ms、60ms ticker 都是
 * 定时器,`advanceTimersByTimeAsync` 一并推进。
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, RefObject } from 'react'
import { invokeCommand } from '../../lib/ipc'
import { TtsDrawer, type TtsDrawerHandle } from './TtsDrawer'

type TtsDrawerProps = ComponentProps<typeof TtsDrawer>

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string): string => `asset://localhost/${path}`,
}))

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}))

const invokeMock = vi.mocked(invokeCommand)

/** 两句各 201 字:句子层每句 ≤220 不再切,块层两句 >300 字必然分成两块。 */
const SENTENCE_1 = `${'甲'.repeat(200)}。`
const SENTENCE_2 = `${'乙'.repeat(200)}。`
const SECTION_1 = SENTENCE_1 + SENTENCE_2
const SECTION_2 = '第二章的第一句。第二章的第二句。'

/** 可手工驱动的 <audio> 替身:只实现 TtsDrawer 摸得到的那层契约。 */
class FakeAudio {
  static instances: FakeAudio[] = []

  src: string
  duration = 10
  currentTime = 0
  paused = true
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  readonly play = vi.fn((): Promise<void> => {
    this.paused = false
    // 真浏览器在 play() 之后异步回调 metadata;同步给,用例好推进。
    this.onloadedmetadata?.()
    return Promise.resolve()
  })
  readonly pause = vi.fn((): void => {
    this.paused = true
  })

  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  /** 测试驱动:这一块播完了。 */
  end(): void {
    this.paused = true
    this.onended?.()
  }

  static get current(): FakeAudio {
    const instance = FakeAudio.instances.at(-1)
    if (instance === undefined) throw new Error('还没有音频实例被创建:播放没有真正开始')
    return instance
  }
}

function respond(command: string, index: number): unknown {
  switch (command) {
    case 'ai.config.list':
      return { providers: [] }
    case 'tts.edge.voices':
      return { voices: [] }
    case 'tts.edge.audio':
      return { path: `/tmp/tts-${index}.mp3` }
    default:
      return undefined
  }
}

function makeProps(overrides: Partial<TtsDrawerProps> = {}): TtsDrawerProps {
  return {
    bookHash: 'h'.repeat(64),
    bookTitle: '测试书',
    bookLanguage: 'zh',
    coverUrl: null,
    sectionLabel: '第一章',
    minimized: false,
    onPlayingChange: vi.fn(),
    getSectionText: vi.fn(async () => SECTION_1),
    jumpSection: vi.fn(async () => true),
    onHighlight: vi.fn(),
    onExpand: vi.fn(),
    onMinimize: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

/** 推进微任务与挂载期 effect;run() 内部的 await 链全是微任务,一冲到底。 */
async function flush(): Promise<void> {
  await act(async () => {})
}

/** 推进真实定时器(切句 60ms / 音色切换 80ms / ticker 60ms)。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function synthCalls(): readonly unknown[] {
  return invokeMock.mock.calls.filter(([command]) => command === 'tts.edge.audio')
}

function currentSentence(): string | null {
  return document.querySelector('.tts-sentence-item.is-current')?.textContent ?? null
}

function sentenceTexts(): readonly string[] {
  return [...document.querySelectorAll('.tts-sentence-item')].map(
    (node) => node.textContent ?? '',
  )
}

/** 点语速下拉的第 N 档(rate 选项 label 形如 "1.5×")。 */
async function chooseRate(label: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '语速选择' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }))
  await flush()
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  FakeAudio.instances.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  let audioIndex = 0
  invokeMock.mockReset()
  invokeMock.mockImplementation(
    (command) => Promise.resolve(respond(command as string, audioIndex++)) as never,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('待机与播放', () => {
  it('待机态不合成任何音频,父层先收到 playing=false', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    expect(synthCalls()).toHaveLength(0)
    expect(props.onPlayingChange).toHaveBeenCalledWith(false)
    expect(screen.getByText('待机')).toBeInTheDocument()
  })

  it('播放:按块合成第一块(edge 参数齐全),句子列表逐句渲染,首句 current', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    expect(synthCalls()).toEqual([
      [
        'tts.edge.audio',
        { text: SENTENCE_1, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1 },
      ],
    ])
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument()
    expect(sentenceTexts()).toEqual([SENTENCE_1, SENTENCE_2])
    expect(currentSentence()).toBe(SENTENCE_1)
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(true)
    // 句级高亮广播:父层把高亮打回正文并触发自动翻页。
    expect(props.onHighlight).toHaveBeenCalledWith({
      mode: 'sentence',
      start: 0,
      end: SENTENCE_1.length,
      color: '#f5d76e',
    })
  })

  it('块播完自动接下一块,当前句随之推进', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await act(async () => {
      FakeAudio.current.end()
    })
    await flush()

    expect(synthCalls()).toHaveLength(2)
    expect(synthCalls()[1]).toEqual([
      'tts.edge.audio',
      { text: SENTENCE_2, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1 },
    ])
    expect(currentSentence()).toBe(SENTENCE_2)
    expect(props.onHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: SENTENCE_1.length }),
    )
  })

  it('章末连读(默认开):最后一块播完自动跳下一章接着播', async () => {
    const props = makeProps({
      getSectionText: vi.fn().mockResolvedValueOnce(SECTION_1).mockResolvedValue(SECTION_2),
    })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await act(async () => {
      FakeAudio.current.end()
    })
    await flush()
    await act(async () => {
      FakeAudio.current.end()
    })
    await flush()

    expect(props.jumpSection).toHaveBeenCalledWith(1)
    expect(synthCalls()).toHaveLength(3)
    expect(synthCalls()[2]).toEqual([
      'tts.edge.audio',
      { text: SECTION_2, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1 },
    ])
  })

  it('关掉「连读下一章」:章末停止而不是跳章', async () => {
    localStorage.setItem(
      'deepread.tts.settings',
      JSON.stringify({ autoNext: false }),
    )
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await act(async () => {
      FakeAudio.current.end()
    })
    await flush()
    await act(async () => {
      FakeAudio.current.end()
    })
    await flush()

    expect(props.jumpSection).not.toHaveBeenCalled()
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('待机')).toBeInTheDocument()
  })
})

describe('渲染优化(60ms ticker 不触发整抽屉重渲染)', () => {
  it('句内推进:进度条与时钟经 DOM 直写更新,当前句不翻转', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const seek = screen.getByRole('slider', { name: '本章播放进度' }) as HTMLInputElement
    const elapsed = document.querySelector('.tts-clock')!
    expect(seek.value).toBe('0')

    // 半块处仍在第一句内:React 状态此时不应提交,但进度条/时钟必须走直写前进。
    FakeAudio.current.currentTime = 5
    await advance(60)
    expect(seek.value).not.toBe('0')
    expect(elapsed.textContent).not.toBe('0:00')
    expect(currentSentence()).toBe(SENTENCE_1)
  })
})

describe('暂停与继续', () => {
  it('暂停拆不动合成进度;继续只 audio.play(),不重新合成', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const callsAfterStart = synthCalls().length

    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(FakeAudio.current.pause).toHaveBeenCalled()
    // paused 对父层仍是「非 idle」:迷你播放条要保留,只有真正停止才回落 false。
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: '播放' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    expect(FakeAudio.current.play).toHaveBeenCalledTimes(2)
    expect(synthCalls()).toHaveLength(callsAfterStart)
  })
})

describe('切句与切章', () => {
  it('下一句:中断当前块,60ms 后从下一句起点重新合成', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '下一句' }))
    await advance(60)
    await flush()

    expect(synthCalls()).toHaveLength(2)
    expect(synthCalls()[1]).toEqual([
      'tts.edge.audio',
      { text: SENTENCE_2, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1 },
    ])
    expect(currentSentence()).toBe(SENTENCE_2)
  })

  it('上一句:跨块回跳到上一句开头', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await act(async () => {
      FakeAudio.current.end()
    })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '上一句' }))
    await advance(60)
    await flush()

    expect(currentSentence()).toBe(SENTENCE_1)
    // 第三次合成:块1(自动接块2 一次 + 回跳重合成一次)。
    expect(synthCalls()).toHaveLength(3)
    expect(synthCalls()[2]).toEqual([
      'tts.edge.audio',
      { text: SENTENCE_1, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1 },
    ])
  })

  it('下一章:停当前章、跳新章、旧音频被拆除', async () => {
    const props = makeProps({
      getSectionText: vi.fn().mockResolvedValueOnce(SECTION_1).mockResolvedValue(SECTION_2),
    })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '下一章' }))
    await flush()

    expect(props.jumpSection).toHaveBeenCalledWith(1)
    expect(synthCalls()).toHaveLength(2)
    expect(synthCalls()[1]).toEqual([
      'tts.edge.audio',
      { text: SECTION_2, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1 },
    ])
    expect(FakeAudio.instances).toHaveLength(2)
    // 旧块的音频在切章时已被软中断拆除。
    expect(FakeAudio.instances[0]!.src).toBe('')
  })
})

describe('取消与收起', () => {
  it('Escape 收起为迷你条;迷你条上可展开', async () => {
    const props = makeProps()
    const view = render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onMinimize).toHaveBeenCalledTimes(1)

    // 父层按 minimized=true 重渲染 → 迷你条;点开走 onExpand。
    view.rerender(<TtsDrawer {...props} minimized />)
    fireEvent.click(screen.getByTitle('展开播放器'))
    expect(props.onExpand).toHaveBeenCalledTimes(1)
  })

  it('抽屉上的 × 通知父层停止并关闭', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByTitle('停止并关闭'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('handle.stop():音频拆除、清空句子、父层收到 playing=false', async () => {
    const props = makeProps()
    const ref: RefObject<TtsDrawerHandle | null> = { current: null }
    render(<TtsDrawer ref={ref} {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    act(() => {
      ref.current?.stop()
    })
    expect(FakeAudio.current.pause).toHaveBeenCalled()
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('待机')).toBeInTheDocument()
    expect(sentenceTexts()).toEqual([])
  })

  it('卸载 cleanup:暂停音频并断开 src,不留发声实例', async () => {
    const props = makeProps()
    const view = render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const audio = FakeAudio.current

    view.unmount()
    expect(audio.pause).toHaveBeenCalled()
    expect(audio.src).toBe('')
  })
})

describe('setRate stopped 守卫', () => {
  it('待机时改语速不触发任何合成', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    await chooseRate('1.5×')
    await advance(200)

    expect(synthCalls()).toHaveLength(0)
  })

  it('播放中改语速:软中断当前块,以新语速从当前位置续播', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await chooseRate('1.5×')
    await advance(80)
    await flush()

    expect(synthCalls()).toHaveLength(2)
    expect(synthCalls()[1]).toEqual([
      'tts.edge.audio',
      { text: SENTENCE_1, voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh', rate: 1.5 },
    ])
  })
})

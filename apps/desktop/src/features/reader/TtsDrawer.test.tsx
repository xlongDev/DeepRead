/**
 * TtsDrawer 契约测试。
 *
 * TtsDrawer 的播放循环(起播、切句、连读、定时)与 ref 生命周期绑得紧,且依赖
 * 真 IPC + 真 Web Audio,这里用替身驱动:
 *
 * 1. IPC 打桩:`tts.edge.audio` 返回假音频(base64)+ 按文本摊分的词表,
 *    断言合成的请求参数(文本/voice/lang;rate 不再进请求 —— 变速在播音
 *    侧完成,这是新管线的前提)。
 * 2. Web Audio 换成可手工驱动的 FakeAudioContext/FakeSource(jsdom 没有
 *    AudioContext):`end()` 播完一段,`currentTime` + rAF 冲刷推词边界。
 * 3. `speechSynthesis` 不 mock:默认 Edge 引擎路径碰不到它,组件里所有
 *    `window.speechSynthesis?.` 都是可选链,jsdom 没有它也能走通。
 *
 * 用假时钟驱动:切句 seek 的 60ms、ticker 60ms、音色切换的 60ms 都是定时器,
 * `advanceTimersByTimeAsync` 一并推进;rAF 由本文件自己排空。
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, RefObject } from 'react'
import { invokeCommand } from '../../lib/ipc'
import { resetSharedAudioForTests } from './tts/audio'
import { TtsDrawer, type TtsDrawerHandle } from './TtsDrawer'

type TtsDrawerProps = ComponentProps<typeof TtsDrawer>

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string): string => `asset://localhost/${path}`,
}))

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}))

const invokeMock = vi.mocked(invokeCommand)

/** 两句各 201 字:句子层每句 ≤220 不再切,一句一个单元。 */
const SENTENCE_1 = `${'甲'.repeat(200)}。`
const SENTENCE_2 = `${'乙'.repeat(200)}。`
const SECTION_1 = SENTENCE_1 + SENTENCE_2
const SECTION_2 = '第二章的第一句。第二章的第二句。'

/** 按文本摊分的词表:每 2 字一个词,`at` 每次 +0.1s —— wordCues 向前匹配。 */
function wordsFor(text: string): { at: number; text: string }[] {
  const words: { at: number; text: string }[] = []
  for (let at = 0; at + 2 <= text.length; at += 2) {
    words.push({ at: (at / 2) * 0.1, text: text.slice(at, at + 2) })
  }
  return words
}

/* -------------------------------------------------------------------------- */
/* Web Audio 替身                                                              */
/* -------------------------------------------------------------------------- */

/** 可手工驱动的 BufferSource:`end()` 播完这一段。 */
class FakeSource {
  static instances: FakeSource[] = []

  buffer: AudioBuffer | null = null
  started = false
  stopped = false
  onended: (() => void) | null = null
  /** 起播时宿主上下文是否挂起 —— WebKit 的静默失败:start() 照常调用,
   *  喇叭没声,还没有任何报错。 */
  host: FakeAudioContext | null = null

  constructor() {
    FakeSource.instances.push(this)
  }

  readonly connect = (): void => {}
  readonly disconnect = (): void => {}
  readonly start = (): void => {
    this.started = true
    if (this.host !== null && this.host.state !== 'running') {
      this.host.startedWhileSuspended += 1
    }
  }
  readonly stop = (): void => {
    this.stopped = true
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'ended') this.onended = fn
  }

  /** 测试驱动:这一单元播完了。 */
  end(): void {
    this.onended?.()
  }

  static get current(): FakeSource {
    const instance = FakeSource.instances.at(-1)
    if (instance === undefined) throw new Error('还没有音频源被创建:播放没有真正开始')
    return instance
  }
}

/** 可手工驱动的 AudioContext:`currentTime` 由用例推进,rAF 由排空器驱动。 */
class FakeAudioContext {
  static latest: FakeAudioContext | null = null
  /** WebKit 模式:手势之外构造 = 挂起,手势之外 resume 无效(静默)。
   *  默认关 —— 只有显式建模 WebKit 的用例打开。 */
  static strictGestures = false
  static gestureDepth = 0
  /** 把一段同步代码包进「用户手势」里(WebKit 的 UserGestureIndicator)。 */
  static withGesture<T>(fn: () => T): T {
    FakeAudioContext.gestureDepth += 1
    try {
      return fn()
    } finally {
      FakeAudioContext.gestureDepth -= 1
    }
  }

  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  readonly destination = {}
  /** 在挂起的上下文上起播的源数 —— 恒为 0 才算真有声。 */
  startedWhileSuspended = 0

  constructor() {
    FakeAudioContext.latest = this
    this.state =
      FakeAudioContext.strictGestures && FakeAudioContext.gestureDepth === 0
        ? 'suspended'
        : 'running'
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
      copyToChannel: () => {},
    } as unknown as AudioBuffer
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource()
    source.host = this
    return source as unknown as AudioBufferSourceNode
  }

  decodeAudioData(): Promise<AudioBuffer> {
    return Promise.resolve(this.createBuffer(1, 24_000, 24_000))
  }

  resume(): Promise<void> {
    if (!FakeAudioContext.strictGestures || FakeAudioContext.gestureDepth > 0) {
      this.state = 'running'
    }
    return Promise.resolve()
  }

  suspend(): Promise<void> {
    this.state = 'suspended'
    return Promise.resolve()
  }
}

/** rAF 替身:回调排队,由 flushRaf 统一驱动(引擎的跟词循环每帧重注册)。 */
const rafQueue = new Map<number, FrameRequestCallback>()
let rafId = 0

function flushRaf(): void {
  const pending = [...rafQueue.values()]
  rafQueue.clear()
  for (const callback of pending) callback(0)
}

function respond(command: string, request?: Record<string, unknown>): unknown {
  switch (command) {
    case 'ai.config.list':
      return { providers: [] }
    case 'tts.edge.voices':
      return { voices: [] }
    case 'tts.edge.audio':
      return {
        audio: 'AAAA',
        words: wordsFor(String(request?.['text'] ?? '')),
        cached: false,
      }
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
  await act(async () => {
    flushRaf()
  })
}

/** 形态切换退场窗口(TtsDrawer 的 LEAVE_MS)+ 一点余量。 */
const LEAVE_TEST_MS = 250

/** 推进真实定时器(seek 60ms / ticker 60ms)与 rAF 跟词循环。
 *  先冲刷 rAF:跟词循环报回的词边界是 ticker 的输入,顺序反了 ticker 读到的
 *  还是上一个位置的旧值。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    flushRaf()
    await vi.advanceTimersByTimeAsync(ms)
    flushRaf()
  })
}

/** 播完当前单元(合成/解码都是微任务,flush 后 FakeSource.current 即当前段)。 */
async function endUnit(): Promise<void> {
  await act(async () => {
    FakeSource.current.end()
  })
  await flush()
}

function synthRequests(): readonly { text: string; voice: string; lang?: string }[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'tts.edge.audio')
    .map(([, request]) => request as { text: string; voice: string; lang?: string })
}

function synthTexts(): readonly string[] {
  return synthRequests().map((request) => request.text)
}

function currentSentence(): string | null {
  return document.querySelector('.tts-sentence-item.is-current')?.textContent ?? null
}

function sentenceTexts(): readonly string[] {
  return [...document.querySelectorAll('.tts-sentence-item')].map((node) => node.textContent ?? '')
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
  FakeSource.instances.length = 0
  FakeAudioContext.latest = null
  FakeAudioContext.strictGestures = false
  FakeAudioContext.gestureDepth = 0
  // 共享音频上下文是模块级状态:每个用例都从「没有上下文」开始,否则上一个
  // 用例的(可能已挂起的)上下文会渗进来。
  resetSharedAudioForTests()
  rafQueue.clear()
  rafId = 0
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafId += 1
    rafQueue.set(rafId, callback)
    return rafId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id)
  })
  invokeMock.mockReset()
  invokeMock.mockImplementation(
    (command, request) => Promise.resolve(respond(command as string, request)) as never,
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
    expect(synthRequests()).toHaveLength(0)
    expect(props.onPlayingChange).toHaveBeenCalledWith(false)
    expect(screen.getByText('待机')).toBeInTheDocument()
  })

  it('播放:按单元合成第一句(edge 参数不含 rate),句子列表逐句渲染,首句 current', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    // rate 不再进请求:所有片段按 1.0 合成,变速在播音侧完成。
    expect(synthRequests()[0]).toEqual({
      text: SENTENCE_1,
      voice: 'zh-CN-XiaoxiaoNeural',
      lang: 'zh',
    })
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

  it('播放钮必须在手势内解锁音频:WebKit 模式下首源起播时上下文是 running', async () => {
    // WebKit 只认手势内创建/恢复的 AudioContext。首次播放时上下文是在
    // 合成 IPC 返回之后才创建的 —— 那时点击的手势早已过期,不在这点击里
    // 先解锁,「界面说在播、喇叭没声」就复现(读者只能暂停再继续才听得见)。
    FakeAudioContext.strictGestures = true
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    FakeAudioContext.withGesture(() => {
      fireEvent.click(screen.getByRole('button', { name: '播放' }))
    })
    await flush()

    // 「真有声」= 源真的排上了,且起播时上下文在跑。
    expect(FakeSource.instances.filter((source) => source.started).length).toBeGreaterThan(0)
    expect(FakeAudioContext.latest!.state).toBe('running')
    expect(FakeAudioContext.latest!.startedWhileSuspended).toBe(0)
  })

  it('预取下一单元:起播即合成 AHEAD 范围内的后续句', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    expect(synthTexts()).toContain(SENTENCE_1)
    expect(synthTexts()).toContain(SENTENCE_2)
  })

  it('一句播完自动接下一句,当前句随之推进', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await endUnit()

    expect(currentSentence()).toBe(SENTENCE_2)
    expect(props.onHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: SENTENCE_1.length }),
    )
  })

  it('章末连读(默认开):最后一句播完自动跳下一章接着播', async () => {
    const props = makeProps({
      getSectionText: vi.fn().mockResolvedValueOnce(SECTION_1).mockResolvedValue(SECTION_2),
    })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await endUnit()
    await endUnit()

    expect(props.jumpSection).toHaveBeenCalledWith(1)
    expect(synthTexts()).toContain('第二章的第一句。')
    expect(synthTexts()).toContain('第二章的第二句。')
  })

  it('关掉「连读下一章」:章末停止而不是跳章', async () => {
    localStorage.setItem('deepread.tts.settings', JSON.stringify({ autoNext: false }))
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await endUnit()
    await endUnit()

    expect(props.jumpSection).not.toHaveBeenCalled()
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('待机')).toBeInTheDocument()
  })
})

describe('词边界与进度(60ms ticker 不触发整抽屉重渲染)', () => {
  it('词内推进:进度条与时钟经 DOM 直写更新,当前句不翻转', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const seek = screen.getByRole('slider', { name: '本章播放进度' }) as HTMLInputElement
    const elapsed = document.querySelector('.tts-clock')!
    expect(seek.value).toBe('0')

    // 播放时钟走到 5s:跟词循环报回词边界,ticker 直写进度条。
    FakeAudioContext.latest!.currentTime = 5
    await advance(60)
    expect(seek.value).not.toBe('0')
    expect(elapsed.textContent).not.toBe('0:00')
    expect(currentSentence()).toBe(SENTENCE_1)
  })

  it('词级高亮:切到词级后,父层收到词区间而不是整句', async () => {
    localStorage.setItem('deepread.tts.settings', JSON.stringify({ highlightMode: 'word' }))
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    vi.mocked(props.onHighlight!).mockClear()
    FakeAudioContext.latest!.currentTime = 1
    await advance(60)

    // 1s 处落在第 10 个词(每词 0.1s、2 字):区间是章内的 20..22。
    expect(props.onHighlight).toHaveBeenLastCalledWith({
      mode: 'word',
      start: 20,
      end: 22,
      color: '#f5d76e',
    })
  })
})

describe('暂停与继续', () => {
  it('暂停挂起音频上下文;继续只 resume,不重新合成', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const callsAfterStart = synthRequests().length

    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(FakeAudioContext.latest!.state).toBe('suspended')
    // paused 对父层仍是「非 idle」:迷你播放条要保留,只有真正停止才回落 false。
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: '播放' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    expect(FakeAudioContext.latest!.state).toBe('running')
    expect(synthRequests()).toHaveLength(callsAfterStart)
  })
})

describe('切句与切章', () => {
  it('下一句:中断当前句,60ms 后从下一句起点起播', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '下一句' }))
    await advance(60)
    await flush()

    expect(currentSentence()).toBe(SENTENCE_2)
    expect(synthTexts()).toContain(SENTENCE_2)
  })

  it('上一句:回到上一句开头', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    await endUnit()
    fireEvent.click(screen.getByRole('button', { name: '上一句' }))
    await advance(60)
    await flush()

    expect(currentSentence()).toBe(SENTENCE_1)
  })

  it('下一章:停当前章、跳新章、旧音频源被拆除', async () => {
    const props = makeProps({
      getSectionText: vi.fn().mockResolvedValueOnce(SECTION_1).mockResolvedValue(SECTION_2),
    })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const stale = FakeSource.current
    fireEvent.click(screen.getByRole('button', { name: '下一章' }))
    await flush()

    expect(props.jumpSection).toHaveBeenCalledWith(1)
    expect(synthTexts()).toContain('第二章的第一句。')
    // 旧音频源在切章时已被软中断拆除。
    expect(stale.stopped).toBe(true)
  })
})

/** 两字符空间的分界测试:8 个 4 字句,句间各一个 `\n`(章=块级元素拼接,
 *  每个块后补 `\n`,但单元文本不含 `\n` —— 累加长度与真实偏移从此分叉)。
 *  累加空间:单元 k 占 [4k, 4k+4);真实空间:单元 k 起点 5k。
 *  第 4 单元(戊戊戊。)真实起点 20,恰好落进累加空间的第 5 单元区间 ——
 *  旧编排把真实偏移喂 unitAtChar 反推单元,会洗到下一句(己己己。,25)。 */
const PARAGRAPHS = '甲甲甲。\n乙乙乙。\n丙丙丙。\n丁丁丁。\n戊戊戊。\n己己己。\n庚庚庚。\n辛辛辛。'

describe('多段章节(换行不污染洗色)', () => {
  it('句级高亮按引擎单元洗真实偏移,不漂移到还没读的句子', async () => {
    const props = makeProps({ getSectionText: vi.fn(async () => PARAGRAPHS) })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    for (let i = 0; i < 4; i += 1) await endUnit()

    // 引擎读到第 4 单元(戊戊戊。,真实 20..24):洗它,不是累加空间反推的第 5 单元。
    expect(props.onHighlight).toHaveBeenLastCalledWith({
      mode: 'sentence',
      start: 20,
      end: 24,
      color: '#f5d76e',
    })
    const starts = vi
      .mocked(props.onHighlight!)
      .mock.calls.map(([arg]) => arg)
      .filter((arg) => arg !== null)
      .map((arg) => arg.start)
    expect(starts).not.toContain(25)
  })

  it('词级高亮跟引擎词边界,换行章节里不整句失效', async () => {
    localStorage.setItem('deepread.tts.settings', JSON.stringify({ highlightMode: 'word' }))
    const props = makeProps({ getSectionText: vi.fn(async () => PARAGRAPHS) })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    for (let i = 0; i < 4; i += 1) await endUnit()
    vi.mocked(props.onHighlight!).mockClear()

    // 第 4 单元 startedAt=0(假时钟未推进);两个词各 0.1s。wall 0.15s × tempo 1
    // = 第 2 个词(单元内 2..4)→ 章节坐标 22..24。词没变时引擎不上报,
    // 所以先推进到第二个词再断言。
    FakeAudioContext.latest!.currentTime = 0.15
    await advance(60)
    expect(props.onHighlight).toHaveBeenLastCalledWith({
      mode: 'word',
      start: 22,
      end: 24,
      color: '#f5d76e',
    })
  })
})

/** 划词工具的「朗读此处」:handle.speakFromText。两次用户回归都出在这条
 *  路径上(点了没反应 / 从章首念),它是 TtsDrawer 对外的第二个入口。 */
describe('speakFromText(划词工具入口)', () => {
  it('从包含该文本的那一句起播,不等用户按播放', async () => {
    const props = makeProps()
    const ref: RefObject<TtsDrawerHandle | null> = { current: null }
    render(<TtsDrawer ref={ref} {...props} />)
    await flush()

    act(() => {
      ref.current?.speakFromText(SENTENCE_2, null)
    })
    await flush()

    // 起播即合成第二句:第一句连预取都不该发生(origin 就是第二句)。
    expect(synthTexts()).toContain(SENTENCE_2)
    expect(synthTexts()).not.toContain(SENTENCE_1)
    expect(currentSentence()).toBe(SENTENCE_2)
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument()
  })

  it('选区盖住半句:从包含选区开头的那一句起播', async () => {
    const props = makeProps()
    const ref: RefObject<TtsDrawerHandle | null> = { current: null }
    render(<TtsDrawer ref={ref} {...props} />)
    await flush()

    // 第二句中间的一小节(前 8 字落在第二句内)。
    const middle = SENTENCE_2.slice(100, 140)
    act(() => {
      ref.current?.speakFromText(middle, null)
    })
    await flush()

    expect(currentSentence()).toBe(SENTENCE_2)
  })

  it('有字符偏移时按偏移走:文本匹配会错定的重复句也不跑偏', async () => {
    // 章内 SENTENCE_2 出现两次,选区划的是第二次 —— 文本匹配(整句覆盖)
    // 只能找到第一次,内核报来的偏移是 exact 的。
    const repeated = SENTENCE_2 + SENTENCE_1 + SENTENCE_2
    const props = makeProps({ getSectionText: vi.fn(async () => repeated) })
    const ref: RefObject<TtsDrawerHandle | null> = { current: null }
    render(<TtsDrawer ref={ref} {...props} />)
    await flush()

    act(() => {
      ref.current?.speakFromText(SENTENCE_2, SENTENCE_2.length + SENTENCE_1.length)
    })
    await flush()

    expect(currentSentence()).toBe(SENTENCE_2)
    // 从第一次出现起播才会把中间那句也合成进去。
    expect(synthTexts()).not.toContain(SENTENCE_1)
  })

  it('匹配不到(选区跨章/文本被改)时从章首起播,而不是不出声', async () => {
    const props = makeProps()
    const ref: RefObject<TtsDrawerHandle | null> = { current: null }
    render(<TtsDrawer ref={ref} {...props} />)
    await flush()

    act(() => {
      ref.current?.speakFromText('完全不在本章里的一句话', null)
    })
    await flush()

    expect(currentSentence()).toBe(SENTENCE_1)
    expect(synthTexts()).toContain(SENTENCE_1)
  })
})

describe('取消与收起', () => {
  it('Escape 收起为迷你条;迷你条上可展开', async () => {
    const props = makeProps()
    const view = render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onMinimize).toHaveBeenCalledTimes(1)

    // 父层按 minimized=true 重渲染:先播 190ms 完整抽屉退场,然后换迷你条。
    view.rerender(<TtsDrawer {...props} minimized />)
    await advance(LEAVE_TEST_MS)
    // 点开走 onExpand(迷你条上两个展开入口:标题区与展开钮)。
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

  it('handle.stop():音频源拆除、清空句子、父层收到 playing=false', async () => {
    const props = makeProps()
    const ref: RefObject<TtsDrawerHandle | null> = { current: null }
    render(<TtsDrawer ref={ref} {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const source = FakeSource.current

    act(() => {
      ref.current?.stop()
    })
    expect(source.stopped).toBe(true)
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('待机')).toBeInTheDocument()
    expect(sentenceTexts()).toEqual([])
  })

  it('卸载 cleanup:停止音频源,不留发声实例', async () => {
    const props = makeProps()
    const view = render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const source = FakeSource.current

    view.unmount()
    expect(source.stopped).toBe(true)
  })
})

describe('语速(变速不重合成)', () => {
  it('待机时改语速不触发任何合成', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    await chooseRate('1.5×')
    await advance(200)

    expect(synthRequests()).toHaveLength(0)
  })

  it('播放中改语速:零重新合成 —— 片段按 1.0 合成,变速在播音侧完成', async () => {
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    const before = synthRequests().length

    await chooseRate('1.5×')
    await advance(200)
    await flush()

    expect(synthRequests()).toHaveLength(before)
    // 播放不中断:仍显示暂停键。
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument()
  })

  it('播放中改语速:下一段按新 tempo 跟词,高亮跟上语速', async () => {
    // 词级高亮:onHighlight 的区间就是引擎报回的词位置,直接可断言。
    localStorage.setItem('deepread.tts.settings', JSON.stringify({ highlightMode: 'word' }))
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    // 第一段 tempo=1:clock 走到 1s → 第 10 个词(每词 0.1s、2 字)。
    FakeAudioContext.latest!.currentTime = 1
    await advance(60)
    expect(props.onHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'word', start: 20, end: 22 }),
    )

    // 切到 2×:当前段按旧 tempo 读完(设计如此),推队列进第二段。
    await chooseRate('2×')
    await endUnit()

    // 第二段 startedAt=1;wall clock 再走 1s × tempo 2 = rate-1.0 时间轴 2s
    // → 第 20 个词 → 单元内 charIndex 40 → 章节坐标 201+40。
    FakeAudioContext.latest!.currentTime = 2
    await advance(60)
    expect(props.onHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'word', start: 241, end: 243 }),
    )
  })
})

describe('多角色听书', () => {
  /** 两段台词各自被邻近叙述里唯一的人名认领。 */
  const DIALOGUE = '青柳说:「谢谢你。」雅子回答:「不用谢。」两人沉默了。'
  const NAMES = ['青柳', '雅子']

  function respondWithCharacters(command: string, request?: Record<string, unknown>): unknown {
    if (command === 'ai.artifact.get') {
      return { payload: { characters: NAMES.map((name) => ({ name })) }, createdAt: null }
    }
    return respond(command, request)
  }

  it('角色句用角色音色,叙述句用叙述者音色(缓存按音色分开存,互不覆盖)', async () => {
    localStorage.setItem(
      'deepread.tts.settings',
      JSON.stringify({
        speakerVoices: {
          青柳: { edge: 'zh-CN-YunxiNeural' },
          雅子: { edge: 'zh-CN-XiaoyiNeural' },
        },
      }),
    )
    invokeMock.mockImplementation(
      (command, request) =>
        Promise.resolve(respondWithCharacters(command as string, request)) as never,
    )
    const props = makeProps({ getSectionText: vi.fn(async () => DIALOGUE) })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()
    // 预取窗口只有两句:往队列后面推,雅子的音色才会被合成。
    await endUnit()
    await endUnit()
    await endUnit()

    const voices = synthRequests().map((request) => request.voice)
    expect(voices).toContain('zh-CN-YunxiNeural')
    expect(voices).toContain('zh-CN-XiaoyiNeural')
    // 叙述部分仍是叙述者音色,不会被角色音色顶掉。
    expect(voices).toContain('zh-CN-XiaoxiaoNeural')
  })

  it('没抽过角色图谱时全书走单一叙述音色,不凭空造角色', async () => {
    const props = makeProps({ getSectionText: vi.fn(async () => DIALOGUE) })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    const requests = synthRequests()
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.voice === 'zh-CN-XiaoxiaoNeural')).toBe(true)
  })

  it('角色页签只在真的认领到角色时出现', async () => {
    invokeMock.mockImplementation(
      (command, request) =>
        Promise.resolve(respondWithCharacters(command as string, request)) as never,
    )
    const props = makeProps({ getSectionText: vi.fn(async () => DIALOGUE) })
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    fireEvent.click(screen.getByTitle('选择语音'))
    const rolesTab = screen.getByRole('button', { name: /角色 2/ })
    expect(rolesTab).toBeInTheDocument()
    fireEvent.click(rolesTab)
    // 角色行 = 名字 + 出现单元数,音色选择器在里面。
    expect(screen.getByText(/青柳/)).toBeInTheDocument()
    expect(screen.getByText(/雅子/)).toBeInTheDocument()
    expect(screen.getByLabelText('青柳 的音色')).toBeInTheDocument()
  })
})

describe('云端引擎', () => {
  it('走 tts.audio 取缓存文件并解码播放(无词表 → 句级洗色)', async () => {
    localStorage.setItem('deepread.tts.settings', JSON.stringify({ engine: 'cloud' }))
    const fetchMock = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(16) }))
    vi.stubGlobal('fetch', fetchMock)
    invokeMock.mockImplementation((command, request) => {
      if (command === 'ai.config.list') {
        return Promise.resolve({
          providers: [{ id: 'cfg-1', name: '测试服务', ttsModel: 'tts-1' }],
        }) as never
      }
      if (command === 'tts.audio') {
        return Promise.resolve({ path: '/tmp/tts-cloud.mp3', cached: false }) as never
      }
      return Promise.resolve(respond(command as string, request)) as never
    })
    const props = makeProps()
    render(<TtsDrawer {...props} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    await flush()

    const cloudCalls = invokeMock.mock.calls.filter(([command]) => command === 'tts.audio')
    expect(cloudCalls.length).toBeGreaterThan(0)
    // speed 恒为 1:变速在播音侧,缓存键因此与语速无关。
    expect((cloudCalls[0]![1] as { speed: number }).speed).toBe(1)
    expect(fetchMock).toHaveBeenCalled()
    expect(FakeSource.current.started).toBe(true)
  })
})

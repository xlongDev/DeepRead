/**
 * 「朗读此处」端到端接线:ReaderScreen 的划词工具 → 真 TtsDrawer → 合成请求。
 *
 * ReaderScreen.test.tsx 把三个抽屉都替身化了(那层测试锁的是 ReaderScreen 自己
 * 的接线);本文件反其道而行 —— 只替身 IPC 与 Web Audio,TtsDrawer 用真的。
 * 理由是这条链路过两次用户回归:「点了朗读没反应」「从章首开始念」,而两层
 * 各自的单测都是绿的:断点只在**两层之间**(pendingSpeak → ref → speakFromText),
 * 替身化的测试永远看不见它。
 *
 * 断言落在合成请求上:起点对了,第一句合成的就是划线所在的那一句。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { AppInfo } from '@deepread/shared'
import type { OpenedBook } from '../../lib/book-import'
import { invokeCommand } from '../../lib/ipc'
import { resetSharedAudioForTests } from './tts/audio'
import { FakeFoliateAdapter, latestAdapter } from '../../test/fake-foliate'
import { ReaderScreen } from './ReaderScreen'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string): string => `asset://localhost/${path}`,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    listen: vi.fn(async (): Promise<() => void> => () => undefined),
    isFullscreen: vi.fn(async () => false),
    setFullscreen: vi.fn(async () => undefined),
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
}))

vi.mock('../../lib/reading-stats', () => ({
  reportReadingTime: vi.fn(async () => undefined),
}))

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  invokeStreamingCommand: vi.fn(),
  isTauriRuntime: vi.fn((): boolean => true),
}))

vi.mock('@deepread/reader-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepread/reader-adapter')>()
  const { FakeFoliateAdapter: Fake } = await import('../../test/fake-foliate')
  return { ...actual, FoliateAdapter: Fake }
})

vi.mock('./reader-options', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reader-options')>()
  return { ...actual, loadTypography: () => ({}) }
})

// 三个抽屉只替身 Ai / Learning —— TtsDrawer 必须是真的。
vi.mock('./AiDrawer', () => ({ AiDrawer: () => <div data-testid="ai" /> }))
vi.mock('./LearningDrawer', () => ({ LearningDrawer: () => <div data-testid="learning" /> }))

const invokeMock = vi.mocked(invokeCommand)

const APP_INFO: AppInfo = {
  appName: 'DeepRead',
  appVersion: '0.2.0',
  os: 'macos',
  arch: 'aarch64',
}

const BOOK: OpenedBook = {
  bookId: 'a'.repeat(64),
  format: 'epub',
  hash: 'a'.repeat(64),
  name: '夜航书.epub',
  url: 'asset://localhost/books/夜航书.epub',
}

/** 四句一章:划第二句,起点必须是第二句。 */
const SECTION = '第一句话在这里。第二句话才是划线目标。第三句话接着念。第四句话收尾。'

function wordsFor(text: string): { at: number; text: string }[] {
  const words: { at: number; text: string }[] = []
  for (let at = 0; at + 2 <= text.length; at += 2) {
    words.push({ at: (at / 2) * 0.1, text: text.slice(at, at + 2) })
  }
  return words
}

function respond(command: string, request?: Record<string, unknown>): unknown {
  switch (command) {
    case 'app.info':
      return APP_INFO
    case 'fonts.list':
      return []
    case 'dictionary.list':
      return { dictionaries: [] }
    case 'ai.config.list':
      return { providers: [] }
    case 'reader.state.get':
      return { state: null }
    case 'cards.list':
      return { cards: [] }
    case 'tts.edge.voices':
      return { voices: [] }
    case 'tts.edge.audio':
      return { audio: 'AAAA', words: wordsFor(String(request?.['text'] ?? '')), cached: false }
    default:
      return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Web Audio 替身(与 TtsDrawer.test.tsx 同款)                                   */
/* -------------------------------------------------------------------------- */

class FakeSource {
  static instances: FakeSource[] = []
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  /** 起播时宿主上下文是否挂起 —— WebKit 的静默失败:start() 照常调用,
   *  喇叭没声,还没有任何报错。 */
  host: FakeAudioContext | null = null
  started = false
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
  readonly stop = (): void => {}
  addEventListener(type: string, fn: () => void): void {
    if (type === 'ended') this.onended = fn
  }
}

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

function synthTexts(): readonly string[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'tts.edge.audio')
    .map(([, request]) => String((request as { text: string }).text))
}

/** 合成请求之后再把宏任务队列放干。
 *
 *  抽屉卸载 cleanup 的停播排在 `setTimeout(0)`——微任务里看不见它。只断言
 *  「合成请求发生过」的测试会漏掉这样一种死法:播放起来了、紧接着被那个
 *  定时器杀死(StrictMode 重挂的 cleanup 排在起播之后)。断言必须活过这
 *  一轮宏任务才算数。 */
async function drainMacrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** 仍在播音:暂停钮在(phase=playing),待机文案不在。 */
function expectStillPlaying(): void {
  expect(screen.queryAllByTitle('暂停').length).toBeGreaterThan(0)
  expect(screen.queryByText('待机')).toBeNull()
}

beforeEach(() => {
  localStorage.clear()
  FakeSource.instances.length = 0
  // 共享音频上下文是模块级状态:每个用例都从「没有上下文」开始,否则上一个
  // 用例的(可能已挂起的)上下文会渗进来。
  resetSharedAudioForTests()
  FakeAudioContext.strictGestures = false
  FakeAudioContext.gestureDepth = 0
  FakeAudioContext.latest = null
  vi.stubGlobal('AudioContext', FakeAudioContext)
  invokeMock.mockReset()
  invokeMock.mockImplementation(
    (command, request) => Promise.resolve(respond(command as string, request)) as never,
  )
})

describe('划词工具「朗读此处」端到端', () => {
  /** main.tsx 包了 StrictMode:开发模式下抽屉挂载时 effect 会双调
   *  (setup→cleanup→setup),真实用户跑的就是这个形态。 */
  function renderReader(): ReturnType<typeof render> {
    return render(
      <StrictMode>
        <ReaderScreen book={BOOK} onBack={vi.fn()} />
      </StrictMode>,
    )
  }

  it('选中文本点朗读:直接起播,第一句合成的就是划线所在的那一句', async () => {
    FakeFoliateAdapter.nextOptions = { sections: [SECTION] }
    renderReader()
    await waitFor(() => {
      expect(document.querySelector('.reader-opening')).toBeNull()
    })
    const adapter = latestAdapter()

    // 模拟内核报来一个选区:第二句(起点偏移 8 —— 第一句占 0..7)。
    adapter.emitSelection({
      text: '第二句话才是划线目标。',
      cfi: 'epubcfi(/6/4!/4/2)',
      start: 8,
      rect: { top: 300, left: 200, height: 20 },
    })
    const toolbar = await screen.findByTestId('selection-toolbar')
    fireEvent.click(within(toolbar).getByTitle('朗读此处'))

    // 起播 = 合成请求里出现第二句,且不先合成第一句。
    await waitFor(() => {
      expect(synthTexts()).toContain('第二句话才是划线目标。')
    })
    expect(synthTexts()).not.toContain('第一句话在这里。')
    // 起播要 sustained:宏任务放干后仍在播。StrictMode 重挂的 cleanup 排在
    // 起播之后,停播定时器曾在这里把刚开始的播放杀死(用户看到的就是
    // 「点了朗读没反应,面板停待机,要手动按播放」)。
    await drainMacrotasks()
    expectStillPlaying()
  })

  it('点朗读必须同时解锁音频:WebKit 模式下源起播时上下文是 running', async () => {
    // WebKit(Safari / WKWebView —— Tauri macOS 的引擎)只在用户手势内批准
    // AudioContext 的创建与恢复。首个 clip 的合成在两次 await 之后(章节文本
    // + 供应商往返),手势早过期 —— 起播那次点击必须自己把上下文建好并恢复,
    // 否则界面说在播、喇叭没声、还没有任何报错,读者只能再点一次播放(暂停
    // 再继续,那次 resume 在手势里)才听得见。jsdom 没有 AudioContext,以前
    // 的替身一律「构造即 running、resume 必然成功」,这条死法整条链路都看
    // 不见 —— 所以这里显式建模 WebKit 的手势严格模式。
    FakeAudioContext.strictGestures = true
    FakeFoliateAdapter.nextOptions = { sections: [SECTION] }
    renderReader()
    await waitFor(() => {
      expect(document.querySelector('.reader-opening')).toBeNull()
    })
    const adapter = latestAdapter()

    adapter.emitSelection({
      text: '第二句话才是划线目标。',
      cfi: 'epubcfi(/6/4!/4/2)',
      start: 8,
      rect: { top: 300, left: 200, height: 20 },
    })
    const toolbar = await screen.findByTestId('selection-toolbar')
    // 真实点击在手势内:speakSelection 同步 primeTtsAudio。
    FakeAudioContext.withGesture(() => {
      fireEvent.click(within(toolbar).getByTitle('朗读此处'))
    })

    await waitFor(() => {
      expect(synthTexts()).toContain('第二句话才是划线目标。')
    })
    await drainMacrotasks()
    // 「真有声」= 源真的排上了,且起播时上下文在跑 —— 两个条件缺一不可。
    expect(FakeSource.instances.filter((source) => source.started).length).toBeGreaterThan(0)
    expect(FakeAudioContext.latest!.state).toBe('running')
    expect(FakeAudioContext.latest!.startedWhileSuspended).toBe(0)
    expectStillPlaying()
  })

  it('编辑模式(点已有划线)也能直接起播:文本取划线自己的 excerpt', async () => {
    // 阅读态恢复:reader.state.get 带回一条已存划线。
    invokeMock.mockImplementation((command, request) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state: {
            progress: null,
            annotations: [
              {
                id: 'a1',
                cfi: 'epubcfi(/6/4!/4/2)',
                color: '#86c98a',
                style: 'highlight',
                excerpt: '第二句话才是划线目标。',
                updatedAt: '2026-10-12T00:00:00Z',
              },
            ],
            bookmarks: [],
            updatedAt: '2026-10-12T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command as string, request)) as never
    })
    FakeFoliateAdapter.nextOptions = { sections: [SECTION] }
    renderReader()
    await waitFor(() => {
      expect(document.querySelector('.reader-opening')).toBeNull()
    })
    const adapter = latestAdapter()

    adapter.emitShowAnnotation('epubcfi(/6/4!/4/2)')
    const toolbar = await screen.findByTestId('selection-toolbar')
    fireEvent.click(within(toolbar).getByTitle('朗读此处'))

    await waitFor(() => {
      expect(synthTexts()).toContain('第二句话才是划线目标。')
    })
    expect(synthTexts()).not.toContain('第一句话在这里。')
    await drainMacrotasks()
    expectStillPlaying()
  })

  it('章内重复的句子:偏移定位到第二次出现,文本匹配会错定到第一次', async () => {
    // 「他说了一声。」出现两次,选区划的是第二次。文本匹配(整句覆盖)只能
    // 找到第一次;内核报来的起点偏移(第二处的开头)是 exact 的。
    const repeat = '他说了一声。然后转身走了。他说了一声。然后关上了门。'
    const second = repeat.indexOf('他说了一声。', 1)
    FakeFoliateAdapter.nextOptions = { sections: [repeat] }
    renderReader()
    await waitFor(() => {
      expect(document.querySelector('.reader-opening')).toBeNull()
    })
    const adapter = latestAdapter()

    adapter.emitSelection({
      text: '他说了一声。然后关上了门。',
      cfi: 'epubcfi(/6/4!/4/2)',
      start: second,
      rect: { top: 300, left: 200, height: 20 },
    })
    const toolbar = await screen.findByTestId('selection-toolbar')
    fireEvent.click(within(toolbar).getByTitle('朗读此处'))

    await waitFor(() => {
      expect(synthTexts()).toContain('然后关上了门。')
    })
    // 从第一次出现起播才会合成中间那句 —— 有它就跑偏了。
    expect(synthTexts()).not.toContain('然后转身走了。')
    await drainMacrotasks()
    expectStillPlaying()
  })
})

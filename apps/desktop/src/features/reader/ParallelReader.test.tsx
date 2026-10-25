/**
 * 并行阅读容器的接线测试。
 *
 * 只管三件「一栏之内做不到、错了又不容易看出来」的事:
 * 1. 两栏各自是一个完整阅读器(两个内核实例,互不共用宿主);
 * 2. 活动栏归属 —— 点哪栏激活哪栏,方向键只翻那一栏;
 * 3. 联动对位 —— 一栏报位置,另一栏跳到同一比例;关掉就不跳。
 *
 * 分栏比例的算术在 parallel.test.ts,这里不重复。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenedBook } from '../../lib/book-import'
import { invokeCommand, invokeStreamingCommand, isTauriRuntime } from '../../lib/ipc'
import { FakeFoliateAdapter, resetFakeAdapters } from '../../test/fake-foliate'
import { ParallelReader } from './ParallelReader'

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

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
vi.mock('../../lib/reading-stats', () => ({ reportReadingTime: vi.fn(async () => undefined) }))

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

vi.mock('./AiDrawer', () => ({ AiDrawer: () => <div data-testid="ai" /> }))
vi.mock('./TtsDrawer', () => ({ TtsDrawer: () => <div data-testid="tts" /> }))
vi.mock('./LearningDrawer', () => ({ LearningDrawer: () => <div data-testid="learning" /> }))

const invokeMock = vi.mocked(invokeCommand)

function respond(command: string): unknown {
  switch (command) {
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
    case 'library.list':
      return { books: [] }
    default:
      return undefined
  }
}

const LEFT: OpenedBook = {
  bookId: 'a'.repeat(64),
  format: 'epub',
  hash: 'a'.repeat(64),
  name: '原文.epub',
  url: 'asset://localhost/books/原文.epub',
}

const RIGHT: OpenedBook = {
  bookId: 'b'.repeat(64),
  format: 'epub',
  hash: 'b'.repeat(64),
  name: '译本.epub',
  url: 'asset://localhost/books/译本.epub',
}

/** 两栏的假内核:构造顺序 = 挂载顺序(左先右后)。 */
function panes(): readonly [FakeFoliateAdapter, FakeFoliateAdapter] {
  const instances = FakeFoliateAdapter.instances
  const left = instances[0]
  const right = instances[1]
  if (left === undefined || right === undefined) throw new Error('两栏内核没都挂上')
  return [left, right]
}

function relocate(fraction: number) {
  return {
    cfi: `epubcfi(/6/4!/4/${Math.round(fraction * 100) + 2})`,
    fraction,
    tocLabel: undefined,
    location: undefined,
    sectionIndex: 0,
  }
}

async function renderParallel() {
  const onBack = vi.fn()
  const onExit = vi.fn()
  render(<ParallelReader primary={LEFT} secondary={RIGHT} onBack={onBack} onExit={onExit} />)
  // 两栏都进入 reading 态(开书加载条消失)才算接线完成。
  await waitFor(() => expect(document.querySelectorAll('.reader-opening')).toHaveLength(0))
  return { onBack, onExit }
}

function cells(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.parallel-cell')]
}

beforeEach(() => {
  resetFakeAdapters()
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (command: string) => respond(command) as never)
  vi.mocked(invokeStreamingCommand).mockResolvedValue(undefined as never)
  vi.mocked(isTauriRuntime).mockReturnValue(true)
  localStorage.clear()
})

describe('ParallelReader', () => {
  it('两栏各是一个完整阅读器,各占自己的宿主', async () => {
    await renderParallel()
    const [left, right] = panes()
    expect(left.host).not.toBe(right.host)
    expect(left.host.closest('.parallel-cell')).toBe(cells()[0])
    expect(right.host.closest('.parallel-cell')).toBe(cells()[1])
  })

  it('点哪栏就激活哪栏', async () => {
    await renderParallel()
    expect(cells()[0]?.dataset['active']).toBe('true')
    fireEvent.pointerDown(cells()[1]!.querySelector('.reader') ?? cells()[1]!)
    await waitFor(() => expect(cells()[1]?.dataset['active']).toBe('true'))
    expect(cells()[0]?.dataset['active']).toBe('false')
  })

  it('方向键只翻活动栏那一本', async () => {
    await renderParallel()
    const [left, right] = panes()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(left.nextPage).toHaveBeenCalled())
    expect(right.nextPage).not.toHaveBeenCalled()

    fireEvent.pointerDown(cells()[1]!.querySelector('.reader') ?? cells()[1]!)
    await waitFor(() => expect(cells()[1]?.dataset['active']).toBe('true'))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(right.nextPage).toHaveBeenCalled())
    // 左栏还是只被翻过一次(没有跟着活动栏切换多翻)。
    expect(left.nextPage).toHaveBeenCalledTimes(1)
  })

  it('联动开着时,一栏翻到哪另一栏跟到哪(按比例,且带滑动动画)', async () => {
    await renderParallel()
    const [left, right] = panes()
    // 第一条是开书落位上报:真内核开书/恢复进度后一定会报一次,而它晚于 ready
    // 到达 —— 联动它只会把对面拽到本栏的开书位置上,所以 ReaderScreen 把
    // ready 后的首条上报只当作跳过位(fake 内核不报,这里手动补上)。
    left.emitRelocate(relocate(0))
    left.emitRelocate(relocate(0.42))
    // animate:被拽的这一栏也要滑过去,不能是瞬跳(用户报的「一边播动画一边瞬移」)
    await waitFor(() =>
      expect(right.goTo).toHaveBeenCalledWith({ progress: 0.42 }, { animate: true }),
    )
  })

  it('联动关掉后不再互相拽', async () => {
    await renderParallel()
    const [left, right] = panes()
    fireEvent.click(screen.getByTitle(/联动翻页/))
    left.emitRelocate(relocate(0.6))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(right.goTo).not.toHaveBeenCalled()
  })

  it('关闭对照只留下活动的那一栏', async () => {
    const { onExit } = await renderParallel()
    fireEvent.click(screen.getByTitle(/关闭对照/))
    expect(onExit).toHaveBeenCalledWith(LEFT)

    fireEvent.pointerDown(cells()[1]!.querySelector('.reader') ?? cells()[1]!)
    await waitFor(() => expect(cells()[1]?.dataset['active']).toBe('true'))
    fireEvent.click(screen.getByTitle(/关闭对照/))
    expect(onExit).toHaveBeenLastCalledWith(RIGHT)
  })
})

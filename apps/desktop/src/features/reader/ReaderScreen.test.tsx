/**
 * ReaderScreen 渲染兜底测试。
 *
 * 目的不是覆盖阅读内核(内核由 reader-core / reader-adapter 各自测),而是**锁住
 * ReaderScreen 自己的接线**:顶栏有哪些键、面板怎么开合、开启/错误两态怎么切、
 * 点了按钮有没有真的调内核。这样后续拆 2000 行组件时才有人接着。
 *
 * 三条边界上的取舍:
 * 1. 内核换成 `FakeFoliateAdapter`(见 src/test/fake-foliate.ts)。真 adapter 要建
 *    iframe + 读真实书文件,jsdom 里跑不动,而且不该在这个测试里跑。
 * 2. 三个抽屉(Ai /Tts / Learning)替身化。它们是独立单元、各有自己的 IPC 契约,
 *    让本测试跟着它们的 IPC 形状漂移,只会让这层兜底变得不可信。
 * 3. `loadTypography` 被改成恒返回 `{}`。它带模块级缓存,而用例会写它(切夜间主题),
 *    不清掉就会变成「谁先跑谁定基线」的顺序依赖。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@deepread/shared'
import type { OpenedBook } from '../../lib/book-import'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import {
  FakeFoliateAdapter,
  latestAdapter,
  resetFakeAdapters,
  type FakeFoliateOptions,
} from '../../test/fake-foliate'
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
const isTauriMock = vi.mocked(isTauriRuntime)

const APP_INFO: AppInfo = {
  appName: 'Deepread',
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

/** 挂载期各命令的最小合法响应;默认 undefined 会让子组件解构炸掉。 */
function respond(command: string): unknown {
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
    case 'library.list':
      return { books: [] }
    default:
      return undefined
  }
}

/** 顶栏 10 键的 title,按 DOM 顺序。动顶栏就必须同步改这里。 */
const TOP_KEYS = [
  '返回书架',
  '在此页添加书签',
  '阅读背景:点击切换夜间(当前 纸白,在排版设置中可选)',
  '全屏阅读(F11 / Ctrl+⌘+F)',
  '排版设置',
  '显示设置',
  'AI 助手',
  '朗读 / 听书',
  '学习(卡片 / 测验 / 错题本)',
  '目录与搜索',
] as const

function topKeyTitles(): readonly (string | null)[] {
  const header = document.querySelector('.reader-top')
  if (header === null) throw new Error('顶栏 .reader-top 不存在')
  return [...header.querySelectorAll('button')].map((button) => button.getAttribute('title'))
}

/** 挂载并等到进入阅读态(opening 占位消失即视为就绪)。 */
async function renderReader(options: FakeFoliateOptions = {}) {
  FakeFoliateAdapter.nextOptions = options
  const onBack = vi.fn()
  const view = render(<ReaderScreen book={BOOK} onBack={onBack} />)
  await waitFor(() => {
    expect(document.querySelector('.reader-opening')).toBeNull()
  })
  return { onBack, view, adapter: latestAdapter() }
}

beforeEach(() => {
  resetFakeAdapters()
  localStorage.clear()
  invokeMock.mockReset()
  invokeMock.mockImplementation((command) => Promise.resolve(respond(command)) as never)
  isTauriMock.mockReturnValue(true)
})

describe('开书流程', () => {
  it('把书名、格式与地址原样交给内核打开', async () => {
    const { adapter } = await renderReader()
    expect(adapter.open).toHaveBeenCalledTimes(1)
    expect(adapter.open).toHaveBeenCalledWith({
      bookId: BOOK.bookId,
      format: 'epub',
      url: BOOK.url,
      name: BOOK.name,
    })
  })

  it('打开后显示内核给的书名,而不是文件名', async () => {
    await renderReader({ metadata: { title: '真实的书名' } })
    expect(await screen.findByText('真实的书名')).toBeInTheDocument()
  })

  it('内核没给书名时退回书名本身', async () => {
    // 锁当前契约:回退用的是 book.name 原文(含扩展名),清洗扩展名是导入/
    // 书架那一层的事(displayName)。读屏要改清洗策略,这条会红——是有意为之。
    await renderReader({ metadata: { title: '' } })
    expect(await screen.findByText('夜航书.epub')).toBeInTheDocument()
  })

  it('开书后按存储的排版偏好下发主题与布局', async () => {
    const { adapter } = await renderReader()
    expect(adapter.setTheme).toHaveBeenCalledTimes(1)
    expect(adapter.setLayout).toHaveBeenCalledTimes(1)
    // 默认单栏 + 分页。
    expect(adapter.setLayout.mock.calls[0]?.[0]).toMatchObject({
      flow: 'paginated',
      pageMode: 'single',
    })
  })

  it('Tauri 运行时下会回读阅读状态以恢复进度', async () => {
    await renderReader()
    expect(invokeMock).toHaveBeenCalledWith('reader.state.get', { bookHash: BOOK.hash })
  })

  it('浏览器模式(无 IPC)不读取后端状态', async () => {
    isTauriMock.mockReturnValue(false)
    await renderReader()
    expect(invokeMock).not.toHaveBeenCalledWith('reader.state.get', expect.anything())
  })

  it('卸载时销毁内核,不留第二个实例', async () => {
    const { view, adapter } = await renderReader()
    view.unmount()
    await waitFor(() => expect(adapter.destroy).toHaveBeenCalled())
    expect(FakeFoliateAdapter.instances).toHaveLength(1)
  })
})

describe('顶栏 10 键', () => {
  it('10 个键按顺序全部在位(历史回归:不要悄悄收进下拉)', async () => {
    await renderReader()
    expect(topKeyTitles()).toEqual([...TOP_KEYS])
  })

  it('「返回书架」调 onBack', async () => {
    const { onBack } = await renderReader()
    fireEvent.click(screen.getByTitle('返回书架'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('面板开合', () => {
  it('排版设置面板可开可关', async () => {
    await renderReader()
    const key = screen.getByTitle('排版设置')
    expect(screen.queryByLabelText('排版设置')).not.toBeInTheDocument()
    fireEvent.click(key)
    expect(await screen.findByRole('region', { name: '排版设置' })).toBeInTheDocument()
    fireEvent.click(key)
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '排版设置' })).not.toBeInTheDocument(),
    )
  })

  it('显示设置面板列出三个开关', async () => {
    await renderReader()
    fireEvent.click(screen.getByTitle('显示设置'))
    const panel = await screen.findByRole('region', { name: '显示设置' })
    const switches = within(panel).getAllByRole('switch')
    expect(switches.map((node) => node.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('进度条与页码'),
        expect.stringContaining('字数'),
      ]),
    )
  })

  it('目录面板按内核给的目录渲染条目', async () => {
    await renderReader({
      toc: [
        { id: 'c1', title: '第一章 夜航', href: 'ch1.xhtml', children: [] },
        { id: 'c2', title: '第二章 灯塔', href: 'ch2.xhtml', children: [] },
      ],
    })
    fireEvent.click(screen.getByTitle('目录与搜索'))
    const panel = await screen.findByRole('navigation', { name: '目录与搜索' })
    expect(within(panel).getByText('第一章 夜航')).toBeInTheDocument()
    expect(within(panel).getByText('第二章 灯塔')).toBeInTheDocument()
  })

  it('AI / 朗读 / 学习三个抽屉各自打开', async () => {
    await renderReader()
    for (const [key, testId] of [
      ['AI 助手', 'ai'],
      ['朗读 / 听书', 'tts'],
      ['学习(卡片 / 测验 / 错题本)', 'learning'],
    ] as const) {
      fireEvent.click(screen.getByTitle(key))
      expect(await screen.findByTestId(testId)).toBeInTheDocument()
      fireEvent.click(screen.getByTitle(key))
      await waitFor(() => expect(screen.queryByTestId(testId)).not.toBeInTheDocument())
    }
  })
})

describe('错误态', () => {
  it('内核打不开书时给出可读消息与返回入口,而不是静默卡住', async () => {
    const { onBack } = await renderReader({ openError: new Error('书籍文件损坏') })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('书籍文件损坏')
    fireEvent.click(within(alert).getByRole('button', { name: '返回书架' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('错误态下顶栏仍在,用户不会被困住', async () => {
    await renderReader({ openError: new Error('书籍文件损坏') })
    await screen.findByRole('alert')
    expect(topKeyTitles()).toEqual([...TOP_KEYS])
  })
})

describe('阅读动作接到内核', () => {
  it('点下一页 / 上一页分别调内核翻页', async () => {
    const { adapter } = await renderReader()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(adapter.nextPage).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    await waitFor(() => expect(adapter.previousPage).toHaveBeenCalledTimes(1))
  })

  it('内核报位置变化后可添加书签,再点变移除', async () => {
    const { adapter } = await renderReader()
    adapter.emitRelocate({
      cfi: 'epubcfi(/6/4!/4/2)',
      fraction: 0.12,
      tocLabel: '第一章 夜航',
      location: { current: 2, total: 9 },
      sectionIndex: 0,
    })
    const add = await screen.findByTitle('在此页添加书签')
    fireEvent.click(add)
    expect(await screen.findByTitle('移除书签')).toBeInTheDocument()
  })

  it('没有阅读位置时点书签键不写入(内核尚未报位)', async () => {
    await renderReader()
    fireEvent.click(screen.getByTitle('在此页添加书签'))
    expect(screen.getByTitle('在此页添加书签')).toBeInTheDocument()
  })

  it('切夜间主题后按键标题反映当前主题', async () => {
    await renderReader()
    fireEvent.click(screen.getByTitle(/^阅读背景/))
    expect(await screen.findByTitle(/当前 夜间/)).toBeInTheDocument()
  })
})

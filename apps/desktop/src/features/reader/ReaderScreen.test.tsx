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
import { invokeCommand, invokeStreamingCommand, isTauriRuntime } from '../../lib/ipc'
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
const streamMock = vi.mocked(invokeStreamingCommand)
const isTauriMock = vi.mocked(isTauriRuntime)

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
  streamMock.mockReset()
  streamMock.mockResolvedValue(undefined as never)
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

  it('浏览器模式同样回读阅读状态 —— ipc 分流到 IndexedDB,不再刷新即丢', async () => {
    isTauriMock.mockReturnValue(false)
    await renderReader()
    expect(invokeMock).toHaveBeenCalledWith('reader.state.get', { bookHash: BOOK.hash })
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

describe('键盘事件契约', () => {
  it('翻页键与全屏键 preventDefault,Escape 不 preventDefault', async () => {
    // fireEvent 返回 dispatchEvent 的结果:false = 事件已被 preventDefault。
    // Escape 故意不拦:要留给宿主自己的默认处理(原生 <dialog> 的 Esc 关闭等)。
    await renderReader()
    expect(fireEvent.keyDown(window, { key: 'ArrowRight' })).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'PageUp' })).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'F11' })).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true)
  })

  it('未绑定的键既不拦也不动作', async () => {
    const { adapter } = await renderReader()
    expect(fireEvent.keyDown(window, { key: 'ArrowUp' })).toBe(true)
    expect(adapter.nextPage).not.toHaveBeenCalled()
    expect(adapter.previousPage).not.toHaveBeenCalled()
  })
})

describe('Escape 关面板', () => {
  it('阅读态下 Escape 关闭已开的面板', async () => {
    await renderReader()
    fireEvent.click(screen.getByTitle('目录与搜索'))
    expect(await screen.findByRole('navigation', { name: '目录与搜索' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '目录与搜索' })).toBeNull())
  })

  it('错误态下 Escape 也能关闭面板(错误态顶栏仍在,面板可开)', async () => {
    await renderReader({ openError: new Error('书籍文件损坏') })
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTitle('目录与搜索'))
    expect(await screen.findByRole('navigation', { name: '目录与搜索' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '目录与搜索' })).toBeNull())
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

const SELECTION = {
  cfi: 'epubcfi(/6/4!/4/2)',
  text: '被划的那一句。',
  rect: { top: 140, left: 80, height: 20 },
} as const

describe('批注:多色划线 / 笔记 / 列表面板', () => {
  /** 划选正文 → 工具栏出现。 */
  async function selectText(adapter: FakeFoliateAdapter): Promise<HTMLElement> {
    adapter.emitSelection({ ...SELECTION })
    const toolbar = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.selection-toolbar')
      if (node === null) throw new Error('选区工具栏没出现')
      return node
    })
    return toolbar
  }

  /** 侧栏切到批注页签。 */
  function openAnnotationsTab(): HTMLElement {
    fireEvent.click(screen.getByTitle('目录与搜索'))
    fireEvent.click(screen.getByText(/^批注/))
    return document.querySelector<HTMLElement>('.reader-toc') as HTMLElement
  }

  it('选区工具栏给五色划线,点哪个色就按哪个色交给内核', async () => {
    const { adapter } = await renderReader()
    const toolbar = await selectText(adapter)

    const swatches = [...toolbar.querySelectorAll('button[aria-label$="划线"]')]
    expect(swatches).toHaveLength(5)

    fireEvent.click(within(toolbar).getByLabelText('蓝色划线'))
    await waitFor(() => expect(adapter.createAnnotation).toHaveBeenCalledTimes(1))
    expect(adapter.createAnnotation.mock.calls[0]?.[0]).toMatchObject({
      color: '#86b6f0',
      selectedText: SELECTION.text,
      range: { start: { cfi: SELECTION.cfi } },
    })
  })

  it('写笔记保存后新建一条带 note 的划线', async () => {
    const { adapter } = await renderReader()
    const toolbar = await selectText(adapter)

    fireEvent.click(within(toolbar).getByTitle('写笔记'))
    const textarea = await screen.findByLabelText('笔记内容')
    fireEvent.change(textarea, { target: { value: '这句要抄下来' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(adapter.createAnnotation).toHaveBeenCalledTimes(1))
    expect(adapter.createAnnotation.mock.calls[0]?.[0]).toMatchObject({ note: '这句要抄下来' })
  })

  it('笔记留空保存 = 只要划线,不带 note', async () => {
    const { adapter } = await renderReader()
    const toolbar = await selectText(adapter)
    fireEvent.click(within(toolbar).getByTitle('写笔记'))
    await screen.findByLabelText('笔记内容')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(adapter.createAnnotation).toHaveBeenCalledTimes(1))
    // 领域模型的 note 是该字段的"没有"态(undefined),存下来就是纯划线。
    expect(adapter.createAnnotation.mock.calls[0]?.[0]?.note).toBeUndefined()
  })

  it('批注页签列出摘录与笔记,点条目按 CFI 回到原文', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state: {
            progress: null,
            annotations: [
              {
                id: 'a1',
                cfi: 'epubcfi(/6/4!/4/2)',
                color: '#86c98a',
                excerpt: '第一章被划的那句',
                note: '第一章的想法',
                updatedAt: '2026-10-12T00:00:00Z',
              },
            ],
            bookmarks: [],
            updatedAt: '2026-10-12T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })
    const { adapter } = await renderReader()

    const panel = openAnnotationsTab()
    expect(within(panel as HTMLElement).getByText('第一章被划的那句')).toBeInTheDocument()
    expect(within(panel as HTMLElement).getByText('第一章的想法')).toBeInTheDocument()

    fireEvent.click(within(panel as HTMLElement).getByTitle('跳到原文'))
    await waitFor(() =>
      expect(adapter.goTo).toHaveBeenCalledWith({ cfi: 'epubcfi(/6/4!/4/2)', progress: 0 }),
    )
  })

  it('列表里改笔记:新文案进 state.set,清空的 note 真的删掉', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state: {
            progress: null,
            annotations: [
              {
                id: 'a1',
                cfi: 'epubcfi(/6/4!/4/2)',
                color: '#f5d76e',
                excerpt: '摘录',
                note: '旧笔记',
                updatedAt: '2026-10-12T00:00:00Z',
              },
            ],
            bookmarks: [],
            updatedAt: '2026-10-12T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })
    await renderReader()
    const panel = openAnnotationsTab()

    fireEvent.click(within(panel).getByTitle('写笔记'))
    fireEvent.change(await screen.findByLabelText('笔记内容'), {
      target: { value: '新笔记' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(panel).getByText('新笔记')).toBeInTheDocument())

    // 清空再保存 → 只剩划线。
    fireEvent.click(within(panel).getByTitle('写笔记'))
    fireEvent.change(await screen.findByLabelText('笔记内容'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByLabelText('笔记内容')).not.toBeInTheDocument())
    expect(within(panel).queryByText('旧笔记')).not.toBeInTheDocument()
  })

  it('「本章」只留当前那一节的批注,读不出章节时按全书给', async () => {
    const annotation = (id: string, cfi: string, excerpt: string) => ({
      id,
      cfi,
      color: '#f5d76e',
      excerpt,
      updatedAt: '2026-10-12T00:00:00Z',
    })
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state: {
            progress: null,
            annotations: [
              annotation('a1', 'epubcfi(/6/4!/4/2)', '第一章的划线'),
              annotation('a2', 'epubcfi(/6/6!/4/8)', '第二章的划线'),
            ],
            bookmarks: [],
            updatedAt: '2026-10-12T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })
    const { adapter } = await renderReader()

    adapter.emitRelocate({
      cfi: 'epubcfi(/6/4!/4/2)',
      fraction: 0.1,
      tocLabel: undefined,
      location: undefined,
      sectionIndex: 0,
    })
    const panel = openAnnotationsTab()
    await waitFor(() => expect(within(panel).getByText('第一章的划线')).toBeInTheDocument())

    fireEvent.click(within(panel).getByText('本章'))
    await waitFor(() => expect(within(panel).queryByText('第二章的划线')).not.toBeInTheDocument())
    expect(within(panel).getByText('第一章的划线')).toBeInTheDocument()

    fireEvent.click(within(panel).getByText('全书'))
    expect(within(panel).getByText('第二章的划线')).toBeInTheDocument()
  })

  it('列表删除划线:调内核 removeAnnotation 并留下墓碑', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state: {
            progress: null,
            annotations: [
              {
                id: 'a1',
                cfi: 'epubcfi(/6/4!/4/2)',
                color: '#f5d76e',
                excerpt: '摘录',
                updatedAt: '2026-10-12T00:00:00Z',
              },
            ],
            bookmarks: [],
            updatedAt: '2026-10-12T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })
    const { adapter } = await renderReader()
    const panel = openAnnotationsTab()

    fireEvent.click(within(panel).getByTitle('删除划线'))
    await waitFor(() => expect(adapter.removeAnnotation).toHaveBeenCalledWith('a1'))
    await waitFor(() =>
      expect(within(panel).getByText('还没有批注 —— 在正文里划选即可。')).toBeInTheDocument(),
    )
  })
})

describe('ReaderScreen 从笔记页跳回原文', () => {
  it('带 CFI 打开时落在那条批注上,而不是上次读到的位置', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        // 这本书上次读到 90% 的位置 —— 正是不能被沿用的那一个。
        return Promise.resolve({
          state: {
            progress: { cfi: 'epubcfi(/6/99!)', fraction: 0.9 },
            annotations: [],
            bookmarks: [],
            updatedAt: '2026-09-28T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })

    FakeFoliateAdapter.nextOptions = {}
    render(<ReaderScreen book={{ ...BOOK, cfi: 'epubcfi(/6/4!2/2)' }} onBack={vi.fn()} />)
    await waitFor(() => {
      expect(document.querySelector('.reader-opening')).toBeNull()
    })

    const positions = latestAdapter().goTo.mock.calls.map((call) => call[0])
    expect(positions).toContainEqual({ cfi: 'epubcfi(/6/4!2/2)', progress: 0 })
    expect(positions.some((target) => target.progress === 0.9)).toBe(false)
  })

  it('不带 CFI 时照旧恢复到上次读到的位置', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state: {
            progress: { cfi: 'epubcfi(/6/99!)', fraction: 0.9 },
            annotations: [],
            bookmarks: [],
            updatedAt: '2026-09-28T00:00:00Z',
          },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })

    await renderReader()
    expect(latestAdapter().goTo.mock.calls.map((call) => call[0])).toContainEqual({
      cfi: 'epubcfi(/6/99!)',
      progress: 0.9,
    })
  })
})

describe('跨书搜索正文命中定位(sectionLabel)', () => {
  const TOC = [
    { id: 'c1', title: '第一章 夜航', href: 'ch1.xhtml', children: [] },
    { id: 'c2', title: '第二章 灯塔', href: 'ch2.xhtml', children: [] },
  ]

  /** 带 sectionLabel 打开;progress = 上次读到的位置(不能被沿用的那一个)。 */
  function renderWithSectionLabel(
    sectionLabel: string,
    progress?: { cfi: string; fraction: number },
  ): Promise<void> {
    invokeMock.mockImplementation((command) => {
      if (command === 'reader.state.get') {
        return Promise.resolve({
          state:
            progress === undefined
              ? null
              : { progress, annotations: [], bookmarks: [], updatedAt: '2026-09-28T00:00:00Z' },
        }) as never
      }
      return Promise.resolve(respond(command)) as never
    })
    FakeFoliateAdapter.nextOptions = { toc: TOC }
    render(<ReaderScreen book={{ ...BOOK, sectionLabel }} onBack={vi.fn()} />)
    return waitFor(() => {
      expect(document.querySelector('.reader-opening')).toBeNull()
    })
  }

  it('label 命中目录时按 href 跳过去,上次进度不盖掉它', async () => {
    await renderWithSectionLabel('第二章 灯塔', { cfi: 'epubcfi(/6/99!)', fraction: 0.9 })
    const positions = latestAdapter().goTo.mock.calls.map((call) => call[0])
    expect(positions).toContainEqual({ href: 'ch2.xhtml', progress: 0 })
    expect(positions.some((target) => target.progress === 0.9)).toBe(false)
  })

  it('label 不在目录里时说清楚没找到,仍按常规位置打开', async () => {
    await renderWithSectionLabel('第九章 归途', { cfi: 'epubcfi(/6/99!)', fraction: 0.9 })
    expect(await screen.findByText(/没找到「第九章 归途」这一章/)).toBeInTheDocument()
    // 常规位置 = 上次读到的 90%:那一章找不到,但不能把人悄悄丢在开头。
    const positions = latestAdapter().goTo.mock.calls.map((call) => call[0])
    expect(positions).toContainEqual({ cfi: 'epubcfi(/6/99!)', progress: 0.9 })
    expect(positions.some((target) => 'href' in target)).toBe(false)
  })
})

describe('划选翻译', () => {
  const PROVIDER = {
    id: 'cfg-1',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  }

  /** 让流式命令在被调用的那一刻把模型输出推回去(真流是异步的,这里同步喂)。 */
  function withStreamOutput(text: string): void {
    streamMock.mockImplementation(((
      _command: string,
      _request: unknown,
      onEvent: (event: { type: string; data: string }) => void,
    ) => {
      const push = (piece: string): void => {
        onEvent({
          type: 'chunk',
          data: `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
        })
      }
      for (const piece of text.match(/.{1,8}/gs) ?? []) push(piece)
      return Promise.resolve(undefined)
    }) as never)
  }

  async function selectText(adapter: FakeFoliateAdapter): Promise<HTMLElement> {
    adapter.emitSelection({ ...SELECTION })
    return await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.selection-toolbar')
      if (node === null) throw new Error('选区工具栏没出现')
      return node
    })
  }

  it('翻译按钮走 ai.chat 流式,译文边收边渲染,并写明用的哪个服务', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'ai.config.list') return Promise.resolve({ providers: [PROVIDER] }) as never
      return Promise.resolve(respond(command)) as never
    })
    withStreamOutput('LANG:zh-CN\n---\nThe wick crackled.')
    const { adapter } = await renderReader()
    const toolbar = await selectText(adapter)

    fireEvent.click(within(toolbar).getByTitle('翻译'))
    await waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1))
    const request = streamMock.mock.calls[0]?.[1] as { configId: string; messages: unknown }
    expect(request.configId).toBe('cfg-1')
    expect(JSON.stringify(request.messages)).toContain('被划的那一句。')

    const card = await screen.findByLabelText('翻译')
    expect(within(card).getByText('The wick crackled.')).toBeInTheDocument()
    // 成本诚实:谁出的译文、用的哪个模型,直接写在卡片上。
    expect(within(card).getByText('DeepSeek · deepseek-chat')).toBeInTheDocument()
    expect(within(card).getByText('源语言 zh-CN')).toBeInTheDocument()
  })

  it('没配 AI 服务时说明原因,而不是给出假的译文', async () => {
    const { adapter } = await renderReader()
    const toolbar = await selectText(adapter)
    fireEvent.click(within(toolbar).getByTitle('翻译'))
    await waitFor(() => expect(screen.queryByLabelText('翻译')).not.toBeInTheDocument())
    expect(streamMock).not.toHaveBeenCalled()
    expect(await screen.findByText(/还没有配置 AI 服务/)).toBeInTheDocument()
  })
})

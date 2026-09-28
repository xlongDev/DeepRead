/**
 * W0 渲染兜底层:拆 LibraryScreen 之前先把「外部可观察行为」钉死。
 *
 * 锁的是契约,不是内部实现:哪些控件存在、按什么顺序、叫什么名字、点了会
 * 落到哪个 IPC。这样 W1 把屏幕拆成 shelf / notes / stats 三块时,任何一处
 * 漏搬、改名、错位都会立刻变红。
 *
 * 覆盖的回归高发区(git log 里出现过的那几类):工具栏按钮搬进下拉、移除
 * 的两次点击确认、封面解析失败后的回退渲染、弹窗 Esc 关闭。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localDayKey, type AppInfo, type LibraryBook } from '@deepread/shared'
import { LibraryScreen } from './LibraryScreen'
import { invokeCommand } from '../../lib/ipc'
import { open } from '@tauri-apps/plugin-dialog'

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriRuntime: vi.fn((): boolean => true),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async (): Promise<null> => null),
  save: vi.fn(async (): Promise<null> => null),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async (): Promise<null> => null),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async (): Promise<void> => undefined),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (): Promise<() => void> => () => undefined),
  }),
}))

// 内核解析是重依赖:这里只关心书架怎么渲染解析结果,所以把两个提取函数换成
// 返回 null(封面走回退色块、标题走 displayName),纯函数保持真实。
vi.mock('@deepread/reader-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepread/reader-adapter')>()
  return {
    ...actual,
    extractCover: vi.fn(async (): Promise<null> => null),
    extractTitle: vi.fn(async (): Promise<null> => null),
  }
})

vi.mock('../../lib/cover-store', () => ({
  readCachedCover: vi.fn(async (): Promise<null> => null),
  writeCachedCover: vi.fn(async (): Promise<void> => undefined),
}))

// 兄弟抽屉有各自的 IPC 契约,与本文件的主题无关:stub 掉,免得它们的改动
// 把这张网扯红(网一脆就会被删掉)。
vi.mock('./SyncDrawer', () => ({
  SyncDrawer: () => <div data-testid="sync-drawer" />,
}))

vi.mock('../settings/AiProviderSettings', () => ({
  useAiProviders: () => ({
    providers: [],
    loaded: true,
    activeId: null,
    configForm: { name: '', baseUrl: '', model: '', apiKey: '' },
    setConfigForm: vi.fn(),
    saveProvider: vi.fn(async (): Promise<void> => undefined),
    removeProvider: vi.fn(async (): Promise<void> => undefined),
    error: null,
  }),
  AiProviderForm: () => <div data-testid="ai-provider-form" />,
}))

const invokeCommandMock = vi.mocked(invokeCommand)
const openMock = vi.mocked(open)

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

const BOOKS: readonly LibraryBook[] = [
  {
    hash: HASH_A,
    fileName: '夜航书.epub',
    displayName: '夜航书',
    format: 'epub',
    path: '/books/夜航书.epub',
    size: 2391,
    addedAt: '2026-09-09T00:00:00Z',
    progress: 0.42,
    tags: [],
  },
  {
    hash: HASH_B,
    fileName: '化雪的季节.txt',
    displayName: '化雪的季节',
    format: 'txt',
    path: '/books/化雪的季节.txt',
    size: 382,
    addedAt: '2026-09-08T00:00:00Z',
    progress: null,
    tags: ['文学'],
  },
  {
    hash: HASH_C,
    fileName: '山中手记.fb2',
    displayName: '山中手记',
    format: 'fb2',
    path: '/books/山中手记.fb2',
    size: 619,
    addedAt: '2026-09-07T00:00:00Z',
    progress: 1,
    tags: ['文学', '随笔'],
  },
]

const APP_INFO: AppInfo = {
  appName: 'Deepread',
  appVersion: '0.2.0',
  os: 'macos',
  arch: 'aarch64',
}

const STATS = {
  days: [{ day: localDayKey(), seconds: 600 }],
  totalSeconds: 3000,
}

function mockBackend(books: readonly LibraryBook[]): void {
  invokeCommandMock.mockImplementation((command) => {
    if (command === 'library.list') return Promise.resolve({ books: [...books] })
    if (command === 'reader.stats.get') return Promise.resolve(STATS)
    if (command === 'library.remove') return Promise.resolve({ ok: true })
    return Promise.resolve(APP_INFO)
  })
}

/** 等到书架工具栏出现(ready 态的唯一信号),不靠「等错误消失」。 */
async function renderLibrary(books: readonly LibraryBook[] = BOOKS) {
  mockBackend(books)
  const onOpenBook = vi.fn()
  const view = render(<LibraryScreen onOpenBook={onOpenBook} backend={APP_INFO} />)
  if (books.length > 0) {
    await waitFor(() => expect(document.querySelector('.shelf-toolbar')).not.toBeNull())
  } else {
    await waitFor(() => expect(document.querySelector('.shelf-skeleton')).toBeNull())
  }
  return { onOpenBook, view }
}

/** 工具栏里所有按钮的可读标识,按 DOM 顺序 —— 顺序变了就是契约变了。 */
function toolbarButtons(): readonly string[] {
  const toolbar = document.querySelector('.shelf-toolbar')
  if (!toolbar) throw new Error('工具栏缺失')
  return [...toolbar.querySelectorAll('button')].map(
    (button) =>
      button.getAttribute('aria-label') ??
      button.getAttribute('title') ??
      button.textContent?.trim() ??
      '',
  )
}

beforeEach(() => {
  invokeCommandMock.mockReset()
  openMock.mockReset()
  openMock.mockResolvedValue(null)
  localStorage.clear()
})

describe('LibraryScreen 外壳契约', () => {
  it('顶栏只留设置与云同步两个入口,顺序固定', async () => {
    await renderLibrary()
    const header = document.querySelector('.library-header')
    expect(header).not.toBeNull()
    expect(
      [...header!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ).toEqual(['打开设置', '打开云同步'])
    expect(header!.textContent).toContain('Deepread')
    expect(header!.textContent).toContain('个人阅读操作系统')
  })

  it('书架工具栏的控件按序排列,一个不多一个不少', async () => {
    await renderLibrary()
    expect(toolbarButtons()).toEqual([
      '网格视图',
      '列表视图',
      '排序方式',
      '按标签筛选',
      '阅读统计',
      '批量管理',
      '导入书籍',
    ])
    expect(document.querySelector('.shelf-title')?.textContent).toContain('书架')
    expect(screen.getByLabelText('搜索书名')).toBeInTheDocument()
  })

  it('没有标签时不渲染标签下拉(避免空下拉)', async () => {
    await renderLibrary([{ ...BOOKS[0]!, tags: [] }])
    expect(toolbarButtons()).toEqual([
      '网格视图',
      '列表视图',
      '排序方式',
      '阅读统计',
      '批量管理',
      '导入书籍',
    ])
  })

  it('空书架显示导入引导而不是空网格', async () => {
    await renderLibrary([])
    expect(screen.getByRole('button', { name: '导入书籍' })).toBeInTheDocument()
    expect(document.querySelector('.shelf-toolbar')).toBeNull()
    expect(screen.getByText(/把书拖进窗口/)).toBeInTheDocument()
  })

  it('底部状态栏如实报告本数与后端信息', async () => {
    await renderLibrary()
    const footer = document.querySelector('.library-footer')
    expect(footer?.textContent).toContain('3 本')
    // 一本 42%、一本读完、一本没开过 —— 「在读」只数真正翻开过的。
    expect(footer?.textContent).toContain('在读 2')
    expect(footer?.textContent).toContain('Deepread 0.2.0 · macos/aarch64')
  })
})

describe('LibraryScreen 书架渲染', () => {
  it('网格里的每本书都带标题、进度文案与移除按钮', async () => {
    await renderLibrary()
    expect(document.querySelector('.shelf-grid')).not.toBeNull()
    expect(screen.getByLabelText('从书架移除 夜航书')).toBeInTheDocument()
    expect(screen.getByLabelText('从书架移除 化雪的季节')).toBeInTheDocument()
    expect(screen.getByLabelText('从书架移除 山中手记')).toBeInTheDocument()
    expect(screen.getByText('读到 42% · 2 KB')).toBeInTheDocument()
    // 封面解析失败时的回退:首字 + 书名,不是空白卡片。
    expect(document.querySelectorAll('.book-cover-char').length).toBe(3)
  })

  it('封面按钮把选中书交给阅读器,并说明自己会打开哪一本', async () => {
    const { onOpenBook } = await renderLibrary()
    fireEvent.click(screen.getByTitle('打开《夜航书》'))
    expect(onOpenBook).toHaveBeenCalledTimes(1)
    expect(onOpenBook.mock.calls[0]?.[0]).toMatchObject({ bookId: HASH_A, format: 'epub' })
  })

  it('切到列表视图换的是容器,书还在', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('列表视图'))
    expect(document.querySelector('.shelf-list')).not.toBeNull()
    expect(document.querySelector('.shelf-grid')).toBeNull()
    expect(screen.getAllByText('夜航书').length).toBeGreaterThan(0)
  })

  it('搜索过滤到零本时说清是没匹配,而不是空白', async () => {
    await renderLibrary()
    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '不存在的书' } })
    expect(await screen.findByText(/没有匹配/, { exact: false })).toBeInTheDocument()
  })

  it('移除是两次点击:第一次只是待确认,第二次才落 IPC', async () => {
    await renderLibrary()
    const first = screen.getByLabelText('从书架移除 夜航书')
    fireEvent.click(first)
    expect(screen.getByLabelText('确认移除 夜航书')).toBeInTheDocument()
    expect(invokeCommandMock).not.toHaveBeenCalledWith('library.remove', expect.anything())

    fireEvent.click(screen.getByLabelText('确认移除 夜航书'))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.remove', { bookHash: HASH_A }),
    )
  })
})

describe('LibraryScreen 排序与筛选', () => {
  it('排序下拉默认最近添加,可切到阅读进度', async () => {
    await renderLibrary()
    const trigger = screen.getByLabelText('排序方式')
    expect(within(trigger).getByText('最近添加')).toBeInTheDocument()

    fireEvent.click(trigger)
    fireEvent.click(within(screen.getByRole('menu', { name: '排序方式' })).getByText('阅读进度'))
    expect(within(screen.getByLabelText('排序方式')).getByText('阅读进度')).toBeInTheDocument()
    expect(localStorage.getItem('deepread.shelf.sort')).toBe('progress')
  })

  it('按标签筛选只留下带该标签的书', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('按标签筛选'))
    fireEvent.click(within(screen.getByRole('menu', { name: '按标签筛选' })).getByText('随笔'))
    await waitFor(() => expect(screen.queryByText('夜航书')).toBeNull())
    expect(screen.getAllByText('山中手记').length).toBeGreaterThan(0)
  })
})

describe('LibraryScreen 批量管理', () => {
  it('进入管理态出现批量条,退出后消失', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('批量管理'))
    const bar = screen.getByRole('toolbar', { name: '批量操作' })
    expect(bar.textContent).toContain('已选 0 本')

    fireEvent.click(within(bar).getByText('全选'))
    expect(bar.textContent).toContain('已选 3 本')

    fireEvent.click(screen.getByTitle('退出批量管理'))
    expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull()
  })

  it('整批移出需要二次确认,确认文案带数量', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('批量管理'))
    const bar = screen.getByRole('toolbar', { name: '批量操作' })
    fireEvent.click(within(bar).getByText('全选'))

    fireEvent.click(within(bar).getByText('移出书架'))
    expect(screen.getByText('确认移除 3 本?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('确认移除 3 本?'))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.remove', { bookHash: HASH_A }),
    )
  })
})

describe('LibraryScreen 侧栏导航', () => {
  it('侧栏列出三个目的地,默认停在书架', async () => {
    await renderLibrary()
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    expect(
      [...sidebar.querySelectorAll('.lib-sidebar-nav button')].map((button) =>
        button.textContent?.replace(/\d+$/, '').trim(),
      ),
    ).toEqual(['书架', '笔记', '统计'])
    expect(within(sidebar).getByRole('button', { name: /书架/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('切到笔记与统计会换掉主区内容,再切回书架恢复', async () => {
    await renderLibrary()
    const sidebar = screen.getByRole('complementary', { name: '主导航' })

    fireEvent.click(within(sidebar).getByRole('button', { name: '笔记' }))
    expect(screen.getByLabelText('笔记')).toBeInTheDocument()
    expect(document.querySelector('.shelf-toolbar')).toBeNull()

    fireEvent.click(within(sidebar).getByRole('button', { name: '统计' }))
    expect(await screen.findByLabelText('阅读统计')).toBeInTheDocument()
    expect(document.querySelectorAll('.stats-bar').length).toBe(7)

    fireEvent.click(within(sidebar).getByRole('button', { name: /书架/ }))
    expect(document.querySelector('.shelf-toolbar')).not.toBeNull()
  })

  it('侧栏标签与工具栏标签筛选是同一条状态', async () => {
    await renderLibrary()
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    const tagButton = within(sidebar).getByRole('button', { name: '随笔' })

    fireEvent.click(tagButton)
    expect(tagButton).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(screen.queryByText('夜航书')).toBeNull())

    // 再点一次是取消筛选,不是叠加第二个筛选条件。
    fireEvent.click(tagButton)
    expect(tagButton).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByText('夜航书').length).toBeGreaterThan(0)
  })
})

describe('LibraryScreen 统计页', () => {
  it('统计页有三块数字与最近 7 天', async () => {
    await renderLibrary()
    fireEvent.click(
      within(document.querySelector('.shelf-toolbar') as HTMLElement).getByText('统计'),
    )
    const page = await screen.findByLabelText('阅读统计')
    expect(invokeCommandMock).toHaveBeenCalledWith('reader.stats.get', undefined)

    await waitFor(() => expect(within(page).getByText('今日')).toBeInTheDocument())
    expect(within(page).getByText('10 分')).toBeInTheDocument()
    expect(within(page).getByText('连续天数')).toBeInTheDocument()
    expect(within(page).getByText('累计')).toBeInTheDocument()
    expect(within(page).getByText('50 分')).toBeInTheDocument()
    expect(document.querySelectorAll('.stats-bar').length).toBe(7)
  })
})

describe('LibraryScreen 弹窗', () => {
  it('设置弹窗三个分区都在,外观区列出全部主题', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('打开设置'))
    const dialog = await screen.findByLabelText('设置')
    expect(within(dialog).getByText('外观')).toBeInTheDocument()
    expect(within(dialog).getByText('AI 服务')).toBeInTheDocument()
    expect(within(dialog).getByText('备份与更新')).toBeInTheDocument()
    expect(document.querySelectorAll('.theme-swatch').length).toBe(7)
  })

  it('备份与更新分区提供备份、恢复、检查更新三个动作', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('打开设置'))
    fireEvent.click(screen.getByText('备份与更新'))
    expect(screen.getByText('备份到…')).toBeInTheDocument()
    expect(screen.getByText('从备份恢复…')).toBeInTheDocument()
    expect(screen.getByText('检查更新')).toBeInTheDocument()
  })

  it('Esc 关掉打开的弹窗', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('打开设置'))
    expect(await screen.findByLabelText('设置')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('设置')).toBeNull())
  })

  it('云同步走抽屉而不是弹窗', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('打开云同步'))
    expect(screen.getByTestId('sync-drawer')).toBeInTheDocument()
  })
})

describe('LibraryScreen 导入', () => {
  it('不认识的格式给一句人话,而不是静默失败', async () => {
    await renderLibrary()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'unknown.xyz')
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时不认识这个文件格式')
  })

  it('桌面端的导入按钮走系统文件选择器,不走浏览器 input', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('导入书籍'))
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1))
  })
})

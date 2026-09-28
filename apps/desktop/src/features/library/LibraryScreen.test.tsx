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
import { localDayKey, type AppInfo, type LibraryBook, type NoteEntry } from '@deepread/shared'
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

/** 跨书批注:两本在架上的书 + 一条没有时间戳的老记录。 */
const NOTES: readonly NoteEntry[] = [
  {
    id: 'n1',
    bookHash: HASH_A,
    displayName: '夜航书',
    fileName: '夜航书.epub',
    cfi: 'epubcfi(/6/4!2/2)',
    color: '#f5d76e',
    note: '我自己写的',
    excerpt: '原文一',
    updatedAt: '2026-09-27T12:00:00Z',
  },
  {
    id: 'n2',
    bookHash: HASH_A,
    displayName: '夜航书',
    fileName: '夜航书.epub',
    cfi: 'epubcfi(/6/8!2/2)',
    color: '#a5d6f5',
    note: null,
    excerpt: '原文二',
    updatedAt: null,
  },
  {
    id: 'n3',
    bookHash: HASH_B,
    displayName: '化雪的季节',
    fileName: '化雪的季节.txt',
    cfi: 'epubcfi(/6/2!4)',
    color: '#f5d76e',
    note: null,
    excerpt: '第三本的摘录',
    updatedAt: '2026-09-26T09:00:00Z',
  },
]

function mockBackend(books: readonly LibraryBook[], notes: readonly NoteEntry[] = NOTES): void {
  invokeCommandMock.mockImplementation((command, request) => {
    if (command === 'library.list') return Promise.resolve({ books: [...books] })
    if (command === 'reader.stats.get') return Promise.resolve(STATS)
    if (command === 'reader.notes.list') return Promise.resolve({ notes: [...notes] })
    if (command === 'library.remove') return Promise.resolve({ ok: true })
    if (command === 'library.tag.set') {
      const { bookHash, tags } = request as { bookHash: string; tags: readonly string[] }
      const book = books.find((item) => item.hash === bookHash) ?? books[0]!
      return Promise.resolve({ book: { ...book, tags: [...tags] } })
    }
    if (command === 'library.rename') {
      const { bookHash, displayName } = request as { bookHash: string; displayName: string }
      const book = books.find((item) => item.hash === bookHash) ?? books[0]!
      return Promise.resolve({ book: { ...book, displayName } })
    }
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
      '切换排序方向(当前降序)',
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
      '切换排序方向(当前降序)',
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

    // 柱子按顺序错开生长(W5 的状态性动效):错开值写在 DOM 上,所以能被锁住。
    const fills = [...document.querySelectorAll<HTMLElement>('.stats-bar-fill')]
    expect(fills.map((fill) => fill.style.animationDelay)).toEqual([
      '0ms',
      '40ms',
      '80ms',
      '120ms',
      '160ms',
      '200ms',
      '240ms',
    ])
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

describe('LibraryScreen 卡片操作', () => {
  it('每张卡片都给继续阅读、收藏与更多三个入口', async () => {
    await renderLibrary()
    expect(screen.getAllByText(/继续阅读|开始阅读/).length).toBe(3)
    expect(screen.getByLabelText('收藏 夜航书')).toBeInTheDocument()
    expect(screen.getByLabelText('更多操作 夜航书')).toBeInTheDocument()
  })

  it('更多菜单能由按钮、右键与键盘三种方式唤起', async () => {
    await renderLibrary()
    const menuName = '夜航书 的操作'

    fireEvent.click(screen.getByLabelText('更多操作 夜航书'))
    expect(screen.getByRole('menu', { name: menuName })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // 右键:触屏没有 Shift+F10,鼠标用户也不该被逼着去点小按钮。
    fireEvent.contextMenu(screen.getByTitle('打开《夜航书》'))
    expect(screen.getByRole('menu', { name: menuName })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // 键盘:Shift+F10 是桌面平台约定俗成的右键替代。处理器挂在封面按钮上 ——
    // 它是卡片里真正的交互元素,不是那个非交互的 <li>。
    fireEvent.keyDown(screen.getByTitle('打开《夜航书》'), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu', { name: menuName })).toBeInTheDocument()
  })

  it('菜单只提供真的能工作的两项', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('更多操作 夜航书'))
    const menu = screen.getByRole('menu', { name: '夜航书 的操作' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim()),
    ).toEqual(['编辑书籍信息', '从书架移除'])
  })

  it('收藏写进标签系统,不新增字段也不新增命令', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('收藏 夜航书'))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['收藏'],
      }),
    )
    // 收藏之后按钮变成「取消收藏」,状态是回写的而不是本地假设。
    expect(await screen.findByLabelText('取消收藏 夜航书')).toHaveAttribute('aria-pressed', 'true')
  })

  it('菜单里的移除也要两次点击,确认项直接写明后果', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('更多操作 夜航书'))
    fireEvent.click(screen.getByRole('menuitem', { name: '从书架移除' }))
    expect(invokeCommandMock).not.toHaveBeenCalledWith('library.remove', expect.anything())

    const confirmItem = screen.getByRole('menuitem', {
      name: '确认移除(进度与批注一并删除)',
    })
    fireEvent.click(confirmItem)
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.remove', { bookHash: HASH_A }),
    )
  })

  it('列表视图同样有收藏与更多(不是只有网格能用)', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('列表视图'))
    expect(screen.getByLabelText('更多操作 夜航书')).toBeInTheDocument()
    expect(screen.getByLabelText('收藏 夜航书')).toBeInTheDocument()
  })
})

describe('LibraryScreen 编辑书籍信息', () => {
  async function openInfo(): Promise<HTMLElement> {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('更多操作 夜航书'))
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑书籍信息' }))
    return screen.findByLabelText('书籍信息')
  }

  it('标题走 library.rename,标签走 library.tag.set', async () => {
    const dialog = await openInfo()
    fireEvent.change(within(dialog).getByLabelText('书名'), {
      target: { value: '夜航书(修订版)' },
    })
    fireEvent.change(within(dialog).getByLabelText('标签'), { target: { value: '文学, 收藏' } })
    fireEvent.click(within(dialog).getByText('保存'))

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.rename', {
        bookHash: HASH_A,
        displayName: '夜航书(修订版)',
      }),
    )
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['文学', '收藏'],
      }),
    )
    await waitFor(() => expect(screen.queryByLabelText('书籍信息')).toBeNull())
  })

  it('没有改动时保存是禁用的,避免无谓写库', async () => {
    const dialog = await openInfo()
    expect(within(dialog).getByText('保存')).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('标签'), { target: { value: '文学' } })
    expect(within(dialog).getByText('保存')).toBeEnabled()
  })

  it('标签输入按分隔符拆开并去重', async () => {
    const dialog = await openInfo()
    fireEvent.change(within(dialog).getByLabelText('标签'), {
      target: { value: '文学，收藏, 文学 / 在读' },
    })
    expect(
      within(dialog)
        .getAllByText(/^(文学|收藏|在读)$/)
        .map((chip) => chip.textContent),
    ).toEqual(['文学', '收藏', '在读'])
  })

  it('Esc 关闭弹窗', async () => {
    await openInfo()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('书籍信息')).toBeNull())
  })
})

describe('LibraryScreen 排序方向', () => {
  /** 网格里书籍标题的当前顺序。 */
  const order = (): readonly (string | null | undefined)[] =>
    [...document.querySelectorAll('.book-meta-title')].map((node) => node.textContent)

  it('默认按最近添加降序,点方向按钮翻成升序并记住', async () => {
    await renderLibrary()
    expect(order()).toEqual(['夜航书', '化雪的季节', '山中手记'])

    fireEvent.click(screen.getByLabelText('切换排序方向(当前降序)'))
    expect(order()).toEqual(['山中手记', '化雪的季节', '夜航书'])
    expect(localStorage.getItem('deepread.shelf.sortDir')).toBe('asc')
    expect(screen.getByLabelText('切换排序方向(当前升序)')).toBeInTheDocument()
  })

  it('换成书名时方向回到该键的自然方向,而不是沿用上一次', async () => {
    await renderLibrary()
    // 先手动翻成升序,再换成书名:若沿用 asc 就会是巧合,所以这里先确保
    // 上一个键的方向与书名的自然方向不同。
    fireEvent.click(screen.getByLabelText('切换排序方向(当前降序)'))
    expect(localStorage.getItem('deepread.shelf.sortDir')).toBe('asc')

    fireEvent.click(screen.getByLabelText('排序方式'))
    fireEvent.click(within(screen.getByRole('menu', { name: '排序方式' })).getByText('书名'))

    // 中文按拼音:化雪的季节(h)< 山中手记(s)< 夜航书(y)
    expect(order()).toEqual(['化雪的季节', '山中手记', '夜航书'])
    expect(screen.getByLabelText('切换排序方向(当前升序)')).toBeInTheDocument()
  })

  it('按进度排序时,未开始的书在两个方向下都沉底', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('排序方式'))
    fireEvent.click(within(screen.getByRole('menu', { name: '排序方式' })).getByText('阅读进度'))

    // 降序:读完(100%)在前,读到 42% 次之,未开始沉底
    expect(order()).toEqual(['山中手记', '夜航书', '化雪的季节'])

    fireEvent.click(screen.getByLabelText('切换排序方向(当前降序)'))
    // 升序:42% 在前、100% 在后,但未开始的仍然沉底
    expect(order()).toEqual(['夜航书', '山中手记', '化雪的季节'])
  })
})

describe('LibraryScreen 笔记页', () => {
  it('按书分组显示跨书批注,并带上总数', async () => {
    await renderLibrary()
    fireEvent.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('button', {
        name: '笔记',
      }),
    )

    expect(invokeCommandMock).toHaveBeenCalledWith('reader.notes.list', undefined)
    await waitFor(() => expect(document.querySelectorAll('.note-group').length).toBe(2))
    expect(screen.getByLabelText('夜航书').textContent).toContain('2 条')
    expect(screen.getByLabelText('化雪的季节').textContent).toContain('1 条')
    expect(screen.getAllByText('回到原文').length).toBe(3)
    // 用户自己写的那句话与原文摘录分开显示,不是糊成一段。
    expect(screen.getByText('我自己写的')).toBeInTheDocument()
    expect(screen.getByText('原文一')).toBeInTheDocument()
  })

  it('回到原文时把书的 hash 与那条批注的 CFI 一起交给阅读器', async () => {
    const { onOpenBook } = await renderLibrary()
    fireEvent.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('button', {
        name: '笔记',
      }),
    )
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    fireEvent.click(screen.getAllByText('回到原文')[0]!)
    expect(onOpenBook).toHaveBeenCalledTimes(1)
    expect(onOpenBook.mock.calls[0]?.[0]).toMatchObject({
      bookId: HASH_A,
      hash: HASH_A,
      format: 'epub',
      cfi: 'epubcfi(/6/4!2/2)',
    })
  })

  it('没有批注时说清楚怎么才会有,而不是空白页', async () => {
    await renderLibrary(BOOKS)
    invokeCommandMock.mockImplementation((command) => {
      if (command === 'library.list') return Promise.resolve({ books: [...BOOKS] })
      if (command === 'reader.notes.list') return Promise.resolve({ notes: [] })
      return Promise.resolve(APP_INFO)
    })
    fireEvent.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('button', {
        name: '笔记',
      }),
    )
    expect(await screen.findByText('还没有批注')).toBeInTheDocument()
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

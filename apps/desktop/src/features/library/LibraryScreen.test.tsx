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
import {
  localDayKey,
  type AppInfo,
  type BookReadingStat,
  type LibraryBook,
  type LibrarySearchResponse,
  type NoteEntry,
} from '@deepread/shared'
import { LibraryScreen } from './LibraryScreen'
import { APP_THEMES } from './shelf-view'
import { invokeCommand } from '../../lib/ipc'
import { readCachedCover } from '../../lib/cover-store'
import { extractCover } from '@deepread/reader-adapter'
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
// `metaMock` 让个别用例能临时给「书里自带的元数据」—— 默认全 null,行为与
// 未 mock 时一致(解析不出东西 → 不回写)。
const metaMock = vi.hoisted(() => ({
  value: { title: null, author: null, publisher: null, language: null } as {
    title: string | null
    author: string | null
    publisher: string | null
    language: string | null
  },
}))

vi.mock('@deepread/reader-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepread/reader-adapter')>()
  return {
    ...actual,
    extractCover: vi.fn(async (): Promise<null> => null),
    extractTitle: vi.fn(async (): Promise<null> => null),
    extractMetadata: vi.fn(async () => metaMock.value),
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
    author: null,
    subtitle: null,
    publisher: null,
    language: null,
    format: 'epub',
    path: '/books/夜航书.epub',
    size: 2391,
    addedAt: '2026-09-09T00:00:00Z',
    progress: 0.42,
    lastReadAt: null,
    finishedAt: null,
    tags: [],
  },
  {
    hash: HASH_B,
    fileName: '化雪的季节.txt',
    displayName: '化雪的季节',
    author: null,
    subtitle: null,
    publisher: null,
    language: null,
    format: 'txt',
    path: '/books/化雪的季节.txt',
    size: 382,
    addedAt: '2026-09-08T00:00:00Z',
    progress: null,
    lastReadAt: null,
    finishedAt: null,
    tags: ['文学'],
  },
  {
    hash: HASH_C,
    fileName: '山中手记.fb2',
    displayName: '山中手记',
    author: null,
    subtitle: null,
    publisher: null,
    language: null,
    format: 'fb2',
    path: '/books/山中手记.fb2',
    size: 619,
    addedAt: '2026-09-07T00:00:00Z',
    progress: 1,
    // 「现在」而不是硬编码日期:年度目标用例按本地年现算,不会随年份烂掉。
    lastReadAt: null,
    finishedAt: new Date().toISOString(),
    tags: ['文学', '随笔'],
  },
]

const APP_INFO: AppInfo = {
  appName: 'DeepRead',
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

/** 每本书累计读了多少;第二条没有元数据标题,考的是文件名回退。 */
const TOP_BOOKS: readonly BookReadingStat[] = [
  { bookHash: HASH_A, displayName: '夜航书', fileName: 'x.epub', seconds: 5400 },
  { bookHash: HASH_B, displayName: null, fileName: '化雪的季节.txt', seconds: 1800 },
]

function mockBackend(books: readonly LibraryBook[], notes: readonly NoteEntry[] = NOTES): void {
  invokeCommandMock.mockImplementation((command, request) => {
    if (command === 'library.list') return Promise.resolve({ books: [...books] })
    if (command === 'library.search')
      return Promise.resolve({ books: [], hits: [], indexedBooks: 0 })
    // 阅读目标:默认没有;set 回显落库值(与 Rust/web 两侧同一契约)。
    if (command === 'reading.goal.get')
      return Promise.resolve({
        goals: { dailyMinutes: 0, weeklyDays: 0, yearlyBooks: 0 },
      })
    if (command === 'reading.goal.set') {
      const { goals } = request as { goals: Record<string, number> }
      return Promise.resolve({
        goals: { dailyMinutes: 0, weeklyDays: 0, yearlyBooks: 0, ...goals },
      })
    }
    if (command === 'reader.stats.get') return Promise.resolve(STATS)
    if (command === 'reader.stats.books') return Promise.resolve({ books: [...TOP_BOOKS] })
    if (command === 'reader.notes.list') return Promise.resolve({ notes: [...notes] })
    if (command === 'library.remove') return Promise.resolve({ ok: true })
    if (command === 'library.tag.set') {
      const { bookHash, tags } = request as { bookHash: string; tags: readonly string[] }
      const book = books.find((item) => item.hash === bookHash) ?? books[0]!
      return Promise.resolve({ book: { ...book, tags: [...tags] } })
    }
    if (command === 'library.info.set') {
      const { bookHash, displayName } = request as { bookHash: string; displayName: string }
      const book = books.find((item) => item.hash === bookHash) ?? books[0]!
      return Promise.resolve({ book: { ...book, displayName } })
    }
    if (command === 'reader.note.update') {
      const { noteId, note } = request as { noteId: string; note: string }
      const original = notes.find((item) => item.id === noteId) ?? NOTES[0]!
      const trimmed = note.trim()
      return Promise.resolve({
        entry: {
          ...original,
          note: trimmed === '' ? null : trimmed,
          updatedAt: '2026-09-29T00:00:00Z',
        },
      })
    }
    return Promise.resolve(APP_INFO)
  })
}

/** 等到书架工具栏出现(ready 态的唯一信号),不靠「等错误消失」。 */
async function renderLibrary(books: readonly LibraryBook[] = BOOKS) {
  mockBackend(books)
  const onOpenBook = vi.fn()
  const onOpenParallel = vi.fn()
  const view = render(<LibraryScreen onOpenBook={onOpenBook} onOpenParallel={onOpenParallel} />)
  if (books.length > 0) {
    await waitFor(() => expect(document.querySelector('.shelf-toolbar')).not.toBeNull())
  } else {
    await waitFor(() => expect(document.querySelector('.shelf-skeleton')).toBeNull())
  }
  return { onOpenBook, onOpenParallel, view }
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

/** 侧栏里的一个按钮:统计、设置、云同步、我的分组都从这里进,不再散在顶栏与工具栏。 */
function sidebarButton(name: string | RegExp): HTMLElement {
  return within(screen.getByRole('complementary', { name: '主导航' })).getByRole('button', {
    name,
  })
}

beforeEach(() => {
  invokeCommandMock.mockReset()
  openMock.mockReset()
  openMock.mockResolvedValue(null)
  localStorage.clear()
  metaMock.value = { title: null, author: null, publisher: null, language: null }
  vi.mocked(readCachedCover).mockImplementation(async () => null)
})

describe('LibraryScreen 外壳契约', () => {
  it('没有独立顶栏:品牌住进侧栏顶部,导入回到工具栏', async () => {
    await renderLibrary()
    expect(document.querySelector('.library-header')).toBeNull()

    const brand = document.querySelector('.lib-brand')
    expect(brand).not.toBeNull()
    expect(brand!.textContent).toContain('DeepRead')
    // 副标题砍掉了:品牌行只留名字,把高度让给下面的分组。
    expect(brand!.textContent).not.toContain('个人阅读操作系统')
    // 整条品牌区同时是窗口拖拽区(macOS 交通灯就在它上面那条窗口条里)。
    expect(brand!.getAttribute('data-tauri-drag-region')).not.toBeNull()

    // 全局入口各归一处:设置在侧栏底部,导入在工具栏右侧。
    expect(sidebarButton('设置')).toBeInTheDocument()
    expect(sidebarButton('云同步')).toBeInTheDocument()
    expect(toolbarButtons()).toContain('导入书籍')
  })

  it('侧栏开关常驻:收起后主区拿到全部宽度,开关还点得到', async () => {
    await renderLibrary()
    const shell = document.querySelector('.library')
    const toggle = screen.getByLabelText('隐藏侧边栏')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(toggle)
    expect(shell!.classList.contains('is-sidebar-hidden')).toBe(true)
    // 关键:开关不在侧栏内部 —— 否则收起之后它跟着消失,就再也打不开了。
    expect(document.querySelector('.lib-sidebar')?.contains(toggle)).toBe(false)
    expect(screen.getByLabelText('显示侧边栏')).toBeInTheDocument()
    // 收起只是淡出 + 让出宽度,节点还在原地,展开时不用重建。
    expect(screen.getByRole('complementary', { name: '主导航' })).toBeInTheDocument()
    expect(localStorage.getItem('deepread.shelf.sidebar')).toBe('hidden')

    fireEvent.click(screen.getByLabelText('显示侧边栏'))
    expect(shell!.classList.contains('is-sidebar-hidden')).toBe(false)
  })

  it('侧栏收起状态会被记住', async () => {
    localStorage.setItem('deepread.shelf.sidebar', 'hidden')
    await renderLibrary()
    expect(document.querySelector('.library')!.classList.contains('is-sidebar-hidden')).toBe(true)
    expect(screen.getByLabelText('显示侧边栏')).toHaveAttribute('aria-expanded', 'false')
  })

  it('书架工具栏的控件按序排列,一个不多一个不少', async () => {
    await renderLibrary()
    expect(toolbarButtons()).toEqual([
      '网格视图',
      '列表视图',
      '排序方式',
      '切换排序方向(当前降序)',
      '批量管理',
      '导入书籍',
    ])
    expect(document.querySelector('.shelf-title')?.textContent).toContain('书架')
    expect(screen.getByLabelText('搜索书名')).toBeInTheDocument()
  })

  it('标签只在侧栏出现一份,并带上确定性色点', async () => {
    await renderLibrary()
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    expect(within(sidebar).getByRole('button', { name: '文学' })).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: '随笔' })).toBeInTheDocument()
    expect(sidebar.querySelectorAll('.lib-sidebar-dot').length).toBe(2)
    // 工具栏不再有第二份标签筛选。
    expect(toolbarButtons()).not.toContain('按标签筛选')
  })

  it('空书架也保留顶部栏(标题 + 导入),主区是引导而不是空网格', async () => {
    await renderLibrary([])
    const empty = document.querySelector('.library-empty')
    expect(empty).not.toBeNull()
    expect(screen.getByText(/把书拖进窗口/)).toBeInTheDocument()
    expect(document.querySelector('.shelf-grid')).toBeNull()
    expect(document.querySelector('.shelf-list')).toBeNull()

    // 页面骨架不该因为"没有书"就消失 —— 顶部栏还在,标题照旧。
    const toolbar = document.querySelector('.shelf-toolbar')
    expect(toolbar).not.toBeNull()
    expect(toolbar!.textContent).toContain('书架')

    // 但只留标题 + 导入:搜索/视图切换/排序/批量管理在空书架时没有操作对象,
    // 摆一排点不动的控件比没有更糟。
    expect(toolbarButtons()).toEqual(['导入书籍'])
  })

  it('读架失败显示错误态与重试,而不是伪装成「还没有书」', async () => {
    mockBackend(BOOKS)
    const standard = invokeCommandMock.getMockImplementation()!
    invokeCommandMock.mockImplementation((command, request) =>
      command === 'library.list'
        ? Promise.reject(new Error('数据库打不开'))
        : standard(command, request),
    )
    render(<LibraryScreen onOpenBook={vi.fn()} onOpenParallel={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('书架暂时打不开')
    expect(alert).toHaveTextContent('数据库打不开')

    // 重试成功后错误态退场,书架正常出现。
    invokeCommandMock.mockImplementation(standard)
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(document.querySelector('.shelf-toolbar')).not.toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('标题旁的摘要行如实报告本数与在读数,没有底部状态栏', async () => {
    await renderLibrary()
    const subline = document.querySelector('.shelf-subline')
    expect(subline?.textContent).toContain('3 本')
    // 一本 42% 在读、一本读完(归「已读完」)、一本没开过。
    expect(subline?.textContent).toContain('在读 1')
    // 版本号与平台架构是 dev 信息,不进产品 UI。
    expect(document.querySelector('.library-footer')).toBeNull()
  })
})

describe('LibraryScreen 书架渲染', () => {
  it('网格里的每本书只说「这是什么书」:标题加作者,进度压在封面底边', async () => {
    await renderLibrary()
    expect(document.querySelector('.shelf-grid')).not.toBeNull()
    // 格式徽章退场:封面是书的门面,不贴 EPUB/MOBI 胶囊。
    expect(document.querySelector('.book-format')).toBeNull()
    // 卡片文字只剩书名与作者;大小与进度文案不再挂在卡片下面。
    expect(screen.queryByText(/KB/)).toBeNull()
    // 进度是封面底边的细线(夜航书 42%)。
    const fill = document.querySelector(
      '.book-cover-progress .book-progress-fill',
    ) as HTMLElement | null
    expect(fill?.style.width).toBe('42%')
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

  it('列表行的悬浮动作与网格同一套:收藏 + 更多,全量动作在菜单里', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('列表视图'))
    const actions = document.querySelector('.book-row .book-row-actions')!
    expect(
      [...actions.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    ).toEqual(['收藏 夜航书', '更多操作 夜航书'])

    // ⋯ 菜单就是右键菜单:打标签/导出/编辑/移除都在,一项不少。
    fireEvent.click(within(actions as HTMLElement).getByLabelText('更多操作 夜航书'))
    expect(screen.getByRole('menu', { name: '夜航书 的操作' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '导出批注(.md)' })).toBeInTheDocument()
  })

  it('搜索过滤到零本时说清是没匹配,而不是空白', async () => {
    await renderLibrary()
    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '不存在的书' } })
    expect(await screen.findByText(/没有匹配/, { exact: false })).toBeInTheDocument()
  })

  it('移除是两次点击:第一次只是待确认,第二次才落 IPC(入口在 ⋯ 菜单)', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByLabelText('更多操作 夜航书'))
    fireEvent.click(screen.getByRole('menuitem', { name: '从书架移除' }))
    // 菜单留着让用户看清后果,IPC 一个都没发。
    expect(
      screen.getByRole('menuitem', { name: '确认移除(进度与批注一并删除)' }),
    ).toBeInTheDocument()
    expect(invokeCommandMock).not.toHaveBeenCalledWith('library.remove', expect.anything())

    fireEvent.click(screen.getByRole('menuitem', { name: '确认移除(进度与批注一并删除)' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.remove', { bookHash: HASH_A }),
    )
  })
})

describe('LibraryScreen 每行书本数(设置弹窗)', () => {
  /** 行数控件住设置弹窗的书架偏好分区:低频偏好不占工具条。 */
  async function openShelfPrefs(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    return await screen.findByRole('dialog', { name: '设置' })
  }

  it('设置里选固定列数,持久化并即时反映到书架网格', async () => {
    await renderLibrary()
    await openShelfPrefs()
    const trigger = screen.getByLabelText('每行显示的书本数')
    expect(trigger).toHaveTextContent('自适应')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '每行 4 本' }))
    expect(localStorage.getItem('deepread.shelf.columns')).toBe('4')
    // 触发器同步显示当前档位。
    expect(screen.getByLabelText('每行显示的书本数')).toHaveTextContent('每行 4 本')
  })

  it('固定列数被记住,下次进入书架仍生效', async () => {
    localStorage.setItem('deepread.shelf.columns', '6')
    await renderLibrary()
    expect(document.querySelector('.shelf-grid')!.classList.contains('is-fixed')).toBe(true)
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
    fireEvent.click(sidebarButton('随笔'))
    await waitFor(() => expect(screen.queryByText('夜航书')).toBeNull())
    expect(screen.getAllByText('山中手记').length).toBeGreaterThan(0)
  })

  it('我的分组按进度现算,并可叠加标签', async () => {
    await renderLibrary()
    // 一本 42%、一本读完、一本没开过。
    expect(sidebarButton(/在读/).textContent).toContain('1')
    expect(sidebarButton(/已读完/).textContent).toContain('1')
    expect(sidebarButton(/全部/).textContent).toContain('3')

    fireEvent.click(sidebarButton(/已读完/))
    await waitFor(() => expect(screen.queryByText('夜航书')).toBeNull())
    expect(screen.getAllByText('山中手记').length).toBeGreaterThan(0)

    // 叠加标签:读完的那本带「随笔」,仍在,而 42% 那本被两个条件同时排除。
    fireEvent.click(sidebarButton('随笔'))
    expect(screen.getAllByText('山中手记').length).toBeGreaterThan(0)
    expect(screen.queryByText('化雪的季节')).toBeNull()
  })
})

/** 批量条是否已收起。jsdom 不加载 global.css,所以断言的是驱动动画的 class 与
    inert(真浏览器里 visibility: hidden 会让它彻底离开可访问树)。 */
function bulkCollapsed(): boolean {
  const bar = document.querySelector('.shelf-bulk')
  return bar === null || bar.classList.contains('is-hidden')
}

describe('LibraryScreen 批量管理', () => {
  it('点空白处退出管理,点卡片只切换选中', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('批量管理'))
    const bulk = screen.getByRole('toolbar', { name: '批量操作' })
    expect(bulk).toBeInTheDocument()

    // 点卡片是"选中/取消选中",管理态必须留着。管理态下封面的 title 换成
    // 「选择这本书」—— 找它而不是书名,免得断言绑死在别处改过的文案上。
    fireEvent.pointerDown(screen.getAllByTitle('选择这本书')[0] as HTMLElement)
    expect(screen.getByRole('toolbar', { name: '批量操作' })).toBeInTheDocument()

    // 点主区空白处才是退出。
    fireEvent.pointerDown(document.querySelector('.library-main') as HTMLElement)
    await waitFor(() => expect(bulkCollapsed()).toBe(true))
  })

  it('进入管理态展开批量条,退出后收起', async () => {
    await renderLibrary()
    expect(bulkCollapsed()).toBe(true)
    fireEvent.click(screen.getByTitle('批量管理'))
    const bar = screen.getByRole('toolbar', { name: '批量操作' })
    expect(bar.textContent).toContain('已选 0 本')

    fireEvent.click(within(bar).getByText('全选'))
    expect(bar.textContent).toContain('已选 3 本')

    fireEvent.click(screen.getByTitle('退出批量管理'))
    // 退场是一条 CSS 过渡:元素留在原地收起,而不是被卸载 —— 否则空间会在卸载
    // 瞬间塌掉、书往上跳一下。inert 保证这期间按钮点不到、Tab 不到。
    const collapsed = document.querySelector('.shelf-bulk') as HTMLElement
    expect(collapsed.classList.contains('is-hidden')).toBe(true)
    expect(collapsed.hasAttribute('inert')).toBe(true)
    await waitFor(() => expect(bulkCollapsed()).toBe(true))
  })

  it('批量收藏:一次把选中的都加上,再点一次一起取消', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('批量管理'))
    const bar = screen.getByRole('toolbar', { name: '批量操作' })
    fireEvent.click(within(bar).getByText('全选'))

    fireEvent.click(within(bar).getByText('收藏'))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['收藏'],
      }),
    )
    // 收藏也是标签,所以走的还是同一条命令,侧栏筛选自动带上它。
    expect(within(bar).getByText('取消收藏')).toBeInTheDocument()

    invokeCommandMock.mockClear()
    fireEvent.click(within(bar).getByText('取消收藏'))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: [],
      }),
    )
  })

  it('批量加标签:浮层里常用标签与自定义输入都能落库', async () => {
    await renderLibrary()
    fireEvent.click(screen.getByTitle('批量管理'))
    fireEvent.click(within(screen.getByRole('toolbar', { name: '批量操作' })).getByText('全选'))

    fireEvent.click(
      within(screen.getByRole('toolbar', { name: '批量操作' })).getByRole('button', {
        name: '加标签',
      }),
    )
    const popover = screen.getByRole('dialog', { name: '批量加标签' })

    // 常用标签:点一下即应用到所有选中的书。
    fireEvent.click(within(popover).getByText('历史'))
    await waitFor(() => {
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['历史'],
      })
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_B,
        tags: ['文学', '历史'],
      })
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_C,
        tags: ['文学', '随笔', '历史'],
      })
    })

    // 自定义输入:回车即打;连续应用时后一次要看到前一次的结果(乐观更新)。
    invokeCommandMock.mockClear()
    const input = within(popover).getByLabelText('自定义标签')
    fireEvent.change(input, { target: { value: '睡前' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['历史', '睡前'],
      }),
    )
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

describe('LibraryScreen 跨书搜索(library.search)', () => {
  /** 一次跨书搜索的两层结果:书目命中一本,正文命中一条。 */
  const SEARCH_RESPONSE = {
    books: [BOOKS[0]!],
    hits: [
      {
        bookHash: HASH_A,
        displayName: '夜航书',
        fileName: '夜航书.epub',
        label: '第三章 夜航',
        excerpt: '他想起那个起雾的下午',
      },
    ],
    indexedBooks: 2,
  }

  function respondSearch(response: LibrarySearchResponse): void {
    invokeCommandMock.mockImplementation((command) => {
      if (command === 'library.list') return Promise.resolve({ books: [...BOOKS] })
      if (command === 'library.search') return Promise.resolve(response)
      return Promise.resolve(APP_INFO)
    })
  }

  it('查询词防抖 200ms 后问后端,书目与正文命中分开呈现', async () => {
    const { onOpenBook } = await renderLibrary()
    respondSearch(SEARCH_RESPONSE)

    // 连打两个字符:防抖应该只留下最后一次查询。
    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '夜' } })
    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '夜航' } })

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.search', { query: '夜航' }),
    )
    const searchCalls = invokeCommandMock.mock.calls.filter(
      ([command]) => command === 'library.search',
    )
    expect(searchCalls).toHaveLength(1)

    // 书目命中进网格(只留夜航书),正文命中单独一列,在网格上方。
    expect(await screen.findByLabelText('全文匹配')).toBeInTheDocument()
    expect(screen.getAllByText('夜航书').length).toBeGreaterThan(0)
    expect(screen.queryByText('化雪的季节')).toBeNull()

    const section = screen.getByLabelText('全文匹配')
    expect(section.textContent).toContain('基于已建 AI 索引的 2 本书')
    expect(section.textContent).toContain('第三章 夜航')
    expect(section.textContent).toContain('他想起那个起雾的下午')

    // 点正文命中:带着章节 label 打开这本书(定位由阅读器按目录解析),
    // 不带 CFI —— 点的是「跳到那一章」,不是某一句。
    fireEvent.click(within(section).getByText('第三章 夜航'))
    expect(onOpenBook).toHaveBeenCalledTimes(1)
    expect(onOpenBook.mock.calls[0]?.[0]).toMatchObject({
      bookId: HASH_A,
      sectionLabel: '第三章 夜航',
    })
    expect(onOpenBook.mock.calls[0]?.[0]).not.toHaveProperty('cfi')
  })

  it('正文命中达到上限时说清截断了;书目没命中也不藏掉正文命中', async () => {
    const hits = Array.from({ length: 30 }, (_unused, index) => ({
      bookHash: HASH_A,
      displayName: '夜航书',
      fileName: '夜航书.epub',
      label: `第 ${index} 章`,
      excerpt: `片段 ${index}`,
    }))
    await renderLibrary()
    respondSearch({ books: [], hits, indexedBooks: 1 })

    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '片段' } })
    const section = await screen.findByLabelText('全文匹配')
    expect(section.querySelectorAll('.shelf-search-hit')).toHaveLength(30)
    expect(section.textContent).toContain('(已达上限)')

    // 书目层零命中:网格说「没有匹配」,但上面的正文命中列照样在。
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument()
    expect(section).toBeInTheDocument()
  })

  it('一条正文命中都没有时不出这一列', async () => {
    await renderLibrary()
    respondSearch({ books: [BOOKS[0]!], hits: [], indexedBooks: 0 })

    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '夜航' } })
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.search', { query: '夜航' }),
    )
    expect(screen.queryByLabelText('全文匹配')).toBeNull()
  })

  it('清空查询词时两层结果一起收起', async () => {
    await renderLibrary()
    respondSearch(SEARCH_RESPONSE)

    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '夜航' } })
    expect(await screen.findByLabelText('全文匹配')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索书名'), { target: { value: '' } })
    await waitFor(() => expect(screen.queryByLabelText('全文匹配')).toBeNull())
    // 全部三本书回到架上(每本的书名在封面与标题各出现一次)。
    expect(screen.getAllByText('夜航书').length).toBeGreaterThan(0)
    expect(screen.getAllByText('化雪的季节').length).toBeGreaterThan(0)
  })
})

describe('LibraryScreen 阅读目标(统计页)', () => {
  /** 进统计页:目标是这一页的一等公民,不在设置弹窗里。 */
  async function openStats(): Promise<void> {
    fireEvent.click(sidebarButton('统计'))
    await screen.findByLabelText('阅读统计')
  }

  it('没设目标时侧栏只报今日时长,统计页 hero 不画环', async () => {
    await renderLibrary()
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    // STATS:今天 600 秒。没有目标就不拿"目标"吓人。
    await waitFor(() => expect(within(sidebar).getByText('今日已读 10 分钟')).toBeInTheDocument())

    await openStats()
    const page = screen.getByLabelText('阅读统计')
    // 0% 的环会把「没定目标」演成「今天完全没读」—— 宁可不画。
    expect(page.querySelector('.stats-goal-ring')).toBeNull()
    expect(within(page).getByText('今日已读')).toBeInTheDocument()
    expect(within(page).getByRole('button', { name: '设定每日目标' })).toBeInTheDocument()
  })

  it('统计页里点预设即存:侧栏摘要与 hero 环一起更新', async () => {
    await renderLibrary()
    await openStats()
    const page = screen.getByLabelText('阅读统计')

    fireEvent.click(within(page).getByRole('button', { name: '设定每日目标' }))
    fireEvent.click(within(page).getByRole('button', { name: '30分' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reading.goal.set', {
        goals: { dailyMinutes: 30, weeklyDays: 0, yearlyBooks: 0 },
      }),
    )

    // 侧栏换成目标卡:主数字与目标行分开(今日 10 分钟,目标 30 分钟,未达成)。
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    await waitFor(() => {
      expect(within(sidebar).getByText('今日 10 分钟')).toBeInTheDocument()
      expect(within(sidebar).getByText('目标 30 分钟')).toBeInTheDocument()
    })

    // 统计页:今日 600s / 目标 1800s ≈ 33%,环与达标天数都在。
    expect(within(page).getByText('33%')).toBeInTheDocument()
    expect(within(page).getByText(/本周达标 0 \/ 7 天/)).toBeInTheDocument()
    // 目标线出现在画布内(峰值把目标秒数算进去了)。
    const line = page.querySelector<HTMLElement>('.stats-chart-goal')
    expect(line).not.toBeNull()
    expect(line!.style.bottom).not.toBe('')
  })

  it('目标设得比今天读得少时,环画满并标记已达成', async () => {
    await renderLibrary()
    await openStats()
    const page = screen.getByLabelText('阅读统计')

    // 5 分目标(预设最小 15 分,超额场景走自定义输入):今天 10 分超额。
    fireEvent.click(within(page).getByRole('button', { name: '设定每日目标' }))
    fireEvent.change(within(page).getByLabelText('每日阅读目标(分钟)'), {
      target: { value: '5' },
    })
    fireEvent.click(within(page).getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reading.goal.set', {
        goals: { dailyMinutes: 5, weeklyDays: 0, yearlyBooks: 0 },
      }),
    )

    // 侧栏目标行写明已达成;统计页比值 2 → 环画满(100%),百分比照实显示 200%。
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    await waitFor(() => {
      expect(within(sidebar).getByText('今日 10 分钟')).toBeInTheDocument()
      expect(within(sidebar).getByText('已达成')).toBeInTheDocument()
    })
    expect(within(page).getByText('200%')).toBeInTheDocument()
  })

  it('清除目标后摘要回到只报今日时长', async () => {
    await renderLibrary()
    await openStats()
    const page = screen.getByLabelText('阅读统计')

    fireEvent.click(within(page).getByRole('button', { name: '设定每日目标' }))
    fireEvent.click(within(page).getByRole('button', { name: '30分' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reading.goal.set', {
        goals: { dailyMinutes: 30, weeklyDays: 0, yearlyBooks: 0 },
      }),
    )

    // 编辑器在设完目标后依然开着(芯片点了就存,不收回),直接点清除。
    fireEvent.click(within(page).getByRole('button', { name: '清除' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reading.goal.set', {
        goals: { dailyMinutes: 0, weeklyDays: 0, yearlyBooks: 0 },
      }),
    )
    await waitFor(() =>
      expect(
        within(screen.getByRole('complementary', { name: '主导航' })).getByText('今日已读 10 分钟'),
      ).toBeInTheDocument(),
    )
    expect(page.querySelector('.stats-goal-ring')).toBeNull()
  })

  it('非法自定义值给出明确错误,不发 IPC', async () => {
    await renderLibrary()
    await openStats()
    const page = screen.getByLabelText('阅读统计')

    fireEvent.click(within(page).getByRole('button', { name: '设定每日目标' }))
    fireEvent.change(within(page).getByLabelText('每日阅读目标(分钟)'), {
      target: { value: '9999' },
    })
    fireEvent.click(within(page).getByRole('button', { name: '确定' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/0 到 1440 之间的整数/)
    expect(invokeCommandMock).not.toHaveBeenCalledWith('reading.goal.set', expect.anything())
  })

  it('每周与年度目标各设各的,进度按各自的尺现算', async () => {
    await renderLibrary()
    await openStats()
    const page = screen.getByLabelText('阅读统计')

    // 每周 3 天:STATS 只有今天读过 → 最近 7 天 1 天,还差 2 天。
    const weeklyRow = within(page)
      .getByRole('button', { name: '设定每周目标' })
      .closest('.stats-overview-row') as HTMLElement
    fireEvent.click(within(weeklyRow).getByRole('button', { name: '设定每周目标' }))
    fireEvent.click(within(weeklyRow).getByRole('button', { name: '3天' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reading.goal.set', {
        goals: { dailyMinutes: 0, weeklyDays: 3, yearlyBooks: 0 },
      }),
    )
    expect(within(weeklyRow).getByText(/目标 3 天 · 还差 2 天/)).toBeInTheDocument()

    // 年度 12 本:BOOKS 里有一本今年读完(盖章时间 = 导入时刻)→ 1 / 12,还剩 11 本。
    const yearlyRow = within(page)
      .getByRole('button', { name: '设定年度目标' })
      .closest('.stats-overview-row') as HTMLElement
    fireEvent.click(within(yearlyRow).getByRole('button', { name: '设定年度目标' }))
    fireEvent.click(within(yearlyRow).getByRole('button', { name: '12本' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reading.goal.set', {
        goals: { dailyMinutes: 0, weeklyDays: 3, yearlyBooks: 12 },
      }),
    )
    expect(within(yearlyRow).getByText('1 / 12 本')).toBeInTheDocument()
    expect(within(yearlyRow).getByText('还剩 11 本')).toBeInTheDocument()
  })

  it('设置弹窗只有四个分区:目标不住设置里', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton('设置'))
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())
    expect(tabs).toEqual(['外观', '快捷键', 'AI 服务', '备份与更新'])
  })
})
describe('LibraryScreen 侧栏导航', () => {
  it('侧栏列出三个目的地,默认停在书架', async () => {
    await renderLibrary()
    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    const nav = sidebar.querySelector('nav[aria-label="视图"]')
    expect(nav).not.toBeNull()
    expect(
      [...nav!.querySelectorAll('button')].map((button) =>
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

    fireEvent.click(within(sidebar).getByRole('button', { name: /^笔记/ }))
    expect(screen.getByLabelText('笔记')).toBeInTheDocument()
    expect(document.querySelector('.shelf-toolbar')).toBeNull()

    fireEvent.click(within(sidebar).getByRole('button', { name: '统计' }))
    expect(await screen.findByLabelText('阅读统计')).toBeInTheDocument()
    expect(document.querySelectorAll('.stats-bar').length).toBe(7)

    fireEvent.click(within(sidebar).getByRole('button', { name: /书架/ }))
    expect(document.querySelector('.shelf-toolbar')).not.toBeNull()
  })

  it('侧栏标签再点一次是取消筛选,不是叠加条件', async () => {
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
  it('统计页有四块指标、最近 7 天与读得最久的书', async () => {
    const { onOpenBook } = await renderLibrary()
    fireEvent.click(sidebarButton('统计'))
    const page = await screen.findByLabelText('阅读统计')
    expect(invokeCommandMock).toHaveBeenCalledWith('reader.stats.get', undefined)
    expect(invokeCommandMock).toHaveBeenCalledWith('reader.stats.books', undefined)

    // 四块累计指标:总时长 / 连续 / 读完本数 / 日均。
    for (const label of ['累计时长', '连续天数', '已读完', '平均每日']) {
      expect(within(page).getByText(label)).toBeInTheDocument()
    }
    expect(within(page).getByText('10 分')).toBeInTheDocument()
    // 累计不在四块里了,但仍是柱状图下面那句说明的底数。
    expect(page.textContent).toContain('累计 50 分')
    const tiles = [...page.querySelectorAll('.stats-tile')]
    expect(tiles).toHaveLength(4)
    // 已读完:BOOKS 里只有一本读到 100%。
    expect(tiles[2]?.textContent).toContain('1')
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

    // 排行榜:降序,书名走与书架同一个回退规则(第二条没有元数据标题)。
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('.stats-rank-open')]
      expect(found).toHaveLength(2)
      return found
    })
    expect(rows.map((row) => row.querySelector('.stats-rank-name')?.textContent)).toEqual([
      '夜航书',
      '化雪的季节',
    ])
    expect(rows[0]?.textContent).toContain('1.5 小时')
    expect(rows[1]?.textContent).toContain('30 分')

    // 点排行榜打开那本书:位置由阅读器自己决定,所以不带 CFI。
    fireEvent.click(rows[0]!)
    expect(onOpenBook).toHaveBeenCalledTimes(1)
    expect(onOpenBook.mock.calls[0]?.[0]).toMatchObject({ bookId: HASH_A })
    expect(onOpenBook.mock.calls[0]?.[0]).not.toHaveProperty('cfi')
  })
})

describe('LibraryScreen 弹窗', () => {
  it('设置弹窗三个分区都在,外观区列出全部主题', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton('设置'))
    const dialog = await screen.findByLabelText('设置')
    expect(within(dialog).getByText('外观')).toBeInTheDocument()
    expect(within(dialog).getByText('AI 服务')).toBeInTheDocument()
    expect(within(dialog).getByText('备份与更新')).toBeInTheDocument()
    // 个数从 APP_THEMES 派生:加主题不该让这条断言变红(它锁的是
    // 「列全了」,不是「有 12 个」)。
    expect(document.querySelectorAll('.theme-swatch').length).toBe(APP_THEMES.length)
  })

  it('备份与更新分区提供备份、恢复、检查更新三个动作', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton('设置'))
    fireEvent.click(screen.getByText('备份与更新'))
    expect(screen.getByText('备份到…')).toBeInTheDocument()
    expect(screen.getByText('从备份恢复…')).toBeInTheDocument()
    expect(screen.getByText('检查更新')).toBeInTheDocument()
  })

  it('Esc 关掉打开的弹窗', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton('设置'))
    expect(await screen.findByLabelText('设置')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('设置')).toBeNull())
  })

  it('云同步走抽屉而不是弹窗', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton('云同步'))
    expect(screen.getByTestId('sync-drawer')).toBeInTheDocument()
  })
})

describe('LibraryScreen 卡片操作', () => {
  it('每张卡片给星标与更多两颗玻璃按钮,全量动作在菜单里', async () => {
    await renderLibrary()
    expect(screen.getAllByLabelText(/^收藏 /).length).toBe(3)
    expect(screen.getAllByLabelText(/^更多操作 /).length).toBe(3)
    // 打标签/编辑/移出不再各占一颗图标 —— 都在 ⋯ 菜单(与右键同一份)。
    expect(screen.queryByLabelText('给《夜航书》打标签')).toBeNull()
    expect(screen.queryByLabelText('编辑《夜航书》的信息')).toBeNull()
    expect(screen.queryByLabelText('移出《夜航书》')).toBeNull()
  })

  it('继续阅读 hero 卡浮现最近在读的那本,大封面加大标题加进度线', async () => {
    await renderLibrary([{ ...BOOKS[0]!, lastReadAt: '2026-09-30T10:00:00Z' }])
    const hero = document.querySelector('.continue-reading')
    expect(hero).not.toBeNull()
    expect(hero?.textContent).toContain('夜航书')
    expect(hero?.textContent).toContain('继续阅读')
    const fill = hero!.querySelector<HTMLElement>('.continue-reading-fill')!
    expect(fill.style.width).toBe('42%')
  })

  it('菜单里的导出:落成 .md 只含这一本', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })

    await renderLibrary()
    fireEvent.contextMenu(screen.getByTitle('打开《夜航书》'))
    fireEvent.click(screen.getByRole('menuitem', { name: '导出批注(.md)' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const markdown = await (createObjectURL.mock.calls[0]![0] as Blob).text()
    expect(markdown).toContain('## 夜航书')
  })

  it('更多菜单能由右键与键盘两种方式唤起', async () => {
    await renderLibrary()
    const menuName = '夜航书 的操作'

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

  it('菜单是动作全集:打标签、导出批注、编辑、移除(⋯ 紧凑档的展开全靠它)', async () => {
    await renderLibrary()
    fireEvent.contextMenu(screen.getByTitle('打开《夜航书》'))
    const menu = screen.getByRole('menu', { name: '夜航书 的操作' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim()),
    ).toEqual(['打标签', '导出批注(.md)', '编辑书籍信息', '从书架移除'])

    // 菜单里的打标签走的也是标签浮层,不是元数据表单。
    fireEvent.click(within(menu).getByRole('menuitem', { name: '打标签' }))
    expect(screen.getByRole('dialog', { name: '《夜航书》的标签' })).toBeInTheDocument()
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
    fireEvent.contextMenu(screen.getByTitle('打开《夜航书》'))
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
    // 编辑入口在 ⋯ 菜单(与右键同一份);标签也在同一张表里。
    fireEvent.contextMenu(screen.getByTitle('打开《夜航书》'))
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑书籍信息' }))
    return screen.findByLabelText('书籍信息')
  }

  it('元数据走 library.info.set,标签走 library.tag.set', async () => {
    const dialog = await openInfo()
    fireEvent.change(within(dialog).getByLabelText('书名'), {
      target: { value: '夜航书(修订版)' },
    })
    fireEvent.change(within(dialog).getByLabelText('作者'), { target: { value: '圣埃克苏佩里' } })
    fireEvent.change(within(dialog).getByLabelText('标签'), { target: { value: '文学, 收藏' } })
    fireEvent.click(within(dialog).getByText('保存'))

    // 四个元数据字段一次提交;没填的送 null(界面上"没填"只有一种表示)。
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.info.set', {
        bookHash: HASH_A,
        displayName: '夜航书(修订版)',
        author: '圣埃克苏佩里',
        subtitle: null,
        publisher: null,
        language: null,
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

  it('一键加常用标签:加在已有标签后面,加过的不再出现', async () => {
    const dialog = await openInfo()
    // 夜航书本来没有标签,第一次点击就是第一个。
    fireEvent.click(within(dialog).getByText('历史'))
    expect(within(dialog).getByLabelText('标签')).toHaveValue('历史')
    // 第二次接在逗号后面,不会多出一个空项。
    fireEvent.click(within(dialog).getByText('科幻'))
    expect(within(dialog).getByLabelText('标签')).toHaveValue('历史, 科幻')
    // 加过的标签从建议里消失(已选 chips 那一排不算)。
    const suggest = dialog.querySelector('.book-info-suggest') as HTMLElement
    expect(within(suggest).queryByText('历史')).toBeNull()
    expect(within(suggest).getByText('小说')).toBeInTheDocument()
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

describe('LibraryScreen 元数据回写', () => {
  // 独立的 hash:metaAttempted 是模块级状态(一次运行只解析一次),用别人用过的
  // hash 会被前一个用例标成「已处理」,测试就测不到东西了。
  const HASH_M = 'f'.repeat(64)
  const manual = (overrides: Partial<LibraryBook> = {}): LibraryBook => ({
    hash: HASH_M,
    fileName: '夜航书 (z-library).epub',
    displayName: '我改过的名字',
    author: null,
    subtitle: null,
    publisher: '我填的出版社',
    language: null,
    format: 'epub',
    path: '/books/夜航书.epub',
    size: 2391,
    addedAt: '2026-09-08T00:00:00Z',
    progress: null,
    lastReadAt: null,
    finishedAt: null,
    tags: [],
    ...overrides,
  })

  it('书里的元数据只补空着的字段,用户填过的一个都不动', async () => {
    metaMock.value = {
      title: '书里的标题',
      author: '书里的作者',
      publisher: '书里的出版社',
      language: 'zh',
    }
    await renderLibrary([manual()])

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.info.set', {
        bookHash: HASH_M,
        // 用户改过的名字与手填的出版社原样保留。
        displayName: '我改过的名字',
        publisher: '我填的出版社',
        // 空着的由书里补上。
        author: '书里的作者',
        language: 'zh',
        subtitle: null,
      }),
    )
  })

  it('书里解析不出任何元数据时不发 IPC,免得把空值写进库', async () => {
    await renderLibrary([manual({ displayName: '我改过的名字' })])
    await waitFor(() => expect(document.querySelector('.shelf-toolbar')).not.toBeNull())
    // 给异步解析留出一轮,确认它确实什么都没发。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invokeCommandMock).not.toHaveBeenCalledWith('library.info.set', expect.anything())
  })
})

describe('LibraryScreen 移除与重新导入', () => {
  // 用没人用过的 hash:coverAttempted / metaAttempted 是模块级的,借别人的 hash
  // 会被前一个用例标成「已处理」,就测不出重新解析了。
  const HASH_R = 'e'.repeat(64)
  const one = (): LibraryBook => ({
    hash: HASH_R,
    fileName: '长日将尽.epub',
    displayName: '长日将尽',
    author: '石黑一雄',
    subtitle: null,
    publisher: null,
    language: null,
    format: 'epub',
    path: '/books/长日将尽.epub',
    size: 606,
    addedAt: '2026-09-08T00:00:00Z',
    progress: null,
    lastReadAt: null,
    finishedAt: null,
    tags: [],
  })

  it('删掉再导入同一个文件,封面会重新读一遍(hash 相同,会话缓存必须一起清)', async () => {
    const readMock = vi.mocked(readCachedCover)
    // 关键设定:这本书**有**缓存封面。只有这样 coverAttempted 才会留在原地
    // (解析失败时会 delete,那条路掩盖了 bug)。
    readMock.mockImplementation(async () => 'asset://localhost/old-cover.png')
    readMock.mockClear()

    const first = await renderLibrary([one()])
    await waitFor(() => expect(readMock).toHaveBeenCalledWith(HASH_R))

    fireEvent.contextMenu(screen.getByTitle('打开《长日将尽》'))
    fireEvent.click(screen.getByRole('menuitem', { name: '从书架移除' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '确认移除(进度与批注一并删除)' }))
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.remove', { bookHash: HASH_R }),
    )

    // 重新导入 = 同一本书回到架上,hash 一模一样。缓存不清的话这里会直接命中
    // coverCache 里那张早就被删掉的旧图,封面空白且再也不重新读。
    readMock.mockClear()
    first.view.unmount()
    await renderLibrary([one()])
    await waitFor(() => expect(readMock).toHaveBeenCalledWith(HASH_R))
  })
})

describe('LibraryScreen 卡片标签浮层', () => {
  /** 打标签入口在 ⋯ 菜单里:从菜单进浮层,浮层本身的行为不变。 */
  async function openTagPopover(title: string): Promise<HTMLElement> {
    await renderLibrary()
    fireEvent.contextMenu(screen.getByTitle(`打开《${title}》`))
    fireEvent.click(screen.getByRole('menuitem', { name: '打标签' }))
    return screen.getByRole('dialog', { name: `《${title}》的标签` })
  }

  it('菜单里的打标签打开的是标签浮层,不是元数据表单', async () => {
    await openTagPopover('夜航书')

    expect(screen.getByRole('dialog', { name: '《夜航书》的标签' })).toBeInTheDocument()
    // 这个入口曾经错接到「编辑书籍信息」—— 点打标签却看到书名/出版社的表格。
    expect(screen.queryByLabelText('书籍信息')).toBeNull()
  })

  it('点建议标签立即落库,不需要再点保存', async () => {
    const pop = await openTagPopover('夜航书')
    fireEvent.click(within(pop).getByText('历史'))

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['历史'],
      }),
    )
  })

  it('输入的标签回车就加上,重复的不会加第二个', async () => {
    const pop = await openTagPopover('夜航书')
    const input = within(pop).getByLabelText('新标签')

    fireEvent.change(input, { target: { value: '睡前' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_A,
        tags: ['睡前'],
      }),
    )

    invokeCommandMock.mockClear()
    fireEvent.change(within(pop).getByLabelText('新标签'), { target: { value: '睡前' } })
    fireEvent.keyDown(within(pop).getByLabelText('新标签'), { key: 'Enter' })
    expect(invokeCommandMock).not.toHaveBeenCalledWith('library.tag.set', expect.anything())
  })

  it('点已加上的标签是去掉它', async () => {
    const pop = await openTagPopover('化雪的季节')
    // 这本 fixture 自带「文学」。
    fireEvent.click(within(pop).getByLabelText('去掉标签 文学'))

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('library.tag.set', {
        bookHash: HASH_B,
        tags: [],
      }),
    )
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
        name: /^笔记/,
      }),
    )

    expect(invokeCommandMock).toHaveBeenCalledWith('reader.notes.list', undefined)
    await waitFor(() => expect(document.querySelectorAll('.note-group').length).toBe(2))
    expect(screen.getByLabelText('夜航书').textContent).toContain('2 条')
    expect(screen.getByLabelText('化雪的季节').textContent).toContain('1 条')
    expect(screen.getAllByText('跳到原文').length).toBe(3)
    expect(screen.getAllByText('回到这本书').length).toBe(2)
    // 用户自己写的那句话与原文摘录分开显示,不是糊成一段。
    expect(screen.getByText('我自己写的')).toBeInTheDocument()
    expect(screen.getByText('原文一')).toBeInTheDocument()
  })

  it('回到原文时把书的 hash 与那条批注的 CFI 一起交给阅读器', async () => {
    const { onOpenBook } = await renderLibrary()
    fireEvent.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('button', {
        name: /^笔记/,
      }),
    )
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    fireEvent.click(screen.getAllByText('跳到原文')[0]!)
    expect(onOpenBook).toHaveBeenCalledTimes(1)
    expect(onOpenBook.mock.calls[0]?.[0]).toMatchObject({
      bookId: HASH_A,
      hash: HASH_A,
      format: 'epub',
      cfi: 'epubcfi(/6/4!2/2)',
    })
  })

  it('「回到这本书」不带 CFI:那是继续读,不是跳回某一句', async () => {
    const { onOpenBook } = await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-group').length).toBe(2))

    fireEvent.click(screen.getAllByText('回到这本书')[0]!)
    expect(onOpenBook).toHaveBeenCalledTimes(1)
    expect(onOpenBook.mock.calls[0]?.[0]).toMatchObject({ bookId: HASH_A })
    expect(onOpenBook.mock.calls[0]?.[0]).not.toHaveProperty('cfi')
  })

  it('复制把原文与自己写的那句话一起放进剪贴板', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    fireEvent.click(screen.getAllByText('复制')[0]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]?.[0]).toBe('原文一\n\n我自己写的')
    // 反馈落在按钮自己身上,不弹一个转瞬即逝的 toast。
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })

  it('「仅有笔记」只留下写了自己话的那几条', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    fireEvent.click(screen.getByText('仅有笔记'))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(1))
    expect(screen.getByText('我自己写的')).toBeInTheDocument()
  })

  it('复制为 Markdown 导出整页,按书分节', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    fireEvent.click(screen.getByText('复制为 Markdown'))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const markdown = String(writeText.mock.calls[0]?.[0])
    expect(markdown).toContain('# 阅读笔记')
    expect(markdown).toContain('## 夜航书')
    expect(markdown).toContain('> 原文一')
    expect(markdown).toContain('我自己写的')
  })

  it('单本书的导出图标落成 .md 下载,只含这一本', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })

    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-group').length).toBe(2))

    fireEvent.click(screen.getByLabelText('导出《夜航书》的批注'))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    const markdown = await blob.text()
    // 只导这一本:第二本的标题不该出现。
    expect(markdown).toContain('## 夜航书')
    expect(markdown).not.toContain('## 化雪的季节')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })

  it('编辑批注:保存走 reader.note.update,卡片原地换新文字', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    // 第一张卡(夜航书)进入编辑态。
    fireEvent.click(within(document.querySelector('.note-card') as HTMLElement).getByText('编辑'))
    const box = screen.getByLabelText('编辑批注') as HTMLTextAreaElement
    expect(box.value).toBe('我自己写的')
    fireEvent.change(box, { target: { value: '改过的话' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith('reader.note.update', {
        noteId: 'n1',
        note: '改过的话',
      }),
    )
    // 后端回传的整行替换进列表,卡片文字原地更新。
    await waitFor(() => expect(screen.getByText('改过的话')).toBeInTheDocument())
    expect(screen.queryByText('我自己写的')).toBeNull()
  })

  it('编辑批注:取消与未改动都不发 IPC', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    const card = document.querySelector('.note-card') as HTMLElement
    fireEvent.click(within(card).getByText('编辑'))
    fireEvent.click(screen.getByText('取消'))
    expect(invokeCommandMock).not.toHaveBeenCalledWith('reader.note.update', expect.anything())

    // 再进编辑态,原样保存 = 无谓写库,也不发。
    fireEvent.click(within(card).getByText('编辑'))
    fireEvent.click(screen.getByText('保存'))
    expect(invokeCommandMock).not.toHaveBeenCalledWith('reader.note.update', expect.anything())
  })

  it('色条按「书」分色,不是照搬批注自己的高亮色', async () => {
    await renderLibrary()
    fireEvent.click(sidebarButton(/^笔记/))
    await waitFor(() => expect(document.querySelectorAll('.note-card').length).toBe(3))

    const swatches = [...document.querySelectorAll<HTMLElement>('.note-swatch')].map(
      (node) => node.style.background,
    )
    // 同书两条同色(NOTES 里 n1/n2 都是 HASH_A),不同书不同色。
    expect(swatches[0]).toBe(swatches[1])
    expect(swatches[0]).not.toBe(swatches[2])
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
        name: /^笔记/,
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

describe('封面提取管线(B1.3 并发化)', () => {
  /** 手动 resolve 的 Promise:把「第一本还没回来」这个条件握在测试手里。 */
  function defer(): { promise: Promise<string>; resolve: (url: string) => void } {
    let resolve!: (url: string) => void
    const promise = new Promise<string>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it('多本书的封面提取并发发起:第一本悬而未决时,后续调用已经发出', async () => {
    // 第一本被门闩拦住;若实现退回逐本串行,第二本的调用永远等不到,本用例红。
    const gate = defer()
    const extractMock = vi.mocked(extractCover)
    extractMock.mockImplementationOnce(() => gate.promise)

    await renderLibrary(BOOKS)
    await waitFor(() => expect(extractMock.mock.calls.length).toBeGreaterThan(1))

    gate.resolve('blob:first-cover')
    await waitFor(() => {
      expect(document.querySelector('img[src="blob:first-cover"]')).not.toBeNull()
    })
  })

  it('封面 asset 失效时降级到字面封面,不露破图', async () => {
    vi.mocked(extractCover).mockResolvedValueOnce('blob:broken-cover')
    await renderLibrary(BOOKS)
    const img = await waitFor(() => {
      const el = document.querySelector('img[src="blob:broken-cover"]')
      expect(el).not.toBeNull()
      return el!
    })
    fireEvent.error(img)
    // 破图退场,首字字面封面顶上,背景同步切回确定性渐变。
    await waitFor(() => expect(document.querySelector('img[src="blob:broken-cover"]')).toBeNull())
    expect(document.querySelector('.book-cover-char')).not.toBeNull()
  })
})

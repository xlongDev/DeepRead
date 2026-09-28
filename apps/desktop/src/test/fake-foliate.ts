/**
 * ReaderScreen 渲染测试用的假内核。
 *
 * 真 adapter 要建 iframe、加载 foliate-js、读真实书文件 —— jsdom 里跑不动也不该跑。
 * 这里只保留 ReaderScreen 依赖的那层契约:方法名、参数、返回值形状,外加
 * 触发内核回调的入口(`emitRelocate` 等),让测试能模拟「内核报了位置变化」。
 *
 * 刻意不做成 `vi.mock` 内联工厂:多个测试文件要共享同一份,内联会各自漂移。
 */

import { vi } from 'vitest'
import type {
  Annotation,
  BookCharStats,
  BookMetadata,
  BookSource,
  ReaderLayout,
  ReaderTheme,
  ReadingLocation,
  SearchResult,
  TocItem,
} from '@deepread/reader-core'
import type {
  EngineCallbacks,
  EngineLocation,
  EngineSelection,
  TapZone,
} from '@deepread/reader-adapter'

export interface FakeFoliateOptions {
  readonly metadata?: Partial<BookMetadata>
  readonly toc?: readonly TocItem[]
  readonly sourceText?: string | null
  /** 按章正文,`getSectionText(i)` 读第 i 项;同时决定章节数。 */
  readonly sections?: readonly string[]
  readonly charStats?: BookCharStats | null
  readonly searchResults?: readonly SearchResult[]
  /** 设置后 `open()` 以该错误 reject,用于走错误分支。 */
  readonly openError?: Error | null
}

const DEFAULT_METADATA: BookMetadata = {
  title: '默认书名',
  authors: ['默认作者'],
}

const DEFAULT_SECTIONS = ['第一章正文。', '第二章正文。', '第三章正文。'] as const

export class FakeFoliateAdapter {
  /** 每次构造都 push:测「StrictMode 双挂载不泄漏第二个实例」用得上。 */
  static readonly instances: FakeFoliateAdapter[] = []

  /**
   * 下一次构造时采用的配置。
   *
   * 存在的理由:配置必须在挂载 effect 跑到 `open()` 之前就位,而组件挂载后
   * 才拿得到实例(`latestAdapter()`)。所以测试先设这里,再 render。
   */
  static nextOptions: FakeFoliateOptions = {}

  readonly host: HTMLElement
  readonly callbacks: EngineCallbacks
  options: FakeFoliateOptions

  readonly open = vi.fn<(source: BookSource) => Promise<void>>()
  readonly close = vi.fn<() => Promise<void>>()
  readonly destroy = vi.fn<() => Promise<void>>()
  readonly getMetadata = vi.fn<() => Promise<BookMetadata>>()
  readonly getTableOfContents = vi.fn<() => Promise<readonly TocItem[]>>()
  readonly getCurrentLocation = vi.fn<() => Promise<ReadingLocation>>()
  readonly getText = vi.fn<(range?: unknown) => Promise<string>>()
  readonly getSourceText = vi.fn<() => string | null>()
  readonly getSectionCount = vi.fn<() => Promise<number>>()
  readonly getSectionText = vi.fn<(index?: number) => Promise<string>>()
  readonly getBookCharStats = vi.fn<() => Promise<BookCharStats | null>>()
  readonly goTo = vi.fn<(location: ReadingLocation) => Promise<void>>()
  readonly goToSection = vi.fn<(index: number) => Promise<void>>()
  readonly nextPage = vi.fn<() => Promise<void>>()
  readonly previousPage = vi.fn<() => Promise<void>>()
  readonly search = vi.fn<(query: string) => Promise<readonly SearchResult[]>>()
  readonly setTheme = vi.fn<(theme: ReaderTheme) => Promise<void>>()
  readonly setLayout = vi.fn<(layout: ReaderLayout) => Promise<void>>()
  readonly setFontFaces = vi.fn<(css: string) => Promise<void>>()
  readonly createAnnotation = vi.fn<(annotation: Annotation) => Promise<void>>()
  readonly removeAnnotation = vi.fn<(annotationId: string) => Promise<void>>()
  readonly replaceSource = vi.fn<(text: string) => Promise<void>>()
  readonly rebuildChapters = vi.fn<(pattern: string | null) => Promise<number>>()

  constructor(host: HTMLElement, callbacks: EngineCallbacks = {}, options?: FakeFoliateOptions) {
    this.host = host
    this.callbacks = callbacks
    this.options = options ?? FakeFoliateAdapter.nextOptions
    FakeFoliateAdapter.instances.push(this)
    this.resetOptions(this.options)
  }

  /** 重新灌默认实现;测试中途换配置时调用。 */
  resetOptions(options: FakeFoliateOptions = this.options): void {
    this.options = options
    const sections = options.sections ?? DEFAULT_SECTIONS

    this.open.mockImplementation(async () => {
      if (options.openError) throw options.openError
    })
    this.close.mockResolvedValue(undefined)
    this.destroy.mockResolvedValue(undefined)
    this.getMetadata.mockResolvedValue({ ...DEFAULT_METADATA, ...options.metadata })
    this.getTableOfContents.mockResolvedValue(options.toc ?? [])
    this.getCurrentLocation.mockResolvedValue({ progress: 0 })
    this.getText.mockResolvedValue(sections.join('\n\n'))
    this.getSourceText.mockReturnValue(options.sourceText ?? null)
    this.getSectionCount.mockResolvedValue(sections.length)
    this.getSectionText.mockImplementation(async (index = 0) => sections[index] ?? '')
    this.getBookCharStats.mockResolvedValue(options.charStats ?? null)
    this.goTo.mockResolvedValue(undefined)
    this.goToSection.mockResolvedValue(undefined)
    this.nextPage.mockResolvedValue(undefined)
    this.previousPage.mockResolvedValue(undefined)
    this.search.mockResolvedValue(options.searchResults ?? [])
    this.setTheme.mockResolvedValue(undefined)
    this.setLayout.mockResolvedValue(undefined)
    this.setFontFaces.mockResolvedValue(undefined)
    this.createAnnotation.mockResolvedValue(undefined)
    this.removeAnnotation.mockResolvedValue(undefined)
    this.replaceSource.mockResolvedValue(undefined)
    this.rebuildChapters.mockResolvedValue(sections.length)
  }

  // ---- 内核 → UI 的入向事件(用于模拟阅读位置变化等) ----

  emitRelocate(location: EngineLocation): void {
    this.callbacks.onRelocate?.(location)
  }

  emitSelection(selection: EngineSelection | null): void {
    this.callbacks.onSelection?.(selection)
  }

  emitShowAnnotation(cfi: string): void {
    this.callbacks.onShowAnnotation?.(cfi)
  }

  emitTapZone(zone: TapZone): void {
    this.callbacks.onTapZone?.(zone)
  }

  emitKeyDown(event: KeyboardEvent): void {
    this.callbacks.onKeyDown?.(event)
  }
}

/** 最近一次构造的实例 —— 绝大多数测试只关心这个。 */
export function latestAdapter(): FakeFoliateAdapter {
  const adapter = FakeFoliateAdapter.instances.at(-1)
  if (!adapter) throw new Error('FakeFoliateAdapter 尚未被构造:ReaderScreen 可能没挂载成功')
  return adapter
}

export function resetFakeAdapters(): void {
  FakeFoliateAdapter.instances.length = 0
  FakeFoliateAdapter.nextOptions = {}
}

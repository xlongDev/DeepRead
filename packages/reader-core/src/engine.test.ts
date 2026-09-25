import { describe, expect, it } from 'vitest'
import type { ReaderEngine } from './engine'
import type { BookSource, ReaderLayout, ReaderTheme, ReadingLocation } from './types'

/**
 * Contract probe: proves the ReaderEngine interface is implementable as-is and
 * pins the minimum shapes the FoliateAdapter (Sprint 4) must satisfy.
 * This is a test fixture, not a production implementation.
 */
class ContractProbe implements ReaderEngine {
  private readonly locations: ReadingLocation[] = []

  open(source: BookSource): Promise<void> {
    if (!source.url) return Promise.reject(new Error('source URL is required'))
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  getMetadata() {
    return Promise.resolve({ title: 'probe', authors: [] })
  }

  getTableOfContents() {
    return Promise.resolve([])
  }

  getCurrentLocation() {
    const last = this.locations[this.locations.length - 1]
    return Promise.resolve(last ?? { progress: 0 })
  }

  goTo(location: ReadingLocation): Promise<void> {
    this.locations.push(location)
    return Promise.resolve()
  }

  nextPage(): Promise<void> {
    return Promise.resolve()
  }

  previousPage(): Promise<void> {
    return Promise.resolve()
  }

  search(query: string) {
    if (query === '') return Promise.resolve([])
    return Promise.resolve([{ location: { progress: 0 }, excerpt: query }])
  }

  getText() {
    return Promise.resolve('')
  }

  getBookCharStats() {
    return Promise.resolve(null)
  }

  createAnnotation(): Promise<void> {
    return Promise.resolve()
  }

  removeAnnotation(): Promise<void> {
    return Promise.resolve()
  }

  setTheme(theme: ReaderTheme): Promise<void> {
    if (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark') {
      return Promise.reject(new Error('invalid color scheme'))
    }
    return Promise.resolve()
  }

  setLayout(layout: ReaderLayout): Promise<void> {
    if (layout.margin !== undefined && layout.margin < 0) {
      return Promise.reject(new Error('margin must be non-negative'))
    }
    return Promise.resolve()
  }

  destroy(): Promise<void> {
    return Promise.resolve()
  }
}

describe('ReaderEngine contract', () => {
  it('can be implemented and driven through the interface alone', async () => {
    const engine: ReaderEngine = new ContractProbe()

    await engine.open({ bookId: 'b1', format: 'epub', url: 'app://books/b1.epub' })
    const metadata = await engine.getMetadata()
    expect(metadata.title).toBe('probe')

    await engine.goTo({ cfi: 'epubcfi(/6/4)', progress: 0.25 })
    expect(await engine.getCurrentLocation()).toEqual({ cfi: 'epubcfi(/6/4)', progress: 0.25 })

    expect(await engine.search('')).toEqual([])
    expect(await engine.search('query')).toEqual([{ location: { progress: 0 }, excerpt: 'query' }])

    await engine.setLayout({ flow: 'paginated', pageMode: 'dual', margin: 24 })
    await engine.setTheme({
      name: 'Dark',
      background: '#131210',
      foreground: '#ece9e3',
      colorScheme: 'dark',
    })
    await engine.close()
    await engine.destroy()
  })

  it('rejects an empty source URL', async () => {
    const engine: ReaderEngine = new ContractProbe()
    await expect(engine.open({ bookId: 'b1', format: 'epub', url: '' })).rejects.toThrow(
      'source URL is required',
    )
  })

  it('supports scroll and pagination flows in its layout contract', async () => {
    const engine: ReaderEngine = new ContractProbe()
    const layouts: ReaderLayout[] = [
      { flow: 'paginated', pageMode: 'single' },
      { flow: 'scrolled', pageMode: 'single' },
    ]
    for (const layout of layouts) {
      await expect(engine.setLayout(layout)).resolves.toBeUndefined()
    }
    await expect(
      engine.setLayout({ flow: 'paginated', pageMode: 'single', margin: -1 }),
    ).rejects.toThrow('margin must be non-negative')
  })
})

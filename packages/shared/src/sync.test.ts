import { describe, expect, it } from 'vitest'
import type { AnnotationRecord, ReaderStatePayload } from './protocol/commands'
import { mergeBookState, mergeLibrary } from './sync'

const HASH = 'a'.repeat(64)

function annotation(id: string, overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return { id, cfi: `epubcfi(${id})`, color: '#f5d76e', ...overrides }
}

function state(overrides: Partial<ReaderStatePayload> & { updatedAt: string }): ReaderStatePayload {
  return { progress: null, annotations: [], bookmarks: [], ...overrides }
}

describe('mergeBookState', () => {
  it('unions records that exist on only one side', () => {
    const local = state({ updatedAt: '2026-09-01T00:00:00Z', annotations: [annotation('a1')] })
    const remote = state({ updatedAt: '2026-09-01T00:00:00Z', annotations: [annotation('a2')] })
    const { state: merged, conflicts } = mergeBookState(HASH, local, remote)
    expect(merged.annotations.map((a) => a.id).sort()).toEqual(['a1', 'a2'])
    expect(conflicts).toEqual([])
  })

  it('newer record wins when both sides edited the same id', () => {
    const local = state({
      updatedAt: '2026-09-01T00:00:00Z',
      annotations: [annotation('a1', { note: '本地笔记', updatedAt: '2026-09-02T00:00:00Z' })],
    })
    const remote = state({
      updatedAt: '2026-09-01T00:00:00Z',
      annotations: [annotation('a1', { note: '云端笔记', updatedAt: '2026-09-03T00:00:00Z' })],
    })
    const { state: merged } = mergeBookState(HASH, local, remote)
    expect(merged.annotations).toHaveLength(1)
    expect(merged.annotations[0]!.note).toBe('云端笔记')
  })

  it('a newer tombstone suppresses the live remote record', () => {
    const local = state({
      updatedAt: '2026-09-01T00:00:00Z',
      annotations: [annotation('a1', { deleted: true, updatedAt: '2026-09-05T00:00:00Z' })],
    })
    const remote = state({ updatedAt: '2026-09-01T00:00:00Z', annotations: [annotation('a1')] })
    const { state: merged } = mergeBookState(HASH, local, remote)
    expect(merged.annotations).toHaveLength(1)
    expect(merged.annotations[0]!.deleted).toBe(true)
  })

  it('keeps both and reports a conflict on same-stamp different content', () => {
    const stamp = '2026-09-02T00:00:00Z'
    const local = state({
      updatedAt: stamp,
      annotations: [annotation('a1', { note: '本', updatedAt: stamp })],
    })
    const remote = state({
      updatedAt: stamp,
      annotations: [annotation('a1', { note: '云', updatedAt: stamp })],
    })
    const { state: merged, conflicts } = mergeBookState(HASH, local, remote)
    expect(merged.annotations.map((a) => a.id)).toEqual(['a1', 'a1:r'])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      entityType: 'annotation',
      entityId: 'a1',
      resolution: 'keep-both',
    })
  })

  it('progress takes the newer whole state (§131)', () => {
    const local = state({
      updatedAt: '2026-09-03T00:00:00Z',
      progress: { cfi: 'local-cfi', fraction: 0.4 },
    })
    const remote = state({
      updatedAt: '2026-09-02T00:00:00Z',
      progress: { cfi: 'remote-cfi', fraction: 0.8 },
    })
    const { state: merged, conflicts } = mergeBookState(HASH, local, remote)
    expect(merged.progress?.cfi).toBe('local-cfi')
    expect(conflicts).toEqual([])
  })

  it('newer remote progress still wins but is reported as a conflict', () => {
    const local = state({
      updatedAt: '2026-09-01T00:00:00Z',
      progress: { cfi: 'local-cfi', fraction: 0.4 },
    })
    const remote = state({
      updatedAt: '2026-09-09T00:00:00Z',
      progress: { cfi: 'remote-cfi', fraction: 0.8 },
    })
    const { state: merged, conflicts } = mergeBookState(HASH, local, remote)
    expect(merged.progress?.cfi).toBe('remote-cfi')
    expect(conflicts.map((c) => c.entityType)).toEqual(['progress'])
  })

  it('handles both sides empty', () => {
    const { state: merged, conflicts } = mergeBookState(HASH, null, null)
    expect(merged.progress).toBeNull()
    expect(conflicts).toEqual([])
  })
})

describe('mergeLibrary', () => {
  const book = (hash: string, overrides = {}) => ({
    hash,
    fileName: '书.epub',
    displayName: null,
    format: 'epub',
    path: '/books/book.epub',
    size: 1,
    addedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  })

  it('unions both sides', () => {
    const local = [book('a'.repeat(64))]
    const remote = [book('b'.repeat(64))]
    const { books, changed } = mergeLibrary(local, remote)
    expect(books).toHaveLength(2)
    expect(changed).toBe(true)
  })

  it('a real row beats a placeholder with the same hash', () => {
    const hash = 'c'.repeat(64)
    const local = [book(hash, { path: '', fileName: hash })]
    const remote = [book(hash)]
    const { books, changed } = mergeLibrary(local, remote)
    expect(books[0]!.path).toBe('/books/book.epub')
    expect(changed).toBe(true)
  })

  it('identical libraries report no change', () => {
    const books = [book('d'.repeat(64))]
    const { changed } = mergeLibrary(books, books)
    expect(changed).toBe(false)
  })
})

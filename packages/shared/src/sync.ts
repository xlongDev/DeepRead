/**
 * Sync merge engine (spec §50-§52, §131).
 *
 * Pure functions: no IPC, no storage, no kernel. Callers schema-validate the
 * untrusted remote documents first (WebDAV data is on the §133 untrusted
 * list); these functions only decide what survives a merge.
 *
 * Strategy per data type (§51):
 * - progress    → latest valid state (whole-record LWW on the state timestamp)
 * - annotations → record merge (union by id, per-record LWW, tombstones)
 * - bookmarks   → record merge (same)
 * - metadata    → field merge (union of books, real rows beat placeholders)
 * Same-record edits that collide at the same timestamp cannot be resolved
 * automatically (§52) → keep both and surface a SyncConflict for the user.
 */

import type { LibraryBook, ReaderStatePayload } from './protocol/commands'

export type SyncEntityType = 'annotation' | 'bookmark' | 'progress'

/** Mirrors spec §5.16 (versions carried as merge timestamps). */
export interface SyncConflict {
  readonly id: string
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly bookHash: string
  readonly localVersion: string
  readonly remoteVersion: string
  readonly resolution: 'keep-both'
  readonly createdAt: string
}

const EPOCH = '1970-01-01T00:00:00.000Z'

function stampOf(record: SyncRecord): string {
  return record.updatedAt ?? record.createdAt ?? EPOCH
}

function sameRecord<T extends object>(local: T, remote: T): boolean {
  return JSON.stringify(local) === JSON.stringify(remote)
}

interface SyncRecord {
  readonly id: string
  readonly deleted?: boolean
  readonly updatedAt?: string
  readonly createdAt?: string
}

function newerWins<T extends SyncRecord>(local: T, remote: T): T {
  return stampOf(remote) > stampOf(local) ? remote : local
}

/**
 * Merge two record lists by id (union + per-record LWW). A tombstone with a
 * newer stamp than a live record suppresses it; a same-stamp content
 * collision keeps both records and reports a conflict (§52).
 */
function mergeRecords<T extends SyncRecord>(
  local: readonly T[],
  remote: readonly T[],
  entityType: SyncEntityType,
  bookHash: string,
  conflicts: SyncConflict[],
): T[] {
  const remoteById = new Map(remote.map((record) => [record.id, record]))
  const merged: T[] = []
  const seen = new Set<string>()
  for (const localRecord of local) {
    seen.add(localRecord.id)
    const remoteRecord = remoteById.get(localRecord.id)
    if (remoteRecord === undefined) {
      merged.push(localRecord)
      continue
    }
    if (sameRecord(localRecord, remoteRecord)) {
      merged.push(localRecord)
      continue
    }
    if (stampOf(localRecord) === stampOf(remoteRecord)) {
      // Same timestamp, different content — not auto-resolvable (§52).
      merged.push(localRecord, { ...remoteRecord, id: `${remoteRecord.id}:r` })
      conflicts.push({
        id: `${bookHash}:${entityType}:${localRecord.id}`,
        entityType,
        entityId: localRecord.id,
        bookHash,
        localVersion: stampOf(localRecord),
        remoteVersion: stampOf(remoteRecord),
        resolution: 'keep-both',
        createdAt: new Date().toISOString(),
      })
      continue
    }
    merged.push(newerWins(localRecord, remoteRecord))
  }
  for (const remoteRecord of remote) {
    if (!seen.has(remoteRecord.id)) merged.push(remoteRecord)
  }
  return merged
}

/** Per-book state merge (§51). Output is a fresh payload ready to persist. */
export function mergeBookState(
  bookHash: string,
  local: ReaderStatePayload | null,
  remote: ReaderStatePayload | null,
): { state: ReaderStatePayload; conflicts: SyncConflict[] } {
  const conflicts: SyncConflict[] = []
  const annotations = mergeRecords(
    local?.annotations ?? [],
    remote?.annotations ?? [],
    'annotation',
    bookHash,
    conflicts,
  )
  const bookmarks = mergeRecords(
    local?.bookmarks ?? [],
    remote?.bookmarks ?? [],
    'bookmark',
    bookHash,
    conflicts,
  )

  // Progress: whole-record LWW on each side's state timestamp (§131).
  const localStamp = local?.updatedAt ?? EPOCH
  const remoteStamp = remote?.updatedAt ?? EPOCH
  let progress = local?.progress ?? remote?.progress ?? null
  if (local?.progress && remote?.progress && remoteStamp > localStamp) {
    progress = remote.progress
  }
  if (
    local?.progress &&
    remote?.progress &&
    remoteStamp > localStamp &&
    remote.progress.cfi !== local.progress.cfi
  ) {
    conflicts.push({
      id: `${bookHash}:progress`,
      entityType: 'progress',
      entityId: 'progress',
      bookHash,
      localVersion: localStamp,
      remoteVersion: remoteStamp,
      resolution: 'keep-both',
      createdAt: new Date().toISOString(),
    })
  }

  return {
    state: {
      progress,
      annotations,
      bookmarks,
      updatedAt: new Date().toISOString(),
    },
    conflicts,
  }
}

/**
 * Library field merge (§51): union by hash. A real row beats a placeholder
 * (empty path/placeholder name seeded by state imports); otherwise the
 * earlier `addedAt` wins for stability.
 */
export function mergeLibrary(
  local: readonly LibraryBook[],
  remote: readonly LibraryBook[],
): { books: LibraryBook[]; changed: boolean } {
  const byHash = new Map<string, LibraryBook>()
  for (const book of remote) byHash.set(book.hash, book)
  for (const book of local) {
    const remoteBook = byHash.get(book.hash)
    if (remoteBook === undefined) {
      byHash.set(book.hash, book)
      continue
    }
    const winner = preferBook(book, remoteBook)
    // Tags union instead of winner-takes-all: a device that never tagged the
    // book must not drop collections added elsewhere.
    byHash.set(book.hash, { ...winner, tags: unionTags(book, remoteBook) })
  }
  const books = [...byHash.values()]
  return {
    books,
    changed:
      books.length !== local.length ||
      local.some((book) => !sameRecord(book, byHash.get(book.hash)!)),
  }
}

function preferBook(a: LibraryBook, b: LibraryBook): LibraryBook {
  const aPlaceholder = a.path === '' || a.fileName === a.hash
  const bPlaceholder = b.path === '' || b.fileName === b.hash
  if (aPlaceholder !== bPlaceholder) return aPlaceholder ? b : a
  // A resolved title beats an unresolved one: titles are resolved lazily, so
  // the record that has not been opened yet may also be the newer one.
  if (a.displayName !== null && b.displayName === null) return a
  if (b.displayName !== null && a.displayName === null) return b
  return a.addedAt <= b.addedAt ? a : b
}

function unionTags(a: LibraryBook, b: LibraryBook): readonly string[] {
  return [...new Set([...a.tags, ...b.tags])]
}

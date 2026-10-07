/**
 * Sync orchestration (spec §50): Local First → Sync Queue → Sync Engine →
 * Cloud Provider.
 *
 * The engine pulls raw remote documents through the WebDAV transport,
 * schema-validates everything it pulled (WebDAV data is on the §133
 * untrusted list), merges with `@deepread/shared/sync`, then pushes what
 * changed and persists what came back. One pass, no background queue yet —
 * failures surface as errors and the next run retries (ponytail ceiling:
 * a persistent retry queue lands with real background tasks).
 */

import { z } from 'zod'
import {
  libraryBookSchema,
  mergeBookState,
  mergeLibrary,
  readerStatePayloadSchema,
  toAppError,
  type LibraryBook,
  type ReaderStatePayload,
  type SyncConflict,
} from '@deepread/shared'
import { invokeCommand } from './ipc'

const DEVICES_PATH = 'devices.json'
const LIBRARY_PATH = 'library.json'
const statePath = (hash: string): string => `state/${hash}.json`

const devicesSchema = z.object({
  devices: z
    .array(
      z.object({
        id: z.string().min(4).max(64),
        name: z.string().min(1).max(128),
        lastSeen: z.string().min(1).max(64),
      }),
    )
    .max(100),
})

const libraryFileSchema = z.object({
  exportedAt: z.string(),
  books: z.array(libraryBookSchema).max(10_000),
})

export interface SyncReport {
  readonly pushed: number
  readonly pulled: number
  readonly bookCount: number
  readonly conflicts: readonly SyncConflict[]
  readonly syncedAt: string
}

/** Document shape the merge compares — excludes the merge timestamp itself. */
function contentOf(state: ReaderStatePayload | null): string {
  if (!state) return ''
  return JSON.stringify({
    progress: state.progress,
    annotations: state.annotations,
    bookmarks: state.bookmarks,
  })
}

async function getJson<T>(
  path: string,
  schema: { readonly parse: (value: unknown) => T },
): Promise<T | null> {
  const response = await invokeCommand('cloud.webdav.get', { path })
  if (response.body === null) return null
  try {
    return schema.parse(JSON.parse(response.body))
  } catch (error) {
    throw toAppError(error)
  }
}

async function putJson(path: string, value: unknown): Promise<void> {
  await invokeCommand('cloud.webdav.put', { path, body: JSON.stringify(value) })
}

export async function runSync(): Promise<SyncReport> {
  const pushed = { count: 0 }
  const pulled = { count: 0 }
  const conflicts: SyncConflict[] = []
  const now = new Date().toISOString()

  // 1. Device registry: refresh this device's presence (Sprint 13: Device).
  const config = await invokeCommand('cloud.config.get', undefined)
  const remoteDevices = (await getJson(
    DEVICES_PATH,
    devicesSchema as z.ZodType<{ devices: { id: string; name: string; lastSeen: string }[] }>,
  )) ?? {
    devices: [],
  }
  const devices = {
    devices: [
      ...remoteDevices.devices.filter((device) => device.id !== config.deviceId),
      { id: config.deviceId, name: config.deviceName, lastSeen: now },
    ],
  }
  await putJson(DEVICES_PATH, devices)
  pushed.count += 1

  // 2. Library field merge (§51 metadata).
  const localLibrary = await invokeCommand('library.list', undefined)
  const remoteLibrary = await getJson(LIBRARY_PATH, libraryFileSchema)
  const { books, changed } = mergeLibrary(localLibrary.books, remoteLibrary?.books ?? [])
  if (changed || remoteLibrary === null) {
    await putJson(LIBRARY_PATH, { exportedAt: now, books })
    pushed.count += 1
  }
  pulled.count += (remoteLibrary?.books ?? []).filter(
    (book) => !localLibrary.books.some((local) => local.hash === book.hash),
  ).length

  // 3. Per-book reading state merge (§51 annotations/bookmarks/progress).
  // 一次 getAll 取全部本地状态(B3):N 本书从 N 次 state IPC 往返降到 1 次;
  // WebDAV 侧保持逐书 —— 单请求过大会撞传输上限。
  const allStates = (await invokeCommand('reader.state.getAll', undefined)).states
  for (const book of localLibrary.books as readonly LibraryBook[]) {
    const localState = allStates[book.hash] ?? null
    const remoteState = await getJson(statePath(book.hash), readerStatePayloadSchema)
    if (localState === null && remoteState === null) continue
    const { state: merged, conflicts: bookConflicts } = mergeBookState(
      book.hash,
      localState,
      remoteState,
    )
    conflicts.push(...bookConflicts)
    if (contentOf(merged) !== contentOf(localState)) {
      await invokeCommand('reader.state.set', { bookHash: book.hash, state: merged })
      pulled.count += 1
    }
    if (contentOf(merged) !== contentOf(remoteState)) {
      await putJson(statePath(book.hash), merged)
      pushed.count += 1
    }
  }

  return {
    pushed: pushed.count,
    pulled: pulled.count,
    bookCount: localLibrary.books.length,
    conflicts,
    syncedAt: now,
  }
}

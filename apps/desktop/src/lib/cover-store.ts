/**
 * Cover cache — one API, two backends.
 *
 * Desktop: the extracted cover is written next to the database by Rust, so a
 * second shelf paint is a file read instead of another zip parse / PDF render.
 * Browser (dev mode, no IPC): the same bytes go to IndexedDB.
 */

import { invokeCommand, isTauriRuntime } from './ipc'
import { convertFileSrc } from './book-import'

const DB_NAME = 'deepread-covers'
const STORE_NAME = 'covers'
const DB_VERSION = 1

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openStore().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const request = run(tx.objectStore(STORE_NAME))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
        tx.oncomplete = () => db.close()
      }),
  )
}

/** Cached cover as a usable image URL, or null when it still has to be extracted. */
export async function readCachedCover(hash: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const response = await invokeCommand('library.cover.get', { bookHash: hash })
    return response.path === null || response.path === undefined
      ? null
      : convertFileSrc(response.path)
  }
  const blob = await idbTransaction<Blob | undefined>('readonly', (store) => store.get(hash))
  return blob ? URL.createObjectURL(blob) : null
}

/** Persist a freshly extracted cover (input is the object URL from extractCover). */
export async function writeCachedCover(hash: string, objectUrl: string): Promise<void> {
  const blob = await fetch(objectUrl).then((response) => response.blob())
  if (isTauriRuntime()) {
    await invokeCommand('library.cover.put', { bookHash: hash, data: await toBase64(blob) })
    return
  }
  await idbTransaction('readwrite', (store) => store.put(blob, hash))
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      // Strip the "data:<type>;base64," prefix — Rust wants raw base64.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

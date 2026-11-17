import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  buildIndex,
  inflateGzip,
  lookupWord,
  type DefinitionField,
  type EngineSelection,
} from '@deepread/reader-adapter'
import { toAppError, type DictionaryMeta } from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { anchorFromRect, placeCompanionCard, windowFrame } from './selection-place'
import type { LookupResult } from './LookupCard'

const LOOKUP_CARD_HEIGHT = 280

/**
 * 词典查询域:词典列表(导入/移除/按 id 缓存)与划词查询收进一个 hook。
 * 查询逐本词典走,一本读不出来不拖累其余;卡位与翻译卡同一套避让算式。
 */
export function useLookup(
  selection: EngineSelection | null,
  hostRef: RefObject<HTMLDivElement | null>,
  onProblem: (message: string | null) => void,
) {
  const [dictionaries, setDictionaries] = useState<readonly DictionaryMeta[]>([])
  const [lookup, setLookup] = useState<{
    word: string
    rect: { top: number; left: number }
    results: readonly LookupResult[]
  } | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const dictCacheRef = useRef(
    new Map<string, { entries: ReturnType<typeof buildIndex>; dict: Uint8Array }>(),
  )

  useEffect(() => {
    if (!isTauriRuntime()) return
    invokeCommand('dictionary.list', undefined)
      .then((response) => setDictionaries(response.dictionaries))
      .catch(() => {
        // Lookup is optional; the panel's import button retries the list.
      })
  }, [])

  const isGzip = (data: Uint8Array): boolean => data[0] === 0x1f && data[1] === 0x8b

  const fetchBuffer = async (path: string): Promise<Uint8Array> => {
    const response = await fetch(convertFileSrc(path))
    if (!response.ok) throw new Error(`无法读取 ${path}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  const loadDictionary = async (
    meta: DictionaryMeta,
  ): Promise<{ entries: ReturnType<typeof buildIndex>; dict: Uint8Array }> => {
    const cached = dictCacheRef.current.get(meta.id)
    if (cached) return cached
    let idx = await fetchBuffer(meta.idxPath)
    let dict = await fetchBuffer(meta.dictPath)
    if (isGzip(idx)) idx = await inflateGzip(idx)
    if (isGzip(dict)) dict = await inflateGzip(dict)
    const loaded = { entries: buildIndex(idx), dict }
    dictCacheRef.current.set(meta.id, loaded)
    return loaded
  }

  const importDictionary = useCallback(async (): Promise<void> => {
    const path = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'StarDict 词典', extensions: ['ifo'] }],
    })
    if (!path) return
    try {
      await invokeCommand('dictionary.register', { path })
      const response = await invokeCommand('dictionary.list', undefined)
      setDictionaries(response.dictionaries)
      onProblem(null)
    } catch (registerError) {
      onProblem(toAppError(registerError).message ?? null)
    }
  }, [onProblem])

  const removeDictionary = useCallback(
    async (id: string): Promise<void> => {
      try {
        await invokeCommand('dictionary.remove', { id })
        setDictionaries((current) => current.filter((d) => d.id !== id))
        dictCacheRef.current.delete(id)
        onProblem(null)
      } catch (removeError) {
        onProblem(toAppError(removeError).message ?? null)
      }
    },
    [onProblem],
  )

  const runLookup = async (): Promise<void> => {
    if (!selection) return
    const word = selection.text
      .trim()
      .replace(/^[^\w\u4e00-\u9fff]+|[^\w\u4e00-\u9fff]+$/g, '')
      .slice(0, 40)
    // 词典卡与翻译卡同套避让(工具条现在不关),选区也留给后续动作。
    const frame =
      hostRef.current?.getBoundingClientRect() ?? windowFrame(window.innerWidth, window.innerHeight)
    const rect = {
      top: placeCompanionCard(frame, anchorFromRect(selection.rect), LOOKUP_CARD_HEIGHT).top,
      left: selection.rect.left,
    }
    if (!word) return
    setLookupLoading(true)
    setLookup({ word, rect, results: [] })
    const results: { dictName: string; word: string; fields: readonly DefinitionField[] }[] = []
    for (const meta of dictionaries) {
      try {
        const loaded = await loadDictionary(meta)
        for (const result of lookupWord(
          loaded.entries,
          loaded.dict,
          word,
          meta.sametypesequence ?? undefined,
        )) {
          results.push({ dictName: meta.name, ...result })
        }
      } catch {
        // One unreadable dictionary must not break lookup for the rest.
      }
    }
    setLookup({ word, rect, results })
    setLookupLoading(false)
  }

  /** 关掉词典卡(× 按钮)。查询在飞时只摘卡,结果到了也不再有卡片可落。 */
  const closeLookup = useCallback((): void => {
    setLookup(null)
  }, [])

  return {
    dictionaries,
    lookup,
    lookupLoading,
    importDictionary,
    removeDictionary,
    runLookup,
    closeLookup,
  }
}

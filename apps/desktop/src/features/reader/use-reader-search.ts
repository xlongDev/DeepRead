import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ReaderEngine } from '@deepread/reader-core'
import { MAX_SHOWN_SEARCH_RESULTS } from './SearchPanel'

/**
 * 全书搜索域:状态机(结果/进度/中止/大小写)与内核调用收进一个 hook,
 * ReaderScreen 只留接线(选中文本进搜索、面板 props)。
 */
export function useReaderSearch(
  engineRef: RefObject<ReaderEngine | null>,
  inputRef: RefObject<HTMLInputElement | null>,
) {
  const [searchResults, setSearchResults] = useState<readonly { cfi: string; excerpt: string }[]>(
    [],
  )
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle')
  /** 命中数超过展示上限:必须说清楚,否则用户以为搜索不全。 */
  const [searchTruncated, setSearchTruncated] = useState(false)
  /** 全书搜索进度(0-100 整数;内核逐节产出,null = 没在搜)。PDF 逐页搜,
   *  一本几百页的书要好几秒 —— 没有进度就是「搜索中」卡死观感。 */
  const [searchProgress, setSearchProgress] = useState<number | null>(null)
  /** 全书搜索是否区分大小写(默认不敏感,中文场景大多如此)。 */
  const [searchMatchCase, setSearchMatchCase] = useState(false)
  /** 在飞的搜索控制器:再次搜索或关书时中止上一轮,旧结果不该晚到覆盖新状态。 */
  const searchAbortRef = useRef<AbortController | null>(null)

  /** 中止在飞的搜索(关书时调,内核生成器跟着 return,不留后台循环空转)。 */
  const abortSearch = useCallback((): void => {
    searchAbortRef.current?.abort()
  }, [])

  /**
   * 全书搜索的公共路径:侧栏搜索框回车/按钮与「搜书中选中文本」都走这里。
   * 中止上一轮再开新的 —— 两轮并飞时旧结果晚到会覆盖新状态;中止后返回的
   * 是部分结果,照常上屏(停在半路的命中依然是命中)。
   */
  const runSearchWith = useCallback(
    async (query: string): Promise<void> => {
      const adapter = engineRef.current
      if (!adapter || query === '') return
      searchAbortRef.current?.abort()
      const controller = new AbortController()
      searchAbortRef.current = controller
      setSearchState('searching')
      setSearchProgress(0)
      try {
        let lastPercent = -1
        const results = await adapter.search(query, {
          matchCase: searchMatchCase,
          signal: controller.signal,
          onProgress: (fraction) => {
            // 按整数百分点去重:逐节 setState 在几千节的书上是白花渲染。
            const percent = Math.min(100, Math.round(fraction * 100))
            if (percent !== lastPercent) {
              lastPercent = percent
              setSearchProgress(percent)
            }
          },
        })
        setSearchTruncated(results.length > MAX_SHOWN_SEARCH_RESULTS)
        setSearchResults(
          results
            .slice(0, MAX_SHOWN_SEARCH_RESULTS)
            .map((r) => ({ cfi: r.location.cfi ?? '', excerpt: r.excerpt })),
        )
        setSearchState('done')
        // 命中处上屏:淡蓝高亮标出每一条,翻页跟随、关面板保留(fixed-layout
        // 走 Custom Highlight,见适配器);新搜索时由 showSearchHits 先摘旧的。
        // PDF 是 fixed-layout,内核渲染器没有 overlayer(上游 TODO),命中只出
        // 列表与跳页、不画高亮 —— addAnnotation 解析不到 overlayer 静默跳过。
        void adapter
          .showSearchHits?.(results.map((r) => r.location.cfi ?? '').filter(Boolean))
          .catch(() => {})
      } catch {
        // 内核搜索失败要有明确终态 —— 否则 searchState 永远停在「搜索中」。
        setSearchState('error')
      } finally {
        setSearchProgress(null)
        if (searchAbortRef.current === controller) searchAbortRef.current = null
      }
    },
    [engineRef, searchMatchCase],
  )

  const runSearch = useCallback((): Promise<void> => {
    const query = inputRef.current?.value.trim() ?? ''
    return runSearchWith(query)
  }, [inputRef, runSearchWith])

  return {
    searchResults,
    searchState,
    searchTruncated,
    searchProgress,
    searchMatchCase,
    setSearchMatchCase,
    runSearch,
    runSearchWith,
    abortSearch,
  }
}

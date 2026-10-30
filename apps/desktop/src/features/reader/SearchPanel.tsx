/**
 * 全书搜索面板:搜索框、区分大小写、进度/停止与命中列表。从 TocPanel 拆出
 * 的展示件(2026-10-31:搜索不再寄居目录面板,顶栏独立入口)—— 发起
 * (adapter)、进度与中止、命中高亮都在宿主;面板只消费状态。
 */

import { useEffect } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'

/** 命中数超过展示上限:必须说清楚,否则用户以为搜索不全。 */
export const MAX_SHOWN_SEARCH_RESULTS = 50

export interface TocSearchResult {
  readonly cfi: string
  readonly excerpt: string
}

interface SearchPanelProps {
  // 搜索:状态在宿主(书内搜索「在本书中搜索选中文本」也会写它),输入框
  // ref 共享 —— 宿主要往里填查询词。
  readonly searchState: 'idle' | 'searching' | 'done' | 'error'
  /** 搜索进度 0-100(整书逐节产出;null = 还没有进度数据)。 */
  readonly searchProgress: number | null
  /** 中止在飞的搜索(宿主 abort 后返回部分结果,走正常 done 路径上屏)。 */
  readonly onCancelSearch: () => void
  readonly searchMatchCase: boolean
  readonly onSearchMatchCaseChange: (matchCase: boolean) => void
  readonly searchResults: readonly TocSearchResult[]
  readonly searchTruncated: boolean
  readonly onSearch: () => void
  readonly searchInputRef: React.RefObject<HTMLInputElement | null>
  readonly onGoToCfi: (cfi: string) => void
  readonly onClose: () => void
}

export function SearchPanel({
  searchState,
  searchProgress,
  onCancelSearch,
  searchMatchCase,
  onSearchMatchCaseChange,
  searchResults,
  searchTruncated,
  onSearch,
  searchInputRef,
  onGoToCfi,
  onClose,
}: SearchPanelProps) {
  // 开面板即输入:挂载聚焦;带上次查询则全选,直接打字就能换词。
  useEffect(() => {
    const input = searchInputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [searchInputRef])

  return (
    <nav className="reader-toc" aria-label="搜索">
      <div className="reader-toc-head">
        <span>搜索</span>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={16} weight="regular" aria-hidden />
        </button>
      </div>

      <div className="reader-search">
        <input
          ref={searchInputRef}
          type="search"
          className="reader-search-input"
          placeholder="搜索全书…"
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearch()
          }}
        />
        <button type="button" className="chrome-button" onClick={onSearch} title="搜索">
          <MagnifyingGlass size={16} weight="regular" aria-hidden />
        </button>
      </div>
      <label className="reader-search-option">
        <input
          type="checkbox"
          checked={searchMatchCase}
          onChange={(event) => onSearchMatchCaseChange(event.target.checked)}
        />
        区分大小写
      </label>
      {searchState === 'searching' && (
        <div className="reader-toc-empty reader-search-status">
          <output>搜索中{searchProgress !== null ? ` ${searchProgress}%` : '…'}</output>
          <button type="button" className="chrome-button" onClick={onCancelSearch}>
            停止
          </button>
        </div>
      )}
      {searchState === 'error' && (
        <p className="reader-toc-empty" role="alert">
          搜索失败,请重试。
        </p>
      )}
      {searchState === 'done' && searchResults.length === 0 && (
        <p className="reader-toc-empty">没有找到匹配的正文。</p>
      )}
      {searchResults.map((result) => (
        <button
          key={result.cfi}
          type="button"
          className="toc-item search-result"
          onClick={() => onGoToCfi(result.cfi)}
          title="跳转到此处"
        >
          {result.excerpt}
        </button>
      ))}
      {searchTruncated && (
        <p className="reader-toc-empty">仅显示前 {MAX_SHOWN_SEARCH_RESULTS} 条,请细化关键词。</p>
      )}
      {searchState === 'idle' && searchResults.length === 0 && (
        <p className="reader-toc-empty">输入关键词,搜索整本书的正文。</p>
      )}
    </nav>
  )
}

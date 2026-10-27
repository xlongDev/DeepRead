/**
 * 词典查询浮层卡:从 ReaderScreen 拆出的纯展示件 —— 词条、多词典释义
 * (HTML 字段经 sanitizeDefinitionHtml 消毒)与查询中/无词条两态。
 * 查询的发起与缓存仍归宿主;定位约定同翻译卡(落点已算好,这里只兜底)。
 */

import { X } from '@phosphor-icons/react'
import { sanitizeDefinitionHtml, type DefinitionField } from '@deepread/reader-adapter'

export interface LookupResult {
  readonly dictName: string
  readonly word: string
  readonly fields: readonly DefinitionField[]
}

interface LookupCardProps {
  /** null = 还没有结果(配合 loading 显示「查询中…」)。 */
  readonly word: string | null
  /** 落点:查询词的 rect;还没有结果时回退到划选区的 rect(宿主解析)。 */
  readonly rect: { readonly top: number; readonly left: number } | null
  readonly loading: boolean
  readonly results: readonly LookupResult[]
  readonly onClose: () => void
}

export function LookupCard({ word, rect, loading, results, onClose }: LookupCardProps) {
  return (
    <div
      className="lookup-card"
      style={{
        top: Math.min(Math.max(64, rect?.top ?? 100), window.innerHeight - 260),
        left: Math.max(12, Math.min(rect?.left ?? 100, window.innerWidth - 320)),
      }}
    >
      <div className="lookup-head">
        <strong>{word ?? '查询中…'}</strong>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={12} weight="regular" aria-hidden />
        </button>
      </div>
      {loading && <p className="lookup-empty">查询中…</p>}
      {word !== null && results.length === 0 && !loading && (
        <p className="lookup-empty">词典中没有这个词条。</p>
      )}
      {results.map((result, index) => (
        <div key={`${result.dictName}-${index}`} className="lookup-entry">
          <p className="lookup-dict">{result.dictName}</p>
          {result.fields.map((field, fieldIndex) =>
            field.type === 'html' ? (
              <div
                key={fieldIndex}
                className="lookup-def"
                dangerouslySetInnerHTML={{
                  __html: sanitizeDefinitionHtml(field.content, new DOMParser()),
                }}
              />
            ) : (
              <div key={fieldIndex} className="lookup-def">
                {field.content}
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  )
}

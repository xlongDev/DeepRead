/**
 * 目录面板:目录树、书签、TXT 修整与章节规则,以及批注页签(本章/全书
 * 过滤 + 就地笔记)。从 ReaderScreen 拆出的展示件 —— 跳转、批注的增删与
 * 笔记落库都在宿主;页签与「本章/全书」过滤是面板私有状态。
 * (全书搜索已独立成 SearchPanel + 顶栏入口,2026-10-31。)
 */

import { useState } from 'react'
import { PencilSimple, Trash, X } from '@phosphor-icons/react'
import type { TocItem } from '@deepread/reader-core'
import type { AnnotationRecord, BookmarkRecord } from '@deepread/shared'
import type { ChapterRule, ChapterRuleCandidate } from '@deepread/ai-core'
import { ChapterRulesPanel } from './ChapterRulesPanel'
import { NoteEditor, type NoteDraft } from './NoteEditor'

export interface TocSearchResult {
  readonly cfi: string
  readonly excerpt: string
}

/** 写笔记入口的入参形状(与宿主 startNote 对齐)。 */
export interface StartNoteSource {
  readonly id?: string
  readonly cfi: string
  readonly excerpt?: string | null
  readonly color: string
  readonly style?: NoteDraft['style']
  readonly note?: string | null
}

interface TocPanelProps {
  readonly toc: readonly TocItem[]
  readonly isTxt: boolean
  readonly onClose: () => void
  readonly onGoToCfi: (cfi: string) => void
  readonly onGoToTocItem: (item: TocItem) => void
  // TXT 修整 / 章节规则(rebuildOpen 在宿主:展开时要读内核取样例行)。
  readonly onStartRepair: () => void
  readonly rebuildOpen: boolean
  readonly onToggleRebuildPanel: () => void
  readonly chapterSampleLines: readonly string[]
  readonly chapterInferCandidates: (() => Promise<readonly ChapterRuleCandidate[]>) | null
  readonly onApplyChapterRules: (rules: readonly ChapterRule[]) => Promise<void>
  readonly legacyChapterPattern: string
  // 书签
  readonly bookmarks: readonly BookmarkRecord[]
  readonly onRemoveBookmark: (id: string) => void
  // 批注
  readonly annotations: readonly AnnotationRecord[]
  /** 当前章的 CFI 章节键(「本章」过滤用);解析不出时「本章」按全书给。 */
  readonly currentChapter: string | null
  /** CFI → 章节键(与宿主的书签点亮同一条算法)。 */
  readonly cfiChapter: (cfi: string) => string | null
  readonly noteDraft: NoteDraft | null
  readonly onNoteDraftChange: (draft: NoteDraft | null) => void
  readonly onCommitNote: () => void
  readonly onStartNote: (source: StartNoteSource) => void
  readonly onRemoveAnnotation: (id: string) => void
}

export function TocPanel({
  toc,
  isTxt,
  onClose,
  onGoToCfi,
  onGoToTocItem,
  onStartRepair,
  rebuildOpen,
  onToggleRebuildPanel,
  chapterSampleLines,
  chapterInferCandidates,
  onApplyChapterRules,
  legacyChapterPattern,
  bookmarks,
  onRemoveBookmark,
  annotations,
  currentChapter,
  cfiChapter,
  noteDraft,
  onNoteDraftChange,
  onCommitNote,
  onStartNote,
  onRemoveAnnotation,
}: TocPanelProps) {
  const [tocTab, setTocTab] = useState<'toc' | 'annotations'>('toc')
  const [annotationScope, setAnnotationScope] = useState<'chapter' | 'book'>('book')
  const liveAnnotations = annotations.filter((record) => !record.deleted)
  const liveBookmarks = bookmarks.filter((bookmark) => !bookmark.deleted)
  /** 「本章」= 当前页 CFI 所在的那一节;解析不出就按全书给,好过给个错的。 */
  const shownAnnotations =
    annotationScope === 'chapter' && currentChapter !== null
      ? liveAnnotations.filter((record) => cfiChapter(record.cfi) === currentChapter)
      : liveAnnotations

  const renderTocItems = (items: readonly TocItem[], level: number): React.ReactNode =>
    items.map((item) => (
      <div key={item.id}>
        <button
          type="button"
          className="toc-item"
          style={{ paddingLeft: 12 + level * 16 }}
          onClick={() => onGoToTocItem(item)}
        >
          {item.title}
        </button>
        {item.children.length > 0 && <div>{renderTocItems(item.children, level + 1)}</div>}
      </div>
    ))

  return (
    <nav className="reader-toc" aria-label="目录">
      <div className="reader-toc-head">
        <div className="reader-toc-tabs">
          <button
            type="button"
            className={tocTab === 'toc' ? 'is-active' : ''}
            onClick={() => setTocTab('toc')}
            aria-pressed={tocTab === 'toc'}
          >
            目录
          </button>
          <button
            type="button"
            className={tocTab === 'annotations' ? 'is-active' : ''}
            onClick={() => setTocTab('annotations')}
            aria-pressed={tocTab === 'annotations'}
          >
            批注{liveAnnotations.length > 0 ? ` ${liveAnnotations.length}` : ''}
          </button>
        </div>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={16} weight="regular" aria-hidden />
        </button>
      </div>

      {tocTab === 'toc' ? (
        <>
          {isTxt && (
            <>
              <div className="settings-row repair-row">
                <span className="settings-label">文本修整</span>
                <div className="segmented">
                  <button type="button" onClick={onStartRepair}>
                    检查
                  </button>
                </div>
              </div>
              <div className="settings-row repair-row">
                <span className="settings-label">章节规则</span>
                <div className="segmented">
                  <button type="button" onClick={onToggleRebuildPanel}>
                    {rebuildOpen ? '收起' : '自定义'}
                  </button>
                </div>
              </div>
              {rebuildOpen && (
                <ChapterRulesPanel
                  sampleLines={chapterSampleLines}
                  onInferCandidates={chapterInferCandidates}
                  onApply={onApplyChapterRules}
                  legacyPattern={legacyChapterPattern}
                />
              )}
            </>
          )}

          {liveBookmarks.length > 0 && <p className="reader-section-label">书签</p>}
          {liveBookmarks.map((bookmark) => (
            <div key={bookmark.id} className="bookmark-row">
              <button
                type="button"
                className="toc-item"
                onClick={() => onGoToCfi(bookmark.cfi)}
                title="跳转到书签"
              >
                {bookmark.label ?? `书签 ${bookmark.cfi.slice(0, 18)}…`}
              </button>
              <button
                type="button"
                className="chrome-button"
                onClick={() => onRemoveBookmark(bookmark.id)}
                title="删除书签"
              >
                <X size={12} weight="regular" aria-hidden />
              </button>
            </div>
          ))}

          {toc.length === 0 && liveBookmarks.length === 0 ? (
            <p className="reader-toc-empty">这本书没有目录信息。</p>
          ) : (
            renderTocItems(toc, 0)
          )}
        </>
      ) : (
        <>
          <div className="segmented annotation-scope">
            <button
              type="button"
              className={annotationScope === 'chapter' ? 'is-active' : ''}
              onClick={() => setAnnotationScope('chapter')}
            >
              本章
            </button>
            <button
              type="button"
              className={annotationScope === 'book' ? 'is-active' : ''}
              onClick={() => setAnnotationScope('book')}
            >
              全书
            </button>
          </div>
          {shownAnnotations.length === 0 ? (
            <p className="reader-toc-empty">
              {annotationScope === 'chapter' && currentChapter !== null
                ? '本章还没有批注。'
                : '还没有批注 —— 在正文里划选即可。'}
            </p>
          ) : (
            shownAnnotations.map((record) => (
              <div key={record.id} className="annotation-row">
                <span className="annotation-dot" style={{ background: record.color }} aria-hidden />
                <div className="annotation-body">
                  <button
                    type="button"
                    className="annotation-item"
                    onClick={() => onGoToCfi(record.cfi)}
                    title="跳到原文"
                  >
                    <span className="annotation-excerpt">{record.excerpt}</span>
                    {record.note !== undefined && record.note !== '' && (
                      <span className="annotation-note">{record.note}</span>
                    )}
                  </button>
                  {noteDraft?.id === record.id && (
                    <NoteEditor
                      draft={noteDraft}
                      onChange={onNoteDraftChange}
                      onSave={onCommitNote}
                      onCancel={() => onNoteDraftChange(null)}
                    />
                  )}
                </div>
                <div className="annotation-actions">
                  <button
                    type="button"
                    className="chrome-button"
                    onClick={() =>
                      onStartNote({
                        id: record.id,
                        cfi: record.cfi,
                        excerpt: record.excerpt,
                        color: record.color,
                        note: record.note,
                      })
                    }
                    title="写笔记"
                  >
                    <PencilSimple size={12} weight="regular" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="chrome-button"
                    onClick={() => onRemoveAnnotation(record.id)}
                    title="删除划线"
                  >
                    <Trash size={12} weight="regular" aria-hidden />
                  </button>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </nav>
  )
}

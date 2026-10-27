/**
 * 脚注弹层:挂载内核渲染好的二级 foliate-view 元素(脚注/尾注/文献/释义),
 * 滚动流、阅读主题由适配器在 render 时下发;宿主负责关闭时释放内核视图。
 * Esc 关闭的优先级在 ReaderScreen 的全局 Esc 分支里让位(弹层开着时不收面板)。
 */

import { useEffect, useRef } from 'react'
import { X } from '@phosphor-icons/react'

const FOOTNOTE_TYPE_LABELS: Readonly<Record<string, string>> = {
  footnote: '脚注',
  endnote: '尾注',
  biblioentry: '文献',
  definition: '释义',
  note: '注',
}

interface FootnotePopupProps {
  /** 内核渲染好脚注内容的二级 foliate-view 自定义元素。 */
  readonly view: HTMLElement
  readonly type: string | null
  readonly onClose: () => void
}

export function FootnotePopup({ view, type, onClose }: FootnotePopupProps) {
  const bodyRef = useRef<HTMLDivElement>(null)

  // 内核视图元素挂进弹层;卸载时摘元素(内核视图本身的 close 由宿主
  // onClose 负责 —— 那里同时清 React 状态,顺序不会打架)。
  useEffect(() => {
    const host = bodyRef.current
    if (host === null) return
    host.append(view)
    return () => {
      view.remove()
    }
  }, [view])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const label = FOOTNOTE_TYPE_LABELS[type ?? ''] ?? '脚注'
  return (
    <aside className="footnote-popup" aria-label={label}>
      <div className="lookup-head">
        <strong>{label}</strong>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={12} weight="regular" aria-hidden />
        </button>
      </div>
      <div ref={bodyRef} className="footnote-popup-body" />
    </aside>
  )
}

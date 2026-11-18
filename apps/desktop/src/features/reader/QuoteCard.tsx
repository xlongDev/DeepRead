/**
 * 金句分享卡弹层:画布预览 + 保存 PNG。
 *
 * 保存走 Rust 命令(share.card.export):WebView 拦截 `<a download>`,与批注
 * 导出同一个理由。取消对话框不报错 —— 取消不是失败。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toAppError } from '@deepread/shared'
import { invokeCommand } from '../../lib/ipc'
import { useModalFocus } from '../../lib/modal-dialog'
import { base64OfDataUrl, drawQuoteCard, type QuoteCardSpec } from './quote-card'

export function QuoteCardModal({
  spec,
  onClose,
}: {
  readonly spec: QuoteCardSpec
  readonly onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panelRef = useRef<HTMLDialogElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** 刚保存到的绝对路径(null = 没保存过);取消对话框不占这个位。 */
  const [saved, setSaved] = useState<string | null>(null)
  useModalFocus(panelRef, { initialFocusRef: saveRef })

  // Esc 关闭:与 BookInfoDialog 同一约定(useModalFocus 只管焦点圈与归还)。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas !== null) drawQuoteCard(canvas, spec)
  }, [spec])

  const save = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const dataUrl = drawQuoteCard(canvas, spec)
    if (dataUrl === null) return
    setBusy(true)
    setProblem(null)
    invokeCommand('share.card.export', {
      base64: base64OfDataUrl(dataUrl),
      defaultName: `${spec.bookTitle}-分享卡`,
    })
      .then((response) => {
        setBusy(false)
        if (response.path !== null) setSaved(response.path)
      })
      .catch((error: unknown) => {
        setBusy(false)
        setProblem(toAppError(error).message)
      })
  }, [spec])

  return (
    <div className="quote-card-overlay">
      <dialog
        ref={panelRef}
        className="quote-card-panel"
        open
        aria-modal="true"
        aria-label="金句分享卡"
      >
        <canvas ref={canvasRef} className="quote-card-canvas" aria-label="金句分享卡预览" />
        <div className="quote-card-actions">
          <button ref={saveRef} type="button" className="btn" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存图片'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        {saved !== null && <output className="quote-card-saved">已保存:{saved}</output>}
        {problem !== null && (
          <p className="quote-card-problem" role="alert">
            {problem}
          </p>
        )}
      </dialog>
    </div>
  )
}

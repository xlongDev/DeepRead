import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 模态弹窗的键盘圈。配合 JSX 上的 `aria-modal="true"` 使用:
 *
 * - 挂载时记住来源焦点,落到面板内(initialFocusRef 优先,否则第一个可聚焦项);
 * - Tab / Shift+Tab 在面板内首尾循环 —— aria-modal 承诺了「背景不存在」,
 *   Tab 却能跑到背景去,键盘与读屏用户就被留在说谎的界面里;
 * - 卸载时把焦点还给来源。
 *
 * Esc 与点遮罩关闭仍归各弹窗自管(它们已有),这里只管 Tab 圈与焦点进出。
 */
export function useModalFocus(
  panelRef: RefObject<HTMLElement | null>,
  { initialFocusRef }: { initialFocusRef?: RefObject<HTMLElement | null> } = {},
): void {
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const previous = document.activeElement as HTMLElement | null
    const initial = initialFocusRef?.current ?? panel.querySelector<HTMLElement>(FOCUSABLE)
    initial?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const current = document.activeElement
      // 焦点已溜到面板外(浏览器怪癖/程序化改焦点)时,Tab 一律拉回圈内。
      if (event.shiftKey) {
        if (current === first || !panel.contains(current)) {
          event.preventDefault()
          last.focus()
        }
      } else if (current === last || !panel.contains(current)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
  }, [panelRef, initialFocusRef])
}

import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(',')

/**
 * 焦点圈只收真正能 Tab 到的控件。隐藏的 file input 由可见按钮 .click()
 * 触发,既看不见也没有可访问名 —— 一旦混进圈里,键盘用户会掉进一个空停靠点,
 * 读屏还会把它报成一个无名输入框。选择器本身按标签收集,统一的过滤放在这里:
 * 退出 Tab 顺序(tabIndex < 0)或在 aria-hidden 子树里的都不要。
 */
function focusableIn(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && element.closest('[aria-hidden="true"]') === null,
  )
}

/**
 * 非模态抽屉的焦点进出。与 useModalFocus 的差别是**刻意不圈 Tab**:
 * 抽屉没有 `aria-modal`,背景书架/正文仍可点,圈住焦点反而会让读屏用户
 * 以为整个应用被锁死了。只做两件事 —— 挂载时把焦点送进面板第一个可聚焦
 * 项,卸载时还给来源。TTS 播放器有 mini ↔ full 双形态且播放中不该抢焦点,
 * 是唯一不挂这个 hook 的侧板。
 */
export function useDrawerFocus(panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const previous = document.activeElement as HTMLElement | null
    focusableIn(panel)[0]?.focus()
    return () => previous?.focus()
  }, [panelRef])
}

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
    const initial = initialFocusRef?.current ?? focusableIn(panel)[0]
    initial?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusableIn(panel)
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

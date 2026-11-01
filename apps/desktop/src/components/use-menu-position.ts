import { useLayoutEffect, type RefObject } from 'react'

/**
 * 把 portal 出去、`position: fixed` 的浮层贴到触发器旁边。
 *
 * 抽出来是因为本仓有两套菜单(DropdownMenu 的「选一个值」、ActionMenu 的
 * 「执行一个动作」):外观与语义不同,但**落位规则必须一样** —— 否则同一个
 * 顶栏里两个菜单,一个向下弹一个向下探出屏幕。
 *
 * 位置直接写 DOM(layout effect 的本职),不落 state:绘制前跑完,portal 首帧
 * 即落位,不闪。
 */
export function useMenuPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  minWidth = 200,
  /**
   * `start` = 菜单左边缘贴触发器左边缘(下拉选择的标准)。
   * `end`  = 右边缘对齐(工具栏最右那颗按钮的附件菜单)。
   * `auto` = 触发器过中线就右对齐 —— 顶栏 ⋯ 用它,菜单才会往左长而不是
   *          伸出工具栏一大截。
   */
  align: 'start' | 'end' | 'auto' = 'start',
): void {
  useLayoutEffect(() => {
    const menu = menuRef.current
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!open || !menu || !rect) return
    const below = window.innerHeight - rect.bottom - 8
    // 下方放不下、且上方更宽裕时才翻上去 —— 否则「刚好差几像素」会来回跳。
    const flip = menu.offsetHeight + 8 > below && rect.top - 8 > below
    const top = flip ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6
    // 横向:默认左对齐;右边放不下就改成**右对齐触发器**,而不是硬夹回视口
    // —— 夹回之后菜单与触发器错开一大截,读作「点错了地方」。顶栏最右那颗
    // 按钮开出来的菜单就该往左长。
    const overflowRight = rect.left + menu.offsetWidth > window.innerWidth - 8
    const hugEnd =
      align === 'end' || (align === 'auto' && rect.left + rect.width / 2 > window.innerWidth / 2)
    const left = Math.max(
      8,
      hugEnd || overflowRight
        ? rect.right - menu.offsetWidth
        : Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8),
    )
    // 菜单至少与触发器同宽:portal 之后 CSS 的 100% 解析自 body,得手量。
    const width = Math.max(minWidth, Math.min(rect.width, window.innerWidth - 16))
    Object.assign(menu.style, {
      top: `${top}px`,
      left: `${left}px`,
      minWidth: `${width}px`,
    })
  }, [open, triggerRef, menuRef, minWidth, align])
}

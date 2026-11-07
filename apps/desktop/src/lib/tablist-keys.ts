import type { KeyboardEvent } from 'react'

/**
 * WAI-ARIA tabs 的键盘模式:←/→ 在页签间循环、Home/End 直达首尾,
 * 焦点跟着选中项走(配合 roving tabindex:只有选中项留在 Tab 顺序里)。
 *
 * 必须挂**容器**上:`currentTarget` 才是 tablist,才能一次查到全部页签。
 * 返回是否已处理,方便调用方做别的分支;不认识的键一律原样放行。
 *
 * `stopPropagation` 不是保险措施而是硬要求:阅读器在 window 上用 bubble
 * 监听把 ←/→ 映射成翻页,不截断的话按一次会「切一个页签 + 翻一页书」。
 * preventDefault 同时挡掉方向键的页面滚动。
 */
export function handleTablistKeys(
  event: KeyboardEvent<HTMLElement>,
  onSelect: (index: number) => void,
): boolean {
  if (
    event.key !== 'ArrowLeft' &&
    event.key !== 'ArrowRight' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return false
  }

  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
  if (tabs.length === 0) return false
  const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
  if (current < 0) return false

  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (current + 1) % tabs.length
          : (current - 1 + tabs.length) % tabs.length

  event.preventDefault()
  event.stopPropagation()
  onSelect(next)
  tabs[next]?.focus()
  return true
}

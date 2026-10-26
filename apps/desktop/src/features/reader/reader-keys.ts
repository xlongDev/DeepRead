/**
 * 阅读器键盘映射(纯函数)。
 *
 * 只回答「这个按键要干什么」,不执行任何动作 —— 执行留在组件里,因为那要碰
 * 内核 ref 和 setState。抽出来的价值:键位表能单独读、单独测,不会被
 * 2000 行组件里的 handler 淹没。
 */

export type ReaderKeyAction = 'fullscreen' | 'next' | 'prev' | 'escape' | 'ruler-up' | 'ruler-down'

/** 只取用得到的字段,方便测试直接传字面量。 */
export interface ReaderKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

/**
 * 键 → 动作。未绑定返回 null(调用方不做 preventDefault,让浏览器自己处理)。
 *
 * F11 是各平台的通用全屏键;Ctrl+⌘+F 是 macOS 上的替代写法(Tauri 里
 * Cmd+F 会被系统占用,所以要求三个修饰键同时按下)。
 */
/**
 * 焦点落在可编辑元素(输入框/文本域/下拉/滑杆/可编辑内容)上时,翻页与阅读尺
 * 按键必须让位给原生行为 —— 否则在目录搜索框里敲空格会翻页并吞掉空格,
 * 进度滑杆的 ←→ 也永远调不动滑杆。Escape 与全屏不受此限(见调用方)。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

export function readerKeyAction(event: ReaderKeyEvent): ReaderKeyAction | null {
  if (event.key === 'F11' || (event.key === 'f' && event.ctrlKey && event.metaKey)) {
    return 'fullscreen'
  }
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') return 'next'
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') return 'prev'
  // 上下方向键归阅读尺:开尺时移尺(走到页尾自然翻页),关尺时调用方直接
  // 忽略,保持「未绑定 = 交给浏览器」的旧行为。
  if (event.key === 'ArrowDown') return 'ruler-down'
  if (event.key === 'ArrowUp') return 'ruler-up'
  if (event.key === 'Escape') return 'escape'
  return null
}

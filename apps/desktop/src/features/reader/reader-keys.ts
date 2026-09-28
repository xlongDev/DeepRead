/**
 * 阅读器键盘映射(纯函数)。
 *
 * 只回答「这个按键要干什么」,不执行任何动作 —— 执行留在组件里,因为那要碰
 * 内核 ref 和 setState。抽出来的价值:键位表能单独读、单独测,不会被
 * 2000 行组件里的 handler 淹没。
 */

export type ReaderKeyAction = 'fullscreen' | 'next' | 'prev' | 'escape'

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
export function readerKeyAction(event: ReaderKeyEvent): ReaderKeyAction | null {
  if (event.key === 'F11' || (event.key === 'f' && event.ctrlKey && event.metaKey)) {
    return 'fullscreen'
  }
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') return 'next'
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') return 'prev'
  if (event.key === 'Escape') return 'escape'
  return null
}

/**
 * 浏览器端落盘的通用做法:`<a download>` + object URL —— 原先在 web-store
 * 与 notes-view 各有一份,收拢到这里。
 *
 * ⚠️ 桌面端不要走这条:WebView 默认拦截 `<a download>`,用户点了什么都不会
 * 发生(这正是「导出图标没反应」的根因)。桌面端要走系统保存对话框的,由
 * 各自的功能层处理(见 notes-view.ts 的 `saveNoteMarkdown`)。
 */

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export function downloadText(fileName: string, text: string, mime: string): void {
  downloadBlob(fileName, new Blob([text], { type: mime }))
}

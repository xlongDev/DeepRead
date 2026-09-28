/**
 * 笔记视图(W1):壳先立起来,数据在 W4 接(需要一条跨书查询的 IPC)。
 *
 * 这里刻意不画假数据 —— 空态说实话:阅读器里划过的句子已经在每本书里存着,
 * 只是还没有一个地方能把它们聚到一起。宁可空白,不要骗人的列表。
 */

import { NoteBlank } from '@phosphor-icons/react'

export function NotesView() {
  return (
    <section className="notes-page" aria-label="笔记">
      <h1 className="shelf-title">笔记</h1>
      <div className="notes-empty">
        <NoteBlank size={40} weight="light" aria-hidden />
        <p className="notes-empty-title">笔记聚合还没接线</p>
        <p className="notes-empty-hint">
          你在阅读器里划过的高亮与批注,已经按 CFI 存在每本书里。这里将是它们聚在一起的地方:
          按书分组、点一条跳回原文、一次导出成 Markdown。
        </p>
      </div>
    </section>
  )
}

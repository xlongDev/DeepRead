import { describe, expect, it } from 'vitest'
import type { NoteEntry } from '@deepread/shared'
import {
  excerptPreview,
  formatNoteTime,
  groupNotesByBook,
  notesToMarkdown,
  onlyWithNotes,
} from './notes-view'

const note = (overrides: Partial<NoteEntry>): NoteEntry => ({
  id: 'n1',
  bookHash: 'a'.repeat(64),
  displayName: '夜航书',
  fileName: '夜航书.epub',
  cfi: 'epubcfi(/6/4!2/2)',
  color: '#f5d76e',
  note: null,
  excerpt: '原文',
  updatedAt: '2026-09-27T12:00:00Z',
  ...overrides,
})

describe('groupNotesByBook', () => {
  it('按书聚在一起,组间顺序沿用输入的新→旧', () => {
    const notes = [
      note({ id: 'n1', bookHash: 'a'.repeat(64) }),
      note({ id: 'n2', bookHash: 'a'.repeat(64) }),
      note({ id: 'n3', bookHash: 'b'.repeat(64), displayName: '山中手记' }),
    ]
    const groups = groupNotesByBook(notes)
    expect(groups.map((group) => group.notes.map((item) => item.id))).toEqual([
      ['n1', 'n2'],
      ['n3'],
    ])
    expect(groups[0]?.title).toBe('夜航书')
    expect(groups[1]?.title).toBe('山中手记')
  })

  it('标题回退到清洗过的文件名(与书架同一套规则)', () => {
    const groups = groupNotesByBook([
      note({ displayName: null, fileName: '夜航书 (z-library.sk, 1lib.sk).epub' }),
    ])
    expect(groups[0]?.title).toBe('夜航书')
  })

  it('没有批注时返回空数组,而不是一个空组', () => {
    expect(groupNotesByBook([])).toEqual([])
  })
})

describe('formatNoteTime', () => {
  const now = new Date('2026-09-28T12:00:00Z')

  it('近处用相对时间,远处退回日期', () => {
    expect(formatNoteTime('2026-09-28T11:59:30Z', now)).toBe('刚刚')
    expect(formatNoteTime('2026-09-28T11:30:00Z', now)).toBe('30 分钟前')
    expect(formatNoteTime('2026-09-28T09:00:00Z', now)).toBe('3 小时前')
    expect(formatNoteTime('2026-09-27T12:00:00Z', now)).toBe('昨天')
    expect(formatNoteTime('2026-09-20T12:00:00Z', now)).toBe('8 天前')
    expect(formatNoteTime('2026-05-01T12:00:00Z', now)).toBe('2026-05-01')
  })

  it('没有时间戳或时间戳非法时返回 null(界面就不显示这一项)', () => {
    expect(formatNoteTime(null, now)).toBeNull()
    expect(formatNoteTime('不是时间', now)).toBeNull()
  })
})

describe('excerptPreview', () => {
  it('截断过长的摘录并加省略号', () => {
    expect(excerptPreview('短句')).toBe('短句')
    expect(excerptPreview('一'.repeat(200))).toBe(`${'一'.repeat(160)}…`)
    expect(excerptPreview('一'.repeat(160))).toBe('一'.repeat(160))
  })

  it('空内容当成没有摘录', () => {
    expect(excerptPreview(null)).toBeNull()
    expect(excerptPreview('   ')).toBeNull()
  })
})

describe('onlyWithNotes', () => {
  it('只留写了自己话的那几条', () => {
    const notes = [
      note({ id: 'n1', note: '我想的' }),
      note({ id: 'n2', note: null }),
      note({ id: 'n3', note: '   ' }),
      note({ id: 'n4', note: '也想过的' }),
    ]
    expect(onlyWithNotes(notes).map((item) => item.id)).toEqual(['n1', 'n4'])
  })
})

describe('notesToMarkdown', () => {
  it('按书分节,原文用引用块,自己写的话跟在后面', () => {
    const groups = groupNotesByBook([
      note({ id: 'n1', displayName: '夜航书', excerpt: '原文一', note: '我自己写的' }),
      note({
        id: 'n2',
        bookHash: 'b'.repeat(64),
        displayName: '山中手记',
        excerpt: '原文二',
        note: null,
      }),
    ])
    const markdown = notesToMarkdown(groups, new Date('2026-09-28T12:00:00Z'))

    expect(markdown.split('\n')).toEqual([
      '# 阅读笔记',
      '',
      '导出时间:2026-09-28',
      '',
      '## 夜航书',
      '',
      '> 原文一',
      '',
      '我自己写的',
      '',
      '## 山中手记',
      '',
      '> 原文二',
      '',
    ])
  })

  it('导出时**不**截断摘录 —— 截断是列表的呈现选择', () => {
    const long = '一'.repeat(500)
    const markdown = notesToMarkdown(groupNotesByBook([note({ excerpt: long })]))
    expect(markdown).toContain(long)
    expect(markdown).not.toContain('…')
  })

  it('没有批注时也产出合法的一页', () => {
    expect(notesToMarkdown([], new Date('2026-09-28T12:00:00Z'))).toBe(
      '# 阅读笔记\n\n导出时间:2026-09-28\n',
    )
  })
})

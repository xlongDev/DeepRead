import { describe, expect, it } from 'vitest'
import { isEditableTarget, readerKeyAction, type ReaderKeyEvent } from './reader-keys'

function press(key: string, modifiers: Partial<ReaderKeyEvent> = {}): ReaderKeyEvent {
  return { key, ctrlKey: false, metaKey: false, ...modifiers }
}

describe('全屏', () => {
  it('F11 触发全屏', () => {
    expect(readerKeyAction(press('F11'))).toBe('fullscreen')
  })

  it('Ctrl+⌘+F 触发全屏(macOS 替代键)', () => {
    expect(readerKeyAction(press('f', { ctrlKey: true, metaKey: true }))).toBe('fullscreen')
  })

  it('两个修饰键缺一不可 —— 单独 Cmd+F 交给浏览器/系统', () => {
    expect(readerKeyAction(press('f', { metaKey: true }))).toBeNull()
    expect(readerKeyAction(press('f', { ctrlKey: true }))).toBeNull()
    expect(readerKeyAction(press('f'))).toBeNull()
  })

  it('大写 F 不触发(与 Shift 组合留给系统)', () => {
    expect(readerKeyAction(press('F', { ctrlKey: true, metaKey: true }))).toBeNull()
  })
})

describe('翻页', () => {
  it('右 / PageDown / 空格都是下一页', () => {
    for (const k of ['ArrowRight', 'PageDown', ' ']) {
      expect(readerKeyAction(press(k))).toBe('next')
    }
  })

  it('左 / PageUp 是上一页', () => {
    for (const k of ['ArrowLeft', 'PageUp']) {
      expect(readerKeyAction(press(k))).toBe('prev')
    }
  })

  it('上下方向键归阅读尺(关尺时调用方忽略)', () => {
    expect(readerKeyAction(press('ArrowUp'))).toBe('ruler-up')
    expect(readerKeyAction(press('ArrowDown'))).toBe('ruler-down')
  })
})

describe('面板快捷键(修饰键 + 单键)', () => {
  it('⌘K 与 Ctrl+K 都唤起搜索', () => {
    expect(readerKeyAction(press('k', { metaKey: true }))).toBe('search')
    expect(readerKeyAction(press('k', { ctrlKey: true }))).toBe('search')
  })

  it('⌘B 与 Ctrl+B 都开关目录侧栏', () => {
    expect(readerKeyAction(press('b', { metaKey: true }))).toBe('toggle-sidebar')
    expect(readerKeyAction(press('b', { ctrlKey: true }))).toBe('toggle-sidebar')
  })

  it('无修饰键的 k / b 是普通字符,不绑定', () => {
    expect(readerKeyAction(press('k'))).toBeNull()
    expect(readerKeyAction(press('b'))).toBeNull()
    expect(readerKeyAction(press('K', { metaKey: true }))).toBeNull()
  })

  it('键位表可自定义:⌘J 走搜索,默认 k 同时失效', () => {
    const bindings = { search: 'j' }
    expect(readerKeyAction(press('j', { metaKey: true }), bindings)).toBe('search')
    expect(readerKeyAction(press('k', { metaKey: true }), bindings)).toBeNull()
  })

  it('默认键位(e/t/l)触发 AI / 听书 / 学习', () => {
    expect(readerKeyAction(press('e', { metaKey: true }))).toBe('ai')
    expect(readerKeyAction(press('t', { ctrlKey: true }))).toBe('tts')
    expect(readerKeyAction(press('l', { metaKey: true }))).toBe('learning')
  })

  it('键位表里缺的动作不绑定(空表不回退默认)', () => {
    expect(readerKeyAction(press('e', { metaKey: true }), {})).toBeNull()
    expect(readerKeyAction(press('e', { metaKey: true }), { ai: undefined })).toBeNull()
  })
})

describe('Escape 与未绑定键', () => {
  it('Escape 归 escape 动作', () => {
    expect(readerKeyAction(press('Escape'))).toBe('escape')
  })

  it('普通字符键一律返回 null,调用方不做 preventDefault', () => {
    for (const k of ['a', 'Enter', 'Tab', 'Backspace']) {
      expect(readerKeyAction(press(k))).toBeNull()
    }
  })

  it('Escape 带修饰键仍是 escape(与系统快捷键冲突时由浏览器先截获)', () => {
    expect(readerKeyAction(press('Escape', { metaKey: true }))).toBe('escape')
  })
})

describe('可编辑焦点判定', () => {
  it('输入框/文本域/下拉/滑杆都算可编辑', () => {
    const range = document.createElement('input')
    range.type = 'range'
    for (const el of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      range,
    ]) {
      expect(isEditableTarget(el)).toBe(true)
    }
    // contenteditable 分支 jsdom 未实现 isContentEditable,测不了;真实浏览器
    // 路径由实现里的 isContentEditable 兜住。
  })

  it('普通元素、window、null 都不算可编辑(window 上的裸按键不受影响)', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { readerKeyAction, type ReaderKeyEvent } from './reader-keys'

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

  it('上下方向键不绑定(滚动模式交给内核自己处理)', () => {
    expect(readerKeyAction(press('ArrowUp'))).toBeNull()
    expect(readerKeyAction(press('ArrowDown'))).toBeNull()
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

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  KEYBINDING_DEFAULTS,
  getKeybindings,
  resetKeybindings,
  setKeybinding,
  subscribeKeybindings,
} from './keybindings'

describe('项目快捷键存取', () => {
  beforeEach(() => {
    resetKeybindings()
  })

  it('默认键位与 reader-keys 的历史行为一致(k/b)', () => {
    expect(getKeybindings().search).toBe('k')
    expect(getKeybindings().sidebar).toBe('b')
  })

  it('改键写入存储并通知订阅者(运行时即时生效)', () => {
    let notified = 0
    const unsubscribe = subscribeKeybindings(() => {
      notified += 1
    })
    setKeybinding('search', 'j')
    unsubscribe()
    expect(getKeybindings().search).toBe('j')
    expect(JSON.parse(localStorage.getItem('deepread.keybindings') ?? '{}')).toMatchObject({
      search: 'j',
    })
    expect(notified).toBe(1)
  })

  it('只收单字符键,破坏性输入被忽略', () => {
    setKeybinding('search', 'Meta')
    setKeybinding('search', 'F3')
    expect(getKeybindings().search).toBe('k')
  })

  it('重置回默认并清掉存档', () => {
    setKeybinding('search', 'j')
    resetKeybindings()
    expect(getKeybindings().search).toBe(KEYBINDING_DEFAULTS.search)
    expect(localStorage.getItem('deepread.keybindings')).toBeNull()
  })
})

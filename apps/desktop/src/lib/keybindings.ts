/**
 * 项目快捷键:修饰键(⌘ / Ctrl)固定,可自定义的是单键。
 *
 * 存储是「动作 id → 字母键」的扁平表;模块级缓存 + 订阅,让设置里改键后
 * 阅读器/书架的运行时键位即时生效(不必重开书)。默认键位与 reader-keys
 * 的历史行为一致(k/b),⌘E/⌘T/⌘L 是本轮新增的面板键。
 */

import { useSyncExternalStore } from 'react'

export type KeybindingId = 'search' | 'sidebar' | 'ai' | 'tts' | 'learning'

export const KEYBINDING_DEFAULTS: Readonly<Record<KeybindingId, string>> = {
  search: 'k',
  sidebar: 'b',
  ai: 'e',
  tts: 't',
  learning: 'l',
}

export const KEYBINDING_LABELS: Readonly<Record<KeybindingId, string>> = {
  search: '搜索全书',
  sidebar: '目录侧栏',
  ai: 'AI 助手',
  tts: '听书',
  learning: '学习',
}

const STORAGE_KEY = 'deepread.keybindings'
const KEYBINDING_IDS = Object.keys(KEYBINDING_DEFAULTS) as KeybindingId[]

let cache: Record<KeybindingId, string> | null = null
const listeners = new Set<() => void>()

function load(): Record<KeybindingId, string> {
  const merged = { ...KEYBINDING_DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    for (const id of KEYBINDING_IDS) {
      const value = raw[id]
      // 只收单个字符键:修饰键组合是固定的,存进来什么都只可能破坏匹配。
      if (typeof value === 'string' && value.length === 1) merged[id] = value.toLowerCase()
    }
  } catch {
    // 损坏的存档按默认键位来。
  }
  return merged
}

export function getKeybindings(): Record<KeybindingId, string> {
  if (cache === null) cache = load()
  return cache
}

export function setKeybinding(id: KeybindingId, key: string): void {
  if (key.length !== 1) return
  const next = { ...getKeybindings(), [id]: key.toLowerCase() }
  cache = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  listeners.forEach((listener) => listener())
}

export function resetKeybindings(): void {
  cache = { ...KEYBINDING_DEFAULTS }
  localStorage.removeItem(STORAGE_KEY)
  listeners.forEach((listener) => listener())
}

export function subscribeKeybindings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 运行时键位(改键即时生效)。 */
export function useKeybindings(): Record<KeybindingId, string> {
  return useSyncExternalStore(subscribeKeybindings, getKeybindings)
}

/** 键位提示文案:⌘K 形态(Windows 上 Ctrl+K 同效,提示以 macOS 为先)。 */
export function keyHint(id: KeybindingId, bindings?: Record<KeybindingId, string>): string {
  const letter = (bindings ?? getKeybindings())[id] ?? KEYBINDING_DEFAULTS[id]
  return `⌘${letter.toUpperCase()}`
}

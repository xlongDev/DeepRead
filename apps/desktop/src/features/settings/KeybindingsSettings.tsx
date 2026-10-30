/**
 * 快捷键设置:面板动作的「修饰键 + 单键」自定义。
 *
 * 修饰键固定 ⌘(Windows 上 Ctrl 同效),捕获只收单个字符键 —— 组合键自由度
 * 换来的是零冲突歧义与一致的肌肉记忆。与其它功能撞键时自动互换:两个动作
 * 都保得住,不需要冲突提示态。改键经 keybindings lib 的订阅即时生效。
 */

import { useEffect, useState } from 'react'
import {
  KEYBINDING_DEFAULTS,
  KEYBINDING_LABELS,
  resetKeybindings,
  setKeybinding,
  useKeybindings,
  type KeybindingId,
} from '../../lib/keybindings'

const IDS = Object.keys(KEYBINDING_LABELS) as KeybindingId[]

export function KeybindingsSettings() {
  const bindings = useKeybindings()
  /** 正在捕获键位的动作;null = 没有在改。 */
  const [capturing, setCapturing] = useState<KeybindingId | null>(null)

  useEffect(() => {
    if (capturing === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        return
      }
      // 只收单字符键:修饰键本身(Meta/Shift/Alt)与功能键忽略,继续等。
      if (event.key.length !== 1) return
      const key = event.key.toLowerCase()
      // 撞键互换:被占的那个动作拿走当前动作的旧键,两边都不落空。
      for (const id of IDS) {
        if (id !== capturing && bindings[id] === key) {
          setKeybinding(id, bindings[capturing] ?? KEYBINDING_DEFAULTS[capturing])
          break
        }
      }
      setKeybinding(capturing, key)
      setCapturing(null)
    }
    // capture 段截获:抢在输入框等目标自己的监听之前,捕获态是模态意图。
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, bindings])

  return (
    <section className="modal-section">
      <p className="modal-section-label">面板与书架动作</p>
      <div className="keybinding-list">
        {IDS.map((id) => (
          <div key={id} className="keybinding-row">
            <span className="keybinding-label">{KEYBINDING_LABELS[id]}</span>
            <button
              type="button"
              className={`keybinding-key${capturing === id ? ' is-capturing' : ''}`}
              onClick={() => setCapturing(id)}
              aria-label={`修改${KEYBINDING_LABELS[id]}的快捷键`}
            >
              {capturing === id ? '按下新键…' : `⌘${bindings[id]?.toUpperCase() ?? ''}`}
            </button>
          </div>
        ))}
      </div>
      <p className="keybinding-hint">
        修饰键固定为 ⌘(Windows 上 Ctrl 同效)。撞键自动互换;Esc 取消修改。
      </p>
      <div className="modal-actions">
        <button type="button" onClick={() => resetKeybindings()}>
          恢复默认键位
        </button>
      </div>
    </section>
  )
}

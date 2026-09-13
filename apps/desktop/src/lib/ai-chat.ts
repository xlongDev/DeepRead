/**
 * One-shot AI chat helper: collects a full streaming response into a string.
 * Used by feature drawers that need structured AI output (TTS characters,
 * learning generation) rather than a live chat transcript.
 */

import { extractDelta, type ChatMessage } from '@deepread/ai-core'
import { AppError, coerceErrorCode, toAppError } from '@deepread/shared'
import { invokeCommand, invokeStreamingCommand } from './ipc'

export function runChatOnce(configId: string, messages: readonly ChatMessage[]): Promise<string> {
  const taskId = `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  return new Promise<string>((resolve, reject) => {
    let text = ''
    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      run()
    }
    void invokeStreamingCommand(
      'ai.chat',
      { taskId, configId, messages: [...messages] },
      (event) => {
        if (event.type === 'chunk') {
          const delta = extractDelta(event.data)
          if (delta.type === 'delta') text += delta.text
        } else if (event.type === 'done') {
          finish(() => resolve(text))
        } else if (event.type === 'cancelled') {
          finish(() => resolve(text))
        } else {
          finish(() => {
            void invokeCommand('ai.cancel', { taskId }).catch(() => {})
            reject(
              new AppError(coerceErrorCode(event.data.code), event.data.message, {
                retryable: event.data.retryable,
              }),
            )
          })
        }
      },
    ).catch((error: unknown) => finish(() => reject(toAppError(error))))
  })
}

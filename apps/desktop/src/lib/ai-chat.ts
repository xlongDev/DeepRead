/**
 * Shared `ai.chat` stream collector (spec §28-31): waits for the Channel to
 * finish, parses Rust's already-unwrapped SSE frames, and normalizes errors.
 * Used by book insights, corrections, translation, chapter rules and the
 * one-shot helper below.
 */

import { extractDelta, type ChatMessage } from '@deepread/ai-core'
import { AppError, coerceErrorCode, toAppError } from '@deepread/shared'
import { invokeStreamingCommand } from './ipc'

/** 流式 AI 任务的 id:此前这个模板串在 AiDrawer/ReaderScreen/这里各复制了一份。 */
export function newTaskId(): string {
  return `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

/**
 * Collect a full `ai.chat` stream, optionally forwarding each delta as it lands.
 *
 * `invokeStreamingCommand` resolves as soon as the Rust command returns its task
 * id — the Channel keeps emitting afterwards. Only `done`/`error` events end the
 * turn, so awaiting the invoke is never enough. Rust has already stripped the
 * `data:` prefixes; feeding those frames to `createSseParser` (which expects raw
 * SSE) silently drops every delta.
 */
export function collectChatText(
  configId: string,
  messages: readonly ChatMessage[],
  onDelta?: (text: string) => void,
): Promise<string> {
  const taskId = newTaskId()
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
          if (delta.type === 'delta') {
            text += delta.text
            onDelta?.(delta.text)
          }
        } else if (event.type === 'done' || event.type === 'cancelled') {
          finish(() => resolve(text))
        } else {
          finish(() =>
            reject(
              new AppError(coerceErrorCode(event.data.code), event.data.message, {
                retryable: event.data.retryable,
              }),
            ),
          )
        }
      },
    ).catch((error: unknown) => finish(() => reject(toAppError(error))))
  })
}

/** One-shot chat for feature drawers that need the whole answer as a string. */
export function runChatOnce(configId: string, messages: readonly ChatMessage[]): Promise<string> {
  return collectChatText(configId, messages)
}

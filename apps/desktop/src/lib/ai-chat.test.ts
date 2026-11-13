import { describe, expect, it, vi } from 'vitest'
import { collectChatText, runChatOnce } from './ai-chat'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('./ipc', () => ({
  invokeStreamingCommand: invokeMock,
  invokeCommand: vi.fn(),
}))

const delta = (text: string): string => JSON.stringify({ choices: [{ delta: { content: text } }] })

describe('collectChatText', () => {
  it('waits for the done event emitted after the invoke already resolved', async () => {
    invokeMock.mockImplementation(
      async (
        _command: string,
        _request: unknown,
        onEvent: (event: { type: string; data?: unknown }) => void,
      ) => {
        // Rust 命令只回 taskId;Channel 在 invoke resolve 之后继续发帧。
        queueMicrotask(() => {
          onEvent({ type: 'chunk', data: delta('{"overview":') })
          onEvent({ type: 'chunk', data: delta('"ok"}') })
          onEvent({ type: 'done' })
        })
        return { taskId: 'task-1' }
      },
    )
    await expect(collectChatText('cfg-1', [{ role: 'user', content: 'hi' }])).resolves.toBe(
      '{"overview":"ok"}',
    )
  })

  it('surfaces an upstream error instead of resolving an empty answer', async () => {
    invokeMock.mockImplementation(
      async (
        _command: string,
        _request: unknown,
        onEvent: (event: { type: string; data?: unknown }) => void,
      ) => {
        queueMicrotask(() =>
          onEvent({
            type: 'error',
            data: {
              code: 'AI_PROVIDER_ERROR',
              message: 'AI 服务返回错误：Model request timed out',
              retryable: true,
            },
          }),
        )
        return { taskId: 'task-2' }
      },
    )
    await expect(runChatOnce('cfg-1', [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'Model request timed out',
    )
  })
})

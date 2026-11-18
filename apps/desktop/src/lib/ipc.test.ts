// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, listenMock, FakeChannel } = vi.hoisted(() => {
  const invoke = vi.fn()
  const listen = vi.fn()
  // 类名避开外层解构出的 FakeChannel:遮蔽报错,装饰语义不变。
  class ChannelStub {
    static readonly instances: ChannelStub[] = []
    onmessage: (message: Record<string, unknown>) => void = () => {}
    constructor() {
      ChannelStub.instances.push(this)
    }
  }
  return { invokeMock: invoke, listenMock: listen, FakeChannel: ChannelStub }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, Channel: FakeChannel }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { AppError, COMMAND, ErrorCodes } from '@deepread/shared'
import { webHandlers } from './web-handlers'
import { invokeCommand, invokeStreamingCommand, isTauriRuntime, listenEvent } from './ipc'

/** 把「期待拒绝」收敛成 AppError:catch 返回值与成功分支的 union 会让断言变模糊。 */
async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('期待该调用被拒绝,却成功了')
}

const setTauri = (on: boolean): void => {
  if (on) {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
  } else {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  FakeChannel.instances.length = 0
  setTauri(true)
})
afterEach(() => setTauri(false))

describe('isTauriRuntime', () => {
  it('以 window 上的注入标志分流', () => {
    expect(isTauriRuntime()).toBe(true)
    setTauri(false)
    expect(isTauriRuntime()).toBe(false)
  })
})

describe('invokeCommand', () => {
  it('把请求包成 { request } 传给 invoke,响应过校验后原样返回', async () => {
    invokeMock.mockResolvedValue(true)
    await expect(invokeCommand('fonts.remove', { id: 'font-1' })).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('fonts.remove', { request: { id: 'font-1' } })
  })

  it('响应未过 schema 校验 = 安全事件,不是静默透传', async () => {
    invokeMock.mockResolvedValue('yes')
    const error = await failureOf(invokeCommand('fonts.remove', { id: 'font-1' }))
    expect(error.code).toBe(ErrorCodes.securityValidationFailed)
    expect(error.message).toContain('未通过 schema 校验')
  })

  it('Rust 的 wire 错误载荷归一成 AppError', async () => {
    invokeMock.mockRejectedValue({ code: 'STORAGE_IO', message: '数据库忙', retryable: false })
    const error = await failureOf(invokeCommand('fonts.remove', { id: 'font-1' }))
    expect(error.code).toBe('STORAGE_IO')
    expect(error.message).toBe('数据库忙')
    expect(error.retryable).toBe(false)
  })

  it('Tauri 的裸字符串失败(panic/坏参数)原样透出,不是一句笼统的失败', async () => {
    invokeMock.mockRejectedValue('tauri: state not managed')
    const error = await failureOf(invokeCommand('fonts.remove', { id: 'font-1' }))
    expect(error.code).toBe(ErrorCodes.systemIpcFailed)
    expect(error.message).toBe('tauri: state not managed')
  })

  it('浏览器模式:命中 web 实现就走本地,不碰 invoke', async () => {
    setTauri(false)
    const handler = vi.fn(async (): Promise<boolean> => true)
    Object.assign(webHandlers, { [COMMAND.fontsRemove]: handler })
    await expect(invokeCommand('fonts.remove', { id: 'font-1' })).resolves.toBe(true)
    expect(handler).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('浏览器模式:未实现的命令明确报「运行时不可用」,不静默', async () => {
    setTauri(false)
    const error = await failureOf(invokeCommand('cloud.backup', undefined))
    expect(error.code).toBe(ErrorCodes.systemRuntimeUnavailable)
    expect(error.message).toContain('运行时不可用')
  })
})

describe('listenEvent', () => {
  it('传输名把点换成冒号,合法载荷才进 handler', async () => {
    listenMock.mockResolvedValue(() => {})
    const handler = vi.fn()
    await listenEvent('app.ready', handler)
    expect(listenMock.mock.calls[0]?.[0]).toBe('app:ready')
    const onEvent = listenMock.mock.calls[0]?.[1] as (e: { payload: unknown }) => void
    const payload = { startedAt: '2026-11-18T00:00:00Z', appVersion: '0.2.0' }
    onEvent({ payload })
    expect(handler).toHaveBeenCalledWith(payload)
    onEvent({ payload: { startedAt: 'not-iso' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('浏览器模式订阅直接拒绝', async () => {
    setTauri(false)
    await expect(listenEvent('app.ready', () => {})).rejects.toThrow('运行时不可用')
  })
})

describe('invokeStreamingCommand', () => {
  const request = { taskId: 'task-1234', configId: 'cfg-12345678', messages: [] }

  it('响应照常校验;Channel 帧分型派发', async () => {
    invokeMock.mockResolvedValue({ taskId: 'task-1234' })
    const events: string[] = []
    const done = invokeStreamingCommand('ai.chat', request, (event) => events.push(event.type))
    const channel = FakeChannel.instances.at(-1)
    expect(channel).toBeDefined()
    channel!.onmessage({ type: 'chunk', data: 'x' })
    channel!.onmessage({ type: 'done' })
    channel!.onmessage({ type: 'cancelled' })
    channel!.onmessage({
      type: 'error',
      data: { code: 'AI_PROVIDER_ERROR', message: 'm', retryable: true },
    })
    await expect(done).resolves.toEqual({ taskId: 'task-1234' })
    expect(events).toEqual(['chunk', 'done', 'cancelled', 'error'])
    expect(invokeMock).toHaveBeenCalledWith('ai.chat', { request, onEvent: expect.anything() })
  })

  it('畸形帧丢弃不进消费者;error 帧缺字段按默认值归一', async () => {
    invokeMock.mockResolvedValue({ taskId: 'task-1234' })
    const seen: unknown[] = []
    const done = invokeStreamingCommand('ai.chat', request, (event) => seen.push(event))
    const channel = FakeChannel.instances.at(-1)!
    channel.onmessage({ type: 42 })
    channel.onmessage({ type: 'chunk', data: 7 })
    channel.onmessage({ type: 'error', data: null })
    await done
    expect(seen).toEqual([
      {
        type: 'error',
        data: {
          code: 'AI_PROVIDER_ERROR',
          message: 'AI 服务返回了无法解析的错误。',
          retryable: false,
        },
      },
    ])
  })

  it('浏览器模式不可用', async () => {
    setTauri(false)
    await expect(invokeStreamingCommand('ai.chat', request, () => {})).rejects.toThrow(
      '运行时不可用',
    )
  })
})

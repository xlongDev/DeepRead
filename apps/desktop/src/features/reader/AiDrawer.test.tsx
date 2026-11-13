// @vitest-environment jsdom
/**
 * AiDrawer 契约测试:只锁「概念洞察 → 复习卡」这条新闭环,不覆盖流式问答。
 *
 * 洞察不从生成流程注入,而是让 ai.artifact.get 回一份已持久化的概念产物 ——
 * 这正是读者重新打开抽屉时看到的真实路径。IPC 整体打桩,不拉起 webview。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeCommand } from '../../lib/ipc'
import { AiDrawer } from './AiDrawer'

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  invokeStreamingCommand: vi.fn(),
  isTauriRuntime: (): boolean => true,
}))

const invokeMock = vi.mocked(invokeCommand)
const BOOK_HASH = 'a'.repeat(64)

const CONCEPTS = {
  concepts: [
    { name: '认知带宽', explanation: '单位时间内可用于决策的注意力总量。', relations: [] },
    { name: '元认知', explanation: '对自己思考过程的观察与调节。', relations: [] },
  ],
}

let conceptPayload: unknown = CONCEPTS

function respond(command: string, request?: unknown): unknown {
  const kind = (request as { kind?: string } | undefined)?.kind
  switch (command) {
    case 'ai.config.list':
      return { providers: [] }
    case 'ai.artifact.get':
      return kind === 'concepts'
        ? { payload: conceptPayload, createdAt: '2026-11-13T00:00:00Z' }
        : { payload: null, createdAt: null }
    case 'cards.add':
      return { added: 2, savedAt: '2026-11-13T00:00:00Z' }
    default:
      return undefined
  }
}

const PROPS = {
  selection: null,
  contextText: null,
  sections: [],
  bookHash: BOOK_HASH,
  title: '认知觉醒',
  sourceText: null,
  onReplaceSource: vi.fn(async (): Promise<void> => undefined),
  onClose: vi.fn(),
}

interface CardsAddCall {
  readonly bookHash: string
  readonly cards: readonly {
    readonly id: string
    readonly front: string
    readonly back: string
    readonly source: string
    readonly dueAt: string
  }[]
}

function cardsAddRequest(): CardsAddCall {
  const call = invokeMock.mock.calls.find(([command]) => command === 'cards.add')
  if (call === undefined) throw new Error('没有发出 cards.add')
  return call[1] as unknown as CardsAddCall
}

function asNeverImplementation(
  handler: (command: string, request?: unknown) => Promise<unknown>,
): never {
  return handler as never
}

beforeEach(() => {
  conceptPayload = CONCEPTS
  invokeMock.mockReset()
  invokeMock.mockImplementation(
    asNeverImplementation((command, request) => Promise.resolve(respond(command, request))),
  )
})

afterEach(cleanup)

describe('概念洞察 → 复习卡', () => {
  it('名→正面、解释→背面、source=quiz、id 确定性,一次写完整批', async () => {
    render(<AiDrawer {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: /做成复习卡\(2\)/ }))
    await waitFor(() => {
      expect(screen.getByText(/本次新增 2 张复习卡/)).toBeTruthy()
    })

    const request = cardsAddRequest()
    expect(request.bookHash).toBe(BOOK_HASH)
    expect(request.cards).toHaveLength(2)
    expect(request.cards[0]).toMatchObject({
      id: `concept-${BOOK_HASH.slice(0, 16)}-认知带宽`,
      front: '认知带宽',
      back: '单位时间内可用于决策的注意力总量。',
      source: 'quiz',
    })
    expect(request.cards[0]!.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(request.cards[1]!.front).toBe('元认知')
  })

  it('重开抽屉再点一次,id 完全一致 —— 两端 INSERT OR IGNORE 靠它去重', async () => {
    const first = render(<AiDrawer {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: /做成复习卡/ }))
    await waitFor(() => expect(screen.getByText(/本次新增/)).toBeTruthy())
    const ids = cardsAddRequest().cards.map((card) => card.id)
    first.unmount()
    invokeMock.mockClear()

    render(<AiDrawer {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: /做成复习卡/ }))
    await waitFor(() => expect(screen.getByText(/本次新增/)).toBeTruthy())
    expect(cardsAddRequest().cards.map((card) => card.id)).toEqual(ids)
  })

  it('空概念数组不渲染入口,也不发空请求(zod 要求 cards.min(1))', async () => {
    conceptPayload = { concepts: [] }
    render(<AiDrawer {...PROPS} />)
    await screen.findByText('核心概念')
    expect(screen.queryByRole('button', { name: /做成复习卡/ })).toBeNull()
    expect(invokeMock.mock.calls.some(([command]) => command === 'cards.add')).toBe(false)
  })

  it('写库失败时显示错误且入口仍在,可重试', async () => {
    invokeMock.mockImplementation(
      asNeverImplementation((command, request) =>
        command === 'cards.add'
          ? Promise.reject(new Error('磁盘已满'))
          : Promise.resolve(respond(command, request)),
      ),
    )
    render(<AiDrawer {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: /做成复习卡/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('磁盘已满')
    expect(screen.getByRole('button', { name: /做成复习卡/ })).toBeTruthy()
  })
})

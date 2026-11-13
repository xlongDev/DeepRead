// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LearningCard } from '@deepread/shared'
import { invokeCommand } from '../../lib/ipc'
import { cardsToAnkiCsv, LearningDrawer } from './LearningDrawer'

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  invokeStreamingCommand: vi.fn(),
  isTauriRuntime: (): boolean => true,
}))

const invokeMock = vi.mocked(invokeCommand)

const card = (front: string, back: string): LearningCard => ({
  id: front,
  bookHash: 'h',
  front,
  back,
  source: 'highlight',
  cfi: null,
  ease: 2.5,
  intervalDays: 0,
  reps: 0,
  lapses: 0,
  dueAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-09-30T00:00:00Z',
})

const ONE_CARD = card('什么是灯?', '「灯」是全书的\n核心意象')

const PROPS = {
  bookHash: 'h',
  bookTitle: '认知觉醒',
  annotations: [],
  getChapterText: async (): Promise<string> => '正文',
  onClose: vi.fn(),
}

let removed = false

beforeEach(() => {
  removed = false
  invokeMock.mockReset()
  invokeMock.mockImplementation(((command: string): Promise<unknown> => {
    if (command === 'cards.remove') {
      removed = true
      return Promise.resolve({ removed: true })
    }
    if (command === 'cards.list') return Promise.resolve({ cards: removed ? [] : [ONE_CARD] })
    if (command === 'ai.config.list') return Promise.resolve({ providers: [] })
    return Promise.resolve(undefined)
  }) as never)
})

afterEach(cleanup)

describe('cardsToAnkiCsv(Anki 兼容导出)', () => {
  it('两列输出,逗号与引号按 CSV 规则转义,空正面跳过', () => {
    // 引号字段里的换行是合法 CSV(跨物理行),所以整串断言而不是 split。
    expect(
      cardsToAnkiCsv([
        card('什么是灯?', '「灯」是全书的\n核心意象'),
        card('他说, "走吧"', ' quote " 测试 '),
        card('  ', '空正面跳过'),
      ]),
    ).toBe('什么是灯?,"「灯」是全书的\n核心意象"\n"他说, ""走吧"""," quote "" 测试 "\n')
  })

  it('空列表产出空文件(只有行尾)', () => {
    expect(cardsToAnkiCsv([])).toBe('\n')
  })
})

describe('复习页删除卡片(AI 产物写库后仍可撤销)', () => {
  it('点删除走 cards.remove,并刷新到空态', async () => {
    render(<LearningDrawer {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: '删除卡片' }))
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([command]) => command === 'cards.remove')
      expect(call?.[1]).toEqual({ id: ONE_CARD.id })
    })
    await waitFor(() => expect(screen.getByText(/还没有卡片/)).toBeTruthy())
  })
})

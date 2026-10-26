// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { LearningCard } from '@deepread/shared'
import { cardsToAnkiCsv } from './LearningDrawer'

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

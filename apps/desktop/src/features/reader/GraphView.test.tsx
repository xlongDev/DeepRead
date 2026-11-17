// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GraphView } from './GraphView'
import type { GraphSpec } from '@deepread/ai-core'

afterEach(cleanup)

const POPULATED: GraphSpec = {
  kind: 'characters',
  payload: {
    characters: [
      {
        name: '夜航',
        aliases: [],
        role: '主角',
        description: '灯塔看守人。',
        relationships: [{ with: '灯塔', type: '守护' }],
      },
      {
        name: '灯塔',
        aliases: [],
        role: '配角',
        description: '不说话的那一个。',
        relationships: [],
      },
    ],
  },
}

const EMPTY: GraphSpec = { kind: 'characters', payload: { characters: [] } }

describe('GraphView', () => {
  it('空图谱给明确引导,不出空白画布', () => {
    render(<GraphView spec={EMPTY} onClose={() => {}} />)
    expect(screen.getByText('还没有可绘图的角色,先抽取角色。')).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('有节点时渲染成可读的 SVG:名字进无障碍标签', () => {
    render(<GraphView spec={POPULATED} onClose={() => {}} />)
    const svg = screen.getByLabelText('角色关系图:夜航、灯塔')
    expect(svg).toBeDefined()
  })

  it('悬空关系如实交代条数,不让用户猜缺了谁', () => {
    const dangling: GraphSpec = {
      kind: 'characters',
      payload: {
        characters: [POPULATED.payload.characters[0]!],
      },
    }
    render(<GraphView spec={dangling} onClose={() => {}} />)
    expect(screen.getByText('1 条关系指向未抽取到的角色,未绘制。')).toBeDefined()
  })

  it('导出 SVG 走 Blob 下载,文件名带 kind', () => {
    const createObjectURL = vi.fn(() => 'blob:graph')
    const revokeObjectURL = vi.fn()
    ;(window as unknown as Record<string, unknown>).URL = {
      createObjectURL,
      revokeObjectURL,
    }
    const click = vi.fn()
    const originalCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'a') {
        return { href: '', download: '', click } as unknown as HTMLAnchorElement
      }
      return originalCreate(tag)
    }) as typeof document.createElement)

    try {
      render(<GraphView spec={POPULATED} onClose={() => {}} />)
      fireEvent.click(screen.getByTitle('导出 SVG'))
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:graph')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('关闭键回父层,不是自己卸载自己', () => {
    const onClose = vi.fn()
    render(<GraphView spec={EMPTY} onClose={onClose} />)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

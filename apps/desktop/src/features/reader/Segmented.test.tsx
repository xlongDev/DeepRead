// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Segmented } from './Segmented'

afterEach(cleanup)

describe('Segmented 弹性滑块', () => {
  it('渲染滑块并跟随 is-active 档位(容器带 segmented-animated)', () => {
    const { container } = render(
      <Segmented>
        <button type="button">紧凑</button>
        <button type="button" className="is-active">
          标准
        </button>
      </Segmented>,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toBe('segmented segmented-animated')
    // jsdom 无布局:offset* 恒 0,但滑块元素必须存在。滑块在 children 之前,
    // 按钮后画在上层,文字才压得住滑块。
    const thumb = root.querySelector<HTMLElement>('.segmented-thumb')
    expect(thumb).not.toBeNull()
    expect(root.firstElementChild).toBe(thumb)
  })

  it('没有 is-active 档位时不渲染滑块(动作按钮组照常用)', () => {
    const { container } = render(
      <Segmented>
        <button type="button">检查</button>
      </Segmented>,
    )
    expect(container.querySelector('.segmented-thumb')).toBeNull()
  })
})

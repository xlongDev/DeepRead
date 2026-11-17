// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmButton } from './ConfirmButton'

afterEach(cleanup)

describe('ConfirmButton', () => {
  it('两击才执行,一击只进待确认态', () => {
    const onConfirm = vi.fn()
    render(<ConfirmButton label="移出书架" confirmLabel="确认移除 2 本?" onConfirm={onConfirm} />)

    const click = (): boolean => fireEvent.click(screen.getByRole('button'))
    click()
    // 第一击:文案换成确认语、标红,但不执行。
    expect(screen.getByRole('button').className).toContain('is-danger')
    expect(screen.getByRole('button').textContent).toBe('确认移除 2 本?')
    expect(onConfirm).not.toHaveBeenCalled()

    click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // 执行后回到常态,连续再点又是新一轮确认。
    expect(screen.getByRole('button').textContent).toBe('移出书架')
    click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('失焦解除待确认态:点空白后下一击不是死亡一击', () => {
    const onConfirm = vi.fn()
    render(<ConfirmButton label="从云端恢复" confirmLabel="确认覆盖本机?" onConfirm={onConfirm} />)

    const button = screen.getByRole('button')
    fireEvent.click(button)
    fireEvent.blur(button)
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button.textContent).toBe('确认覆盖本机?')

    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

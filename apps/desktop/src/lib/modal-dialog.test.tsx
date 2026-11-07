import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useDrawerFocus, useModalFocus } from './modal-dialog'

/**
 * 模态弹窗的真实挂载形态:整棵组件随开关挂载/卸载(LibraryScreen 就是
 * `{editBook !== null && <BookInfoDialog/>}`)。夹具照抄这个形态,先点来源
 * 按钮再开弹窗,卸载后焦点必须回到来源。
 */

function Modal({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDialogElement>(null)
  useModalFocus(panelRef)
  return (
    <dialog ref={panelRef} open aria-modal="true" aria-label="测试弹窗">
      <button type="button" onClick={onClose}>
        第一项
      </button>
      <button type="button">第二项</button>
    </dialog>
  )
}

function Fixture() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        来源
      </button>
      {open && <Modal onClose={() => setOpen(false)} />}
    </>
  )
}

function Drawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  useDrawerFocus(panelRef)
  return (
    <aside ref={panelRef} aria-label="测试抽屉">
      <button type="button" onClick={onClose}>
        抽屉第一项
      </button>
      <button type="button">抽屉第二项</button>
    </aside>
  )
}

function DrawerFixture() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        抽屉来源
      </button>
      {open && <Drawer onClose={() => setOpen(false)} />}
    </>
  )
}

describe('useDrawerFocus(非模态抽屉)', () => {
  it('挂载时焦点进面板,卸载时还给来源', () => {
    render(<DrawerFixture />)
    const source = screen.getByText('抽屉来源')
    source.focus()
    fireEvent.click(source)
    expect(document.activeElement).toBe(screen.getByText('抽屉第一项'))
    fireEvent.click(screen.getByText('抽屉第一项'))
    expect(document.activeElement).toBe(source)
  })

  it('不圈 Tab:抽屉没有 aria-modal,Tab 不该被拦在面板里', () => {
    render(<DrawerFixture />)
    fireEvent.click(screen.getByText('抽屉来源'))
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

/** 真实形态:弹窗里常有一个由可见按钮 .click() 触发的隐藏 file input。 */
function HiddenInputModal() {
  const panelRef = useRef<HTMLDialogElement>(null)
  useModalFocus(panelRef)
  return (
    <dialog ref={panelRef} open aria-modal="true" aria-label="带隐藏输入的弹窗">
      <button type="button">可见第一项</button>
      <input type="file" className="visually-hidden" tabIndex={-1} aria-hidden="true" />
      <button type="button">可见最后一项</button>
    </dialog>
  )
}

function HiddenInputFixture() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        隐藏输入来源
      </button>
      {open && <HiddenInputModal />}
    </>
  )
}

describe('useModalFocus(模态弹窗键盘圈)', () => {
  it('隐藏 file input 不进焦点圈:初始焦点与 Tab 首尾都跳过它', () => {
    render(<HiddenInputFixture />)
    fireEvent.click(screen.getByText('隐藏输入来源'))
    const first = screen.getByText('可见第一项')
    const last = screen.getByText('可见最后一项')
    expect(document.activeElement).toBe(first)
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).tabIndex).toBe(-1)

    first.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('挂载时焦点落到面板内第一个可聚焦项', () => {
    render(<Fixture />)
    fireEvent.click(screen.getByText('来源'))
    expect(document.activeElement).toBe(screen.getByText('第一项'))
  })

  it('Tab 在面板内首尾循环,不会溜到背景', () => {
    render(<Fixture />)
    fireEvent.click(screen.getByText('来源'))
    const second = screen.getByText('第二项')
    second.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('第一项'))

    const first = screen.getByText('第一项')
    first.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(second)
  })

  it('关闭后焦点归还来源', () => {
    render(<Fixture />)
    const source = screen.getByText('来源')
    // jsdom 的程序化 click 不像真浏览器那样先聚焦;真用户点按钮时焦点就在它上。
    source.focus()
    fireEvent.click(source)
    // 「第一项」就是关闭按钮:点它关闭并归还焦点。
    fireEvent.click(screen.getByText('第一项'))
    expect(document.activeElement).toBe(source)
  })
})

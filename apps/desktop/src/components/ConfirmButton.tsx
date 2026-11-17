import { useState } from 'react'

/**
 * 二击确认按钮:第一击进待确认态(is-danger + 确认文案),第二击才执行。
 *
 * 破坏性动作的两击确认原先在书架单本移除、整批移出、云端恢复三处各写一份
 * 「state 哨兵 + 标签换文案 + is-danger」,哨兵还散在 LibraryScreen 外壳里
 * 与菜单/批量态互相纠缠。收进来之后 arm 态归按钮自己:失焦即解除(点空白、
 * 点别的按钮都回到首击),卸载自然消失,外壳不再需要替它记状态。
 */
export function ConfirmButton({
  label,
  confirmLabel,
  className = 'btn',
  role,
  disabled,
  onConfirm,
}: {
  /** 平常态文案。 */
  label: React.ReactNode
  /** 待确认态文案(要说清后果,如「确认移除(进度与批注一并删除)」)。 */
  confirmLabel: React.ReactNode
  className?: string
  /** 语义角色(如书卡菜单里的 menuitem)。 */
  role?: React.HTMLAttributes<HTMLButtonElement>['role']
  disabled?: boolean
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)
  return (
    <button
      type="button"
      role={role}
      className={armed ? `${className} is-danger` : className}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}

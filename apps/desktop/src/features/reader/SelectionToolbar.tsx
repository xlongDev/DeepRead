/**
 * 划词工具「墨条」(InkBar):选中正文后浮出来的玻璃卡片。
 *
 * 两条带,各做一件事:
 *
 *   动作带 —— 对选中文本本身做的事:复制 / 词典 / 翻译 / 问 AI / 朗读 /
 *             书内搜索 / 记笔记 / 应用高亮 / 关闭
 *   墨带   —— 一个内嵌托盘:左边三选一样式(背景高亮 / 直线 / 波浪线),
 *             右边五色。点一下立刻应用,读者不用重新选词就能试组合
 *
 * 视觉语言与本应用其它 chrome 同族(见 `.chrome-button` / `.reader-top`):
 * 玻璃底、发丝边、透明图标钮、hover 染 accent、全局 press 缩放。墨带用
 * 一层内嵌表面把「选墨」和「动作」分开,比一条分隔线更像一个整体。
 *
 * 有 `annotation` 时进入编辑模式:动作带多一个删除,墨带重绘已有划线。
 * 记笔记在面板里就地展开 —— 想法写在正看着的段落旁边,不用去侧边浮层。
 *
 * 定位见 `selection-place.ts`:纯算术在那,这里只做测量(面板高度取决于
 * 内容)和写入 DOM。`top` 走 layout effect 直接写 style,不经过 state ——
 * 测量值只在 layout 之后存在,setState-in-effect 既被本仓禁令禁止,也会
 * 让面板在错位置先画一帧。
 *
 * 样式全部走 global.css 的真实类。本项目没有 Tailwind —— 曾经整版用过
 * 工具类,结果按钮退回浏览器默认灰底、尺寸全丢,别走回头路。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Check,
  Copy,
  Eraser,
  Highlighter,
  MagnifyingGlass,
  Note,
  SpeakerHigh,
  Sparkle,
  Translate,
  Trash,
  X,
} from '@phosphor-icons/react'

import type { AnnotationStyle } from '@deepread/reader-core'
import type { AnnotationRecord } from '@deepread/shared'
import {
  anchorFromRect,
  placeToolbarX,
  placeToolbarY,
  toolbarWidth,
  TOOLBAR_ENTRANCE_HEIGHT,
  TOOLBAR_GAP,
  windowFrame,
  type ReadingFrame,
} from './selection-place'
import { HIGHLIGHT_PALETTE, withAlpha } from './reader-options'

/** 墨水样式:与 Rust / zod / reader-core 三处同集合。 */
const STYLES: readonly { readonly key: AnnotationStyle; readonly label: string }[] = [
  { key: 'highlight', label: '背景高亮' },
  { key: 'underline', label: '直线' },
  { key: 'squiggly', label: '波浪线' },
]

/** 选中多长就不给查词典:词典问的是词,不是段落。 */
export const LOOKUP_MAX_CHARS = 40

/** wire/调用方传来的裸 style 串 → 三态。非法值按背景高亮(与 Rust 同约定)。 */
function toInkStyle(style: string): AnnotationStyle {
  return style === 'underline' || style === 'squiggly' ? style : 'highlight'
}

export interface SelectionToolbarProps {
  /** 选区框(宿主窗口坐标系)。 */
  readonly rect: { readonly top: number; readonly left: number; readonly height: number }
  /** 选中的文本。 */
  readonly text: string
  /** 编辑模式:点中的那条划线。null = 新建模式。 */
  readonly annotation: AnnotationRecord | null
  /** 读者上次用的墨水,让新选区画得可预期。 */
  readonly defaultColor: string
  readonly defaultStyle: AnnotationStyle
  readonly onCopy: () => void
  readonly onLookup: () => void
  readonly onTranslate: () => void
  readonly onAsk: () => void
  readonly onSpeak: () => void
  readonly onSearch: () => void
  readonly onHighlight: (color: string, style: AnnotationStyle) => void
  readonly onRestyle: (color: string, style: AnnotationStyle) => void
  /** 写(或传 null 清空)这条选区的笔记。 */
  readonly onNote: (note: string | null) => void
  readonly onDelete: () => void
  readonly onClose: () => void
}

export function SelectionToolbar({
  rect,
  text,
  annotation,
  defaultColor,
  defaultStyle,
  onCopy,
  onLookup,
  onTranslate,
  onAsk,
  onSpeak,
  onSearch,
  onHighlight,
  onRestyle,
  onNote,
  onDelete,
  onClose,
}: SelectionToolbarProps) {
  const [copied, setCopied] = useState(false)
  // 草稿墨水:下一次应用画什么。编辑模式从划线自身取值,新选区从读者上次的来。
  const [color, setColor] = useState(annotation?.color ?? defaultColor)
  const [style, setStyle] = useState<AnnotationStyle>(toInkStyle(annotation?.style ?? defaultStyle))
  // 笔记字段:null = 收起,string(含空串)= 展开。Esc 回滚,所以收起时触发的
  // blur 绝不能提交它刚丢掉的东西。
  const [draft, setDraft] = useState<string | null>(null)
  const rewound = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  /** 面板本体 —— 它的实测高度才是定位的真值。 */
  const panel = useRef<HTMLDivElement>(null)
  const noting = draft !== null
  const copiedTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    },
    [],
  )

  // 字段出现即聚焦(读者点「记笔记」要的就是它)。不用 autoFocus:a11y 规则
  // 禁的是页面加载场景,而它分不清这两者。光标落末尾,续写而不是倒着打。
  useEffect(() => {
    if (!noting) return
    const el = field.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [noting])

  /** 唯一的提交路径:焦点离开面板、关闭按钮、⌘/Ctrl+Enter 都汇到这。Esc 刻意
   *  不走这 —— 它经 `rewound` 关掉。没改过的草稿不写,这也是「清空一个不存在
   *  的笔记」是空操作而不是一次请求的原因。 */
  const commitNote = (): void => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next !== (annotation?.note ?? '').trim()) onNote(next === '' ? null : next)
  }

  const apply = (nextColor: string, nextStyle: AnnotationStyle): void => {
    if (annotation) onRestyle(nextColor, nextStyle)
    else onHighlight(nextColor, nextStyle)
  }

  const copy = (): void => {
    onCopy()
    setCopied(true)
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  // 水平定位:每次渲染都算(阅读区宽随窗口变)。垂直定位见下面的 layout effect。
  const frame: ReadingFrame =
    document.querySelector('[data-reading-content]')?.getBoundingClientRect() ??
    windowFrame(window.innerWidth, window.innerHeight)
  const width = toolbarWidth(frame)
  const left = placeToolbarX(frame, rect.left, width)
  // 入场从哪侧滑入:贴近真相即可(定位本身是测量的),差几像素只影响偏移方向。
  const above =
    rect.top + rect.height + TOOLBAR_GAP + TOOLBAR_ENTRANCE_HEIGHT >
    (frame.bottom ?? window.innerHeight)

  // 面板顶边,写进 DOM 而不是 state:见文件头。
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const live: ReadingFrame =
      document.querySelector('[data-reading-content]')?.getBoundingClientRect() ??
      windowFrame(window.innerWidth, window.innerHeight)
    const { top, above: landsAbove } = placeToolbarY(live, anchorFromRect(rect), el.offsetHeight)
    el.style.top = `${top}px`
    // 入场方向以测量结果为准,渲染时的近似只服务首帧之前的 CSS。
    el.dataset.placement = landsAbove ? 'above' : 'below'
  })

  return (
    <div
      ref={panel}
      className="selection-toolbar"
      data-testid="selection-toolbar"
      data-placement={above ? 'above' : 'below'}
      // role=toolbar 既是语义也是 a11y 要求:这个 div 带着 blur/mousedown
      // 处理器,静态元素配交互必须显式声明角色。tabIndex=-1 让面板成为 blur
      // 事件的可靠宿主(焦点从面板里的控件移出时才收笔记),又不占 Tab 顺序。
      role="toolbar"
      aria-label="划词工具"
      tabIndex={-1}
      // `top` 故意不写:取决于实测高度,由上面的 layout effect 写。
      style={{ left, width }}
      // 整个面板一个 blur handler:只有面板知道焦点是不是真的离开了它 ——
      // 在自己的控件之间走动保留草稿,而 Esc 关掉字段时绝不能提交刚回滚的内容。
      //
      // 面板里的 mousedown 一律 preventDefault(除 textarea):WebKit 不在
      // mousedown 时聚焦按钮,焦点落到 body,字段的 focusout 带
      // `relatedTarget: null` —— 守卫会读成「离开了面板」,于是笔记被提交、
      // 字段卸载、按钮的 click 永远不触发(Tauri 的 WKWebView 正是这个引擎,
      // 它让 保存/清空 变成死按钮)。按住焦点让两个引擎行为一致,而
      // focus-visible 只伺候键盘(Tab 从来不经过这条路),没有代价。
      onMouseDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('textarea')) return
        event.preventDefault()
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        if (rewound.current) {
          rewound.current = false
          setDraft(null)
          return
        }
        commitNote()
      }}
    >
      {/* 动作带:全宽一行 justify-between;阅读区比九个图标还窄时才换行。 */}
      <div className="selection-actions">
        <button type="button" aria-label="复制" className="sel-icon" onClick={copy} title="复制">
          {copied ? <Check size={17} className="sel-icon-accent" /> : <Copy size={17} />}
        </button>
        <button
          type="button"
          aria-label="词典查询"
          className="sel-icon"
          onClick={onLookup}
          title={
            text.trim().length <= LOOKUP_MAX_CHARS ? '查词典' : '选中的内容太长了,词典只收单词'
          }
          disabled={text.trim().length > LOOKUP_MAX_CHARS}
        >
          <BookOpen size={17} />
        </button>
        <button
          type="button"
          aria-label="翻译"
          className="sel-icon"
          onClick={onTranslate}
          title="翻译"
        >
          <Translate size={17} />
        </button>
        <button type="button" aria-label="问 AI" className="sel-icon" onClick={onAsk} title="问 AI">
          <Sparkle size={17} />
        </button>
        <button
          type="button"
          aria-label="朗读此处"
          className="sel-icon"
          onClick={onSpeak}
          title="朗读此处"
        >
          <SpeakerHigh size={17} />
        </button>
        <button
          type="button"
          aria-label="在本书中搜索"
          className="sel-icon"
          onClick={onSearch}
          title="在本书中搜索"
        >
          <MagnifyingGlass size={17} />
        </button>
        <button
          type="button"
          aria-label="记笔记"
          aria-expanded={noting}
          className={`sel-icon${noting ? ' is-on' : ''}`}
          onClick={() => {
            // 展开时带上已有笔记;再次点进来只发生在 blur 已提交之后,
            // commitNote 会把重复当空操作,不会写第二次。
            if (noting) setDraft(null)
            else setDraft(annotation?.note ?? '')
          }}
          title="记笔记"
        >
          <Note size={17} />
        </button>
        <button
          type="button"
          aria-label="应用当前高亮"
          className="sel-icon"
          onClick={() => apply(color, style)}
          title={`应用${STYLES.find((s) => s.key === style)?.label ?? ''}`}
        >
          <Highlighter size={17} />
        </button>
        {annotation && (
          <button
            type="button"
            aria-label="取消标注"
            className="sel-icon sel-icon-danger"
            onClick={onDelete}
            title="取消标注"
          >
            <Trash size={17} />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭"
          className="sel-icon sel-icon-quiet"
          onClick={() => {
            // 关面板是「写完了」不是「丢掉」:字段里的笔记在离开时落盘。Esc 是
            // 唯一不写的出路。
            commitNote()
            onClose()
          }}
          title="关闭"
        >
          <X size={17} />
        </button>
      </div>

      {/* 墨带:内嵌托盘。样式在左、颜色在右,边缘与动作带对齐 —— 一整块,
          而不是两条各自为政的横条。中间的发丝线把「形状」和「颜色」两种
          选择分开,两端之间的留白于是读作布局,而不是没画完。 */}
      <div className="selection-ink">
        <div className="selection-ink-group">
          {STYLES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-label={label}
              title={label}
              onClick={() => {
                setStyle(key)
                apply(color, key)
              }}
              className={`sel-style${style === key ? ' is-on' : ''}`}
            >
              <StyleSwatch kind={key} color={color} />
            </button>
          ))}
        </div>
        <span aria-hidden className="selection-ink-divider" />
        <div className="selection-ink-group">
          {HIGHLIGHT_PALETTE.map((option) => (
            <button
              key={option.color}
              type="button"
              aria-label={`${option.label}划线`}
              title={`${option.label}划线`}
              onClick={() => {
                setColor(option.color)
                apply(option.color, style)
              }}
              className={`sel-dot${color === option.color ? ' is-on' : ''}`}
              // 选中环必须是墨自己的颜色:把 hex 交给 CSS 的 currentColor,
              // 环由 box-shadow 画,不占布局。
              style={color === option.color ? { color: option.color } : undefined}
            >
              <span
                aria-hidden
                className="sel-dot-core"
                style={{ backgroundColor: option.color }}
              />
            </button>
          ))}
        </div>
      </div>

      {/* 笔记字段:独占墨带下面一行,写段落不遮住刚画出划线的那些控件。
          字段下的动作条让笔记不离场就能收尾:展开时只有点外面一条路,清空和
          删掉已有笔记则完全无路可走。 */}
      {draft !== null && (
        <div className="selection-note">
          <textarea
            ref={field}
            aria-label="笔记内容"
            rows={2}
            value={draft}
            placeholder="写下你的想法…(留空保存 = 只要划线)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // 只收字段,面板留着:读者是退一步,不是退出 —— 所以事件不到
                // 页面自己的 Esc 处理。
                event.stopPropagation()
                rewound.current = true
                event.currentTarget.blur()
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.blur()
              }
            }}
            className="note-input selection-note-input"
          />
          {/* 这些按钮没有一个手动关字段。面板内的按钮不会触发面板自己的 blur
              (那只在焦点离开整个面板时响),所以 保存 走的是 blur 同一条提交
              路径,字段卸载是因为 draft 变 null,不是谁把它拆了。 */}
          <div className="selection-note-actions">
            <NoteAction
              label="保存笔记"
              text="保存"
              // 字段还说着已存的内容 → 没改过就不写。
              disabled={draft.trim() === (annotation?.note ?? '').trim()}
              onClick={commitNote}
            >
              <Check size={13} />
            </NoteAction>
            <NoteAction
              label="清空输入"
              text="清空"
              disabled={draft === ''}
              // 只清字段:已存的笔记要等 保存 或离开面板才动。
              onClick={() => setDraft('')}
            >
              <Eraser size={13} />
            </NoteAction>
            {annotation?.note != null && (
              <NoteAction
                label="删除笔记"
                text="删除"
                danger
                onClick={() => {
                  // 只掉笔记,划线留着 —— 动作带里的 取消标注 才是两个都删的。
                  onNote(null)
                  setDraft(null)
                }}
              >
                <Trash size={13} />
              </NoteAction>
            )}
            <span className="selection-note-hint">⌘↵ 保存 · Esc 取消</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 笔记动作条上的一颗按钮。 */
function NoteAction({
  label,
  text,
  disabled = false,
  danger = false,
  onClick,
  children,
}: {
  readonly label: string
  readonly text: string
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`note-action${danger ? ' is-danger' : ''}`}
    >
      {children}
      {text}
    </button>
  )
}

/** 样式按钮里的预览:一抹底色、一条直线、一道波浪 —— 都用当前墨水的颜色画,
 *  所以这颗色板预览的是「这个组合」,不只是形状。 */
function StyleSwatch({ kind, color }: { readonly kind: AnnotationStyle; readonly color: string }) {
  if (kind === 'highlight') {
    return (
      <span
        aria-hidden
        className="sel-swatch-wash"
        style={{ backgroundColor: withAlpha(color, 0.62) }}
      />
    )
  }
  if (kind === 'underline') {
    return <span aria-hidden className="sel-swatch-line" style={{ borderColor: color }} />
  }
  return (
    <svg aria-hidden viewBox="0 0 16 4" className="sel-swatch-wave">
      <path d="M0 2 Q 2 0, 4 2 T 8 2 T 12 2 T 16 2" fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  )
}

/**
 * 库侧栏:三个目的地 + 我的分组 + 标签。
 *
 * 刻意不做「图书馆 / 书架 / 书柜」三层 —— 图书馆与书架是同一个集合,书柜由
 * 标签承担(标签系统已经存在,再发明一层分组只会制造两套真相)。侧栏只属于
 * 书架这一层;阅读器保持全屏沉浸,它有自己的抽屉。
 *
 * 「我的分组」是按进度与标签**现算**的视图,不需要用户维护任何东西;它与标签
 * 筛选可以叠加(两个条件同时满足才显示)。
 */

import { BookOpenText, ChartLineUp, Cloud, Gear, NoteBlank } from '@phosphor-icons/react'
import { isTauriRuntime } from '../../lib/ipc'
import { SlidingIndicator } from '../../components/SlidingIndicator'
import {
  coverPalette,
  goalCard,
  SMART_FILTERS,
  type LibraryView,
  type SmartFilter,
} from './shelf-view'

/**
 * 侧栏开关的图标:圆角面板 + 一条分隔线。
 *
 * 展开 = 分隔线在 1/3 处(左栏在);收起 = 线滑到贴着左缘(面板收拢)。
 * 动画就是这一条线的 transform —— 比两张图标交叉淡入干净,也省一张图。
 * 放在这里是因为 web 模式下品牌行要用它,桌面模式的固定按钮也用它。
 */
export function SidebarToggleIcon({ expanded }: { readonly expanded: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect
        x="2.4"
        y="3.4"
        width="15.2"
        height="13.2"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="7.6"
        y1="4.9"
        x2="7.6"
        y2="15.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="sidebar-toggle-divider"
        style={{
          transform: expanded ? 'translateX(0)' : 'translateX(-2.3px)',
          opacity: expanded ? 1 : 0.45,
        }}
      />
    </svg>
  )
}

export interface LibrarySidebarProps {
  readonly view: LibraryView
  readonly onView: (view: LibraryView) => void
  readonly shelfCount: number
  /** 没加载过就是 null:与其显示一个猜的数字,不如不显示。 */
  readonly notesCount: number | null
  /**
   * 今日阅读秒数。null = 统计还没取到,整块不渲染 —— 侧栏不摆猜出来的数字。
   * 与 `dailyMinutes`(0 = 没设目标)一起,由 goalCard() 折算成卡片的三个值。
   */
  readonly todaySeconds: number | null
  readonly dailyMinutes: number
  readonly smartFilter: SmartFilter
  readonly onSmartFilter: (filter: SmartFilter) => void
  readonly smartCounts: Readonly<Record<SmartFilter, number>>
  readonly tags: readonly string[]
  readonly activeTag: string | null
  /** 点当前已选中的标签 = 取消筛选。 */
  readonly onTag: (tag: string | null) => void
  readonly onOpenSync: () => void
  readonly onOpenSettings: () => void
  /** web 模式下开关住在品牌行右侧;桌面模式的开关钉在交通灯旁,不走这里。 */
  readonly onToggleSidebar: () => void
  readonly sidebarOpen: boolean
}

export function LibrarySidebar({
  view,
  onView,
  shelfCount,
  notesCount,
  todaySeconds,
  dailyMinutes,
  smartFilter,
  onSmartFilter,
  smartCounts,
  tags,
  activeTag,
  onTag,
  onOpenSync,
  onOpenSettings,
  onToggleSidebar,
  sidebarOpen,
}: LibrarySidebarProps) {
  const web = !isTauriRuntime()
  const rail = !sidebarOpen
  return (
    <aside className={`lib-sidebar${rail ? ' is-rail' : ''}`} aria-label="主导航">
      {/* 顶部留一条与交通灯等高的空档:交通灯是原生控件,浮在这一块上,
          品牌因此落在它下面。拖窗口由 .window-drag 统一负责(侧栏收起时也在)。 */}
      <div className="lib-sidebar-top" aria-hidden />
      <div className="lib-brand" data-tauri-drag-region>
        <span className="library-mark" aria-hidden>
          <BookOpenText size={16} weight="fill" />
        </span>
        <span className="library-brand">DeepRead</span>
        {/* web 端没有交通灯,开关按 deepseek 的方式住进品牌行右侧;
            桌面端它钉在交通灯旁,由 LibraryScreen 渲染,这里不出现。 */}
        {/* rail 态品牌行整行隐藏,这里再渲染一颗按钮只会留下一个看不见的
            同名 aria-label;展开由左上角浮钮负责。 */}
        {web && sidebarOpen && (
          <button
            type="button"
            className="sidebar-toggle is-web-inline"
            onClick={onToggleSidebar}
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={sidebarOpen}
            title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          >
            <SidebarToggleIcon expanded={sidebarOpen} />
          </button>
        )}
      </div>
      <SlidingIndicator
        as="nav"
        activeKey={view}
        className="lib-sidebar-nav"
        ariaLabel="视图"
        activeSelector="button.is-active"
      >
        {/* rail 态把文字 display:none 会让它一并退出可访问树,所以这里补
            aria-label + title:图标按钮不能没有名字。展开态不设,读屏照旧
            连计数一起读(「书架 35」)。 */}
        <button
          type="button"
          className={`lib-sidebar-item${view === 'shelf' ? ' is-active' : ''}`}
          aria-current={view === 'shelf' ? 'page' : undefined}
          aria-label={rail ? '书架' : undefined}
          title={rail ? '书架' : undefined}
          onClick={() => onView('shelf')}
        >
          <BookOpenText size={16} weight="regular" aria-hidden />
          <span className="lib-sidebar-text">书架</span>
          <span className="lib-sidebar-count">{shelfCount}</span>
        </button>
        <button
          type="button"
          className={`lib-sidebar-item${view === 'notes' ? ' is-active' : ''}`}
          aria-current={view === 'notes' ? 'page' : undefined}
          aria-label={rail ? '笔记' : undefined}
          title={rail ? '笔记' : undefined}
          onClick={() => onView('notes')}
        >
          <NoteBlank size={16} weight="regular" aria-hidden />
          <span className="lib-sidebar-text">笔记</span>
          {notesCount !== null && <span className="lib-sidebar-count">{notesCount}</span>}
        </button>
        <button
          type="button"
          className={`lib-sidebar-item${view === 'stats' ? ' is-active' : ''}`}
          aria-current={view === 'stats' ? 'page' : undefined}
          aria-label={rail ? '统计' : undefined}
          title={rail ? '统计' : undefined}
          onClick={() => onView('stats')}
        >
          <ChartLineUp size={16} weight="regular" aria-hidden />
          <span className="lib-sidebar-text">统计</span>
        </button>
      </SlidingIndicator>

      <p className="lib-sidebar-label">我的分组</p>
      {/* 筛选是状态,不是位置:整页只留一处灰底 + accent 竖条(见 is-filter 规则)。 */}
      <SlidingIndicator
        activeKey={smartFilter}
        className="lib-sidebar-nav is-filter"
        activeSelector="button.is-active"
      >
        {SMART_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={`lib-sidebar-item${filter.id === smartFilter ? ' is-active' : ''}`}
            aria-pressed={filter.id === smartFilter}
            onClick={() => onSmartFilter(filter.id)}
          >
            {filter.label}
            <span className="lib-sidebar-count">{smartCounts[filter.id]}</span>
          </button>
        ))}
      </SlidingIndicator>

      {tags.length > 0 && (
        <>
          <p className="lib-sidebar-label">
            标签
            {activeTag !== null && (
              <button type="button" className="lib-sidebar-clear" onClick={() => onTag(null)}>
                清除
              </button>
            )}
          </p>
          <div className="lib-sidebar-tags">
            {tags.map((tag) => {
              // 与封面同一套确定性配色:同一个标签永远是同一个颜色。
              const [tint] = coverPalette(tag)
              const active = activeTag === tag
              return (
                <button
                  key={tag}
                  type="button"
                  className="lib-sidebar-item is-tag"
                  aria-pressed={active}
                  onClick={() => onTag(active ? null : tag)}
                >
                  <span className="lib-sidebar-dot" style={{ background: tint }} aria-hidden />
                  {tag}
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* 目标卡 + 底部操作区合成一块沉底:目标卡才会正好贴在发丝线上方,
          而不是留在分组下面、和底部按钮之间空一大截。窄窗口下 CSS 让这个
          容器 display:contents,子元素回到侧栏的横排里。 */}
      <div className="lib-sidebar-bottom">
        {/* 今日阅读目标卡:细进度条 + 两个数,贴着底部操作区,像书签一样"在那儿"。
          统计没取到就整块不渲染;没设目标时退回一行字。点它进统计页 ——
          目标的主居所在那儿,这张卡是它的常驻入口。 */}
        {todaySeconds !== null &&
          (dailyMinutes > 0 ? (
            <button
              type="button"
              className="lib-sidebar-goal"
              onClick={() => onView('stats')}
              title="查看阅读统计"
            >
              {(() => {
                const card = goalCard(todaySeconds, dailyMinutes)
                return (
                  <>
                    <span className="lib-goal-head">
                      <span className="lib-goal-today">{card.today}</span>
                      {card.target !== null && (
                        <span className="lib-goal-target">{card.target}</span>
                      )}
                    </span>
                    {card.pct !== null && (
                      <span className="lib-goal-track" aria-hidden>
                        <span className="lib-goal-fill" style={{ width: `${card.pct * 100}%` }} />
                      </span>
                    )}
                  </>
                )
              })()}
            </button>
          ) : (
            <button
              type="button"
              className="lib-sidebar-goal is-plain"
              onClick={() => onView('stats')}
              title="查看阅读统计"
            >
              {goalCard(todaySeconds, dailyMinutes).today}
            </button>
          ))}

        <div className="lib-sidebar-foot">
          {/* 云同步 = WebDAV 配置 + 系统钥匙串保管密码,浏览器里两样都没有,
              点开只会得到一句「运行时不可用」;web 端不摆这个入口。 */}
          {!web && (
            <button
              type="button"
              className="lib-sidebar-item"
              aria-label={rail ? '云同步' : undefined}
              title={rail ? '云同步' : undefined}
              onClick={onOpenSync}
            >
              <Cloud size={16} weight="regular" aria-hidden />
              <span className="lib-sidebar-text">云同步</span>
            </button>
          )}
          <button
            type="button"
            className="lib-sidebar-item"
            aria-label={rail ? '设置' : undefined}
            title={rail ? '设置' : undefined}
            onClick={onOpenSettings}
          >
            <Gear size={16} weight="regular" aria-hidden />
            <span className="lib-sidebar-text">设置</span>
          </button>
        </div>
      </div>
    </aside>
  )
}

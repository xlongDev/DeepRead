/**
 * 排版设置(阅读设置的「排版」页):阅读背景、原书排版总开关、自定义档位组
 * (行距/段距/缩进/字重/方向)、字号与页边距、字体(内置 + 自定义导入)、
 * 简繁转换与词典。从 ReaderScreen 拆出的纯展示件 —— 排版状态本身是宿主的
 * `typography` 单一对象,唯一变更入口 updateLayout(patch) 以 prop 传入;
 * 换主题的落库与内核下发也在宿主回调里。
 *
 * 外壳(玻璃面板、页签、滚动区)归宿主,本件只负责这一页的内容。原先它和
 * 「显示设置」各占一颗顶栏键,一个叫排版一个叫显示,读者分不清哪个装了什么
 * —— 现在合成一个「阅读设置」面板,两页切换。
 */

import { Minus, Plus, Trash, X } from '@phosphor-icons/react'
import type { DictionaryMeta, ReadingFont } from '@deepread/shared'
import type { ZhConvertVariant } from '@deepread/reader-core'
import { DropdownMenu } from '../../components/DropdownMenu'
import { Segmented } from './Segmented'
import type { TypographySettings, LayoutPatch } from './reader-options'
import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_DEFAULT,
  FONT_STACK_PREVIEW,
  FONT_WEIGHT_OPTIONS,
  LINE_HEIGHT_OPTIONS,
  PAGE_MARGIN_BLOCK_OPTIONS,
  PAGE_MARGIN_INLINE_OPTIONS,
  PARAGRAPH_MARGIN_OPTIONS,
  READER_THEMES,
  READER_THEME_GROUPS,
  TEXT_INDENT_OPTIONS,
  WRITING_MODE_OPTIONS,
  ZH_CONVERT_OPTIONS,
} from './reader-options'

interface SettingsPanelProps {
  readonly typography: TypographySettings
  readonly themeIndex: number
  /** 换阅读背景:落库与内核 setTheme 在宿主回调里。 */
  readonly onThemeChange: (index: number) => void
  readonly updateLayout: (patch: LayoutPatch) => void
  readonly changeFontSize: (delta: number) => void
  readonly customFonts: readonly ReadingFont[]
  readonly fontBusy: boolean
  readonly importReadingFont: () => Promise<void>
  readonly removeReadingFont: (name: string) => Promise<void>
  /** 当前用的字体是自定义导入(不在内置档里)时非空,给「删除字体」入口。 */
  readonly customFontInUse: string | null
  readonly zhConvert: ZhConvertVariant
  readonly changeZhConvert: (variant: ZhConvertVariant) => void
  readonly dictionaries: readonly DictionaryMeta[]
  readonly removeDictionary: (id: string) => Promise<void>
  readonly importDictionary: () => Promise<void>
  readonly panelProblem: string | null
  /** 阅读主题变量:转发给下拉菜单(portal 后要随身带)。 */
  readonly themeVars?: React.CSSProperties
}

export function SettingsPanel({
  typography,
  themeIndex,
  onThemeChange,
  updateLayout,
  changeFontSize,
  customFonts,
  fontBusy,
  importReadingFont,
  removeReadingFont,
  customFontInUse,
  zhConvert,
  changeZhConvert,
  dictionaries,
  removeDictionary,
  importDictionary,
  panelProblem,
  themeVars,
}: SettingsPanelProps) {
  return (
    <div className="settings-pane">
      {/* 主题:与正文同屏,换档立刻看得见。 */}
      <div className="settings-group">
        <span className="settings-group-label">阅读背景</span>
        {/* 按纸性分组,但按钮回传的仍是 READER_THEMES 的原下标 —— 那个数字
            是持久化值,分组只改展示顺序,不能动它。 */}
        <div className="reader-theme-groups">
          {READER_THEME_GROUPS.map((group) => (
            <div className="reader-theme-group" key={group.label}>
              <span className="reader-theme-group-label">{group.label}</span>
              <div className="reader-theme-row">
                {group.indices.map((index) => {
                  const option = READER_THEMES[index]!
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`reader-theme-swatch${themeIndex === index ? ' is-active' : ''}`}
                      style={{
                        background: option.theme.background,
                        color: option.theme.foreground,
                      }}
                      onClick={() => onThemeChange(index)}
                      aria-pressed={themeIndex === index}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 原书排版总开关(默认开):开着由书决定,关掉逐项重写。 */}
      <div className="settings-group">
        <button
          type="button"
          className={`settings-toggle${typography.originalLayout ? ' is-on' : ''}`}
          role="switch"
          aria-checked={typography.originalLayout}
          onClick={() => updateLayout({ originalLayout: !typography.originalLayout })}
          title={typography.originalLayout ? '关闭后逐项自定义排版' : '恢复这本书自己的排版'}
        >
          <span className="settings-toggle-label">原书排版</span>
          <span className="settings-toggle-track" aria-hidden>
            <span className="settings-toggle-thumb" />
          </span>
        </button>
        <p className="settings-hint">
          {typography.originalLayout
            ? '行距、段间距、缩进、字重与方向都用书自己的;字体仍可自选。'
            : '按下面的档位重写这本书的排版;任一档位还能单独选回「原书」。'}
        </p>
      </div>

      {/* 自定义排版:这几项在「原书排版」下由书决定,不开入口 —— 一排
          按不动的灰按钮只会让人以为坏了。关掉开关就整组出现。 */}
      {!typography.originalLayout && (
        <div className="settings-group">
          <span className="settings-group-label">正文</span>
          <div className="settings-stack">
            <div className="settings-row">
              <span className="settings-label">行距</span>
              <Segmented>
                {LINE_HEIGHT_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.lineHeight === option.value ? 'is-active' : ''}
                    onClick={() => updateLayout({ lineHeight: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
            <div className="settings-row">
              <span className="settings-label">段间距</span>
              <Segmented>
                {PARAGRAPH_MARGIN_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.paragraphMargin === option.value ? 'is-active' : ''}
                    onClick={() => updateLayout({ paragraphMargin: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
            <div className="settings-row">
              <span className="settings-label">段首缩进</span>
              <Segmented>
                {TEXT_INDENT_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.textIndent === option.value ? 'is-active' : ''}
                    onClick={() => updateLayout({ textIndent: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
            <div className="settings-row">
              <span className="settings-label">字重</span>
              <Segmented>
                {FONT_WEIGHT_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.fontWeight === option.value ? 'is-active' : ''}
                    style={{ fontWeight: option.cssWeight }}
                    onClick={() => updateLayout({ fontWeight: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
            <div className="settings-row">
              <span className="settings-label">排版方向</span>
              <Segmented>
                {WRITING_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={typography.writingMode === option.value ? 'is-active' : ''}
                    onClick={() => updateLayout({ writingMode: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </Segmented>
            </div>
          </div>
        </div>
      )}

      {/* 字号与两把边距:阅读舒适度,与是否「原书排版」无关。 */}
      <div className="settings-group">
        <span className="settings-group-label">页面</span>
        <div className="settings-stack">
          <div className="settings-row">
            <span className="settings-label">字号</span>
            <div className="segmented">
              <button
                type="button"
                className="chrome-button"
                onClick={() => changeFontSize(-1)}
                title="减小字号"
              >
                <Minus size={14} weight="regular" aria-hidden />
              </button>
              <span className="segmented-value">{typography.fontSize ?? FONT_SIZE_DEFAULT}px</span>
              <button
                type="button"
                className="chrome-button"
                onClick={() => changeFontSize(1)}
                title="增大字号"
              >
                <Plus size={14} weight="regular" aria-hidden />
              </button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">左右边距</span>
            <Segmented>
              {PAGE_MARGIN_INLINE_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={typography.pageMargin === option.value ? 'is-active' : ''}
                  onClick={() => updateLayout({ pageMargin: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </Segmented>
          </div>
          <div className="settings-row">
            <span className="settings-label">上下边距</span>
            <Segmented>
              {PAGE_MARGIN_BLOCK_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={typography.pageMarginBlock === option.value ? 'is-active' : ''}
                  onClick={() => updateLayout({ pageMarginBlock: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </Segmented>
          </div>
        </div>
      </div>

      {/* 字体独立于总开关:读哪本书都用自己的字体是阅读口味,不是「书的
          排版」—— 两种模式下都给入口,选「原书」才回到书自带的字体。 */}
      <div className="settings-group">
        <span className="settings-group-label">字体</span>
        <Segmented className="segmented-wrap">
          {FONT_FAMILY_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={typography.fontFamily === option.value ? 'is-active' : ''}
              style={
                option.value !== undefined && FONT_STACK_PREVIEW[option.value]
                  ? { fontFamily: FONT_STACK_PREVIEW[option.value] }
                  : undefined
              }
              onClick={() => updateLayout({ fontFamily: option.value })}
            >
              {option.label}
            </button>
          ))}
          {customFonts.map((font) => (
            <button
              key={font.id}
              type="button"
              className={typography.fontFamily === font.name ? 'is-active' : ''}
              onClick={() => updateLayout({ fontFamily: font.name })}
              title={`${font.name}(点按使用;长按列表删除)`}
            >
              {/* 名字长短由网格格子决定,超长交给 CSS 省略号(.segmented-wrap
                  > button);这里切片会切在中英混排的奇怪位置。 */}
              {font.name}
            </button>
          ))}
        </Segmented>
        <div className="font-custom-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void importReadingFont()}
            disabled={fontBusy}
          >
            <Plus size={14} weight="bold" aria-hidden />
            {fontBusy ? '导入中…' : '导入字体'}
          </button>
          {customFontInUse !== null && (
            <button
              type="button"
              className="btn btn-ghost font-remove"
              onClick={() => void removeReadingFont(customFontInUse)}
              title="删除当前使用的自定义字体"
            >
              <Trash size={14} aria-hidden /> 删除当前字体
            </button>
          )}
        </div>
      </div>

      <div className="settings-group">
        <span className="settings-group-label">文字与词典</span>
        <div className="settings-stack">
          <div className="settings-row">
            <span className="settings-label">简繁转换</span>
            {/* 二级菜单:9 档全展开会占掉半个面板(还会把字体行挤出视口),
                触发器只显示当前档位,点开才是完整列表。 */}
            <DropdownMenu
              value={zhConvert}
              options={ZH_CONVERT_OPTIONS}
              onChange={changeZhConvert}
              ariaLabel="简繁转换"
              title="转换正文与目录;切换后重新打开本书生效"
              themeVars={themeVars}
            />
          </div>
          {dictionaries.map((dictionary) => (
            <div key={dictionary.id} className="settings-row dictionary-row">
              <span className="settings-label">
                {dictionary.name} · {dictionary.wordCount}
              </span>
              <button
                type="button"
                className="chrome-button"
                onClick={() => void removeDictionary(dictionary.id)}
                title="移除词典"
              >
                <X size={14} weight="regular" aria-hidden />
              </button>
            </div>
          ))}
          <div className="settings-row">
            <span className="settings-label">导入词典</span>
            <div className="segmented">
              <button type="button" onClick={() => void importDictionary()}>
                选择 .ifo
              </button>
            </div>
          </div>
        </div>
      </div>
      {panelProblem !== null && (
        <p className="lookup-empty" role="alert">
          {panelProblem}
        </p>
      )}
    </div>
  )
}

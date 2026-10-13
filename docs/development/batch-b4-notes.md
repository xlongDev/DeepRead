# B4 批次小结(2026-10-13)

批注体验:多色划线 / 划线即写笔记 / 阅读器内批注列表面板。**纯前端批次 —— 零迁移、
零协议变更、零新依赖**(核心事实:`annotations` 表已有 `color TEXT NOT NULL` +
`note TEXT`,协议 `annotationSchema` 的 color/note 都是自由字段,前端只是终于开始用它们)。

## 落地内容

### 4.1 多色划线

- 色板常量 `HIGHLIGHT_PALETTE`(5 档:黄/绿/蓝/粉/紫)落在 `reader-options.ts`,
  与既有 `HIGHLIGHT_COLOR` 同处 —— 划线的"源色"本来就归这个文件管,不新建 tokens 模块。
- **不需要 ADR-0006 的备选方案**:`reader-adapter` 早已在 `draw-annotation` 里把
  `annotation.color` 透传给内核(`draw(Overlayer.highlight, { color })`),foliate-js 1.0.1
  支持 per-annotation 颜色。计划里那条"内核不支持就分组建注 + iframe 注入 CSS"的风险已消解。
- 色值亮度刻意对齐:内核用 `Overlayer.highlight` 以 `opacity .3` 铺 SVG,高饱和色压出来
  会一边重一边轻,五档必须同亮度才好在同一页并存。
- 选区工具栏由「复制 / 划线 / 查词典」改为「复制 / 五色板 / 写笔记 / 查词典」;
  单个"划线"按钮删掉 —— 第一档色板就是它。

### 4.2 划线即写笔记

- 一个 `NoteEditor`(同文件内的小组件)覆盖两条路:选区 → 浮层编辑器;批注列表/已点中的
  划线 → 行下内联编辑器。摘录回显 + 色板(下笔时可改色)+ 文本域(4000 字上限,与
  `reader.note.update` 的 zod 一致)+ 取消/保存,⌘/Ctrl+Enter 提交。
- 存到该批注的 `note` 字段;**空串保存 = 真的删掉 note 键**(`delete stripped.note`),
  回退成纯高亮 —— 只摊平 `{ note: '' }` 会把旧笔记留在记录里。
- 无需新命令:批注本来就走 `reader.state.set` 的 annotations 数组。

### 4.3 批注列表面板

- 目录侧栏加「目录 / 批注」页签(批注页签显示条数),批注段再按「本章 / 全书」切换。
- 条目 = 色点 + 摘录 + 笔记预览,点击经 CFI 跳回原文;行内编辑 / 删除。
- **「本章」的判定用 CFI 前两段**(`epubcfi(/6/4…`):同一次 `getCFI(index, …)` 产出的
  CFI 共享这个前缀,所以不新增内核 API 也能分章。解析不出来(非 EPUB 形状)就退回全书,
  好过给一个错的。

## 验收对照

| 验收项(计划 §B4)                         | 结果                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 门禁全绿(pnpm verify + 四条 cargo 门禁)  | ✅ lint/format/typecheck/test(227+)/build 全绿;本批零 Rust 改动,cargo 侧无影响                 |
| `ReaderScreen.test.tsx` 契约扩展         | ✅ 新增 7 例(五色板→内核、笔记新建/留空、列表跳转、改笔记与清空、本章过滤、删除留墓碑)共 32 例 |
| web parity                               | ✅ IndexedDB shape 本就含 color/note,`web-handlers` 零改动;`smoke:web` 回归见下                |
| 真书验证:EPUB 五色划线 + 笔记 + 重开恢复 | **未执行**(本机无真书会话),见下                                                                |

## 真书验证

**未执行。** 缺的是一次带真书的端到端会话(五色划线 → 完全退出重开 → WebDAV 同步后另一端
颜色/笔记一致)。替代覆盖:上述 7 例契约测试锁住了"色值/笔记/墓碑/CFI 跳转/章节过滤"的全部
数据面,剩下的只是内核绘制与同步搬运 —— 前者由 `Overlayer.highlight` 的 color 透传保证,
后者是既有 annotations 同步路径(未改动)。留待下次真机会话补记。

## 顺手修掉的两处

- 选区工具栏的按钮此前没有尺寸/去边框样式(浏览器默认按钮皮),一并给定 34px 圆形 +
  hover 态;触屏档位下色点 28px。
- `addHighlight` 包 `useCallback`:色板五个按钮在每次渲染都要复用同一句柄,否则 React
  Compiler 会把「渲染期间调用了含 `Date` 的函数」判成不确定性(lint `react(purity)` 红)。
  这里是真需要记忆化,不是绕过 lint。

## 测试增量

`ReaderScreen.test.tsx` +7 例(32 例全过),全库 227 例全过。

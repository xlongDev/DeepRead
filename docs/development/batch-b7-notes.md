# B7.1 图谱家族:时间线 + 概念(2026-10-13)

对应 `docs/plan-v0.3.md` §7.1 前半(§7.2 TXT 章节规则未做)。

## 做了什么

- **ai-core 纯逻辑**(各带单测):
  - `timeline.ts`:`timelineSchema`(events:`{event, chapterRef, descriptions[]}`,上限 60)、
    `buildTimelineMessages`、`parseTimeline`。prompt 明确要求 chapterRef 原样取自输入
    章节名、没有日期不要编造(小说走章节轴)。
  - `concepts.ts`:`conceptsSchema`(concepts:`{name, explanation, relations[]}`)、
    `buildConceptsMessages`、`parseConcepts`。面向非虚构。
  - `graph.ts` 泛化:`GraphSpec`(kind + payload,timeline 额外带 chapterLabels) →
    `buildGraph` 分发到 `buildTimelineGraph`/`buildConceptGraph`/`buildCharacterGraph`,
    三者共用 `{nodes, edges, dangling}` 形状;新增 `layoutTimeline`(横向轴,宽度随事件数
    增长,地板 1200);`graphSvgString` 按 `layout.kind` 分支:circle 画圆点(原样),
    timeline 画脊线 + 箭头 + 事件方框(章节名在上、事件名在中、细节在下,超长截断,
    全文进 `<title>`)。
  - `insights.ts` 把 `MAX_CHAPTERS`/`CHAPTER_EXCERPT_CHARS` 导出为
    `INSIGHT_MAX_CHAPTERS`/`INSIGHT_EXCERPT_CHARS`,timeline/concepts 复用;
    UI 的"发送范围"提示也读这两个常量,不硬编码第二份。
- **kind 枚举扩展**(协议变更,无双端 codegen——kind 是 TS zod enum + Rust match 的字符串并集):
  - Rust `validate_artifact_kind` 加 `timeline|concepts`,测试扩展到两种新 kind 的存取;
  - TS `artifactKindSchema` 同步扩展,protocol.test 加"六种 kind 全收、未知拒绝"一组。
- **GraphView 泛化**:props 从 `payload: CharactersPayload` 改为 `spec: GraphSpec`;
  标题/空态/导出文件名/dangling 文案按 kind 取(`VIEW_META`);初始 viewBox 取布局实际
  宽高(timeline 是宽版);缩放/拖拽/导出逻辑原样沿用。
- **AiDrawer**:洞察区生成按钮从 2 个变 4 个(摘要/大纲/时间线/概念);`generateInsight`
  重构为四路分发,持久化抽成 `persistArtifact`(characters 也改用它);**顺带补上 outline
  生成后从不展示的既有缺口**(之前点了"生成大纲"什么也不显示);时间线/概念各有一份列表
  渲染(与角色列表同式);图谱入口改成按已生成洞察动态出现(角色关系图/事件时间线/概念关系图),
  全部走同一个 `graphSpec` state + GraphView。

## 偏差与取舍

- 计划的"概念=环形簇"直接复用 `layoutCircle`(概念图本来就是环形),没有为"簇"单独做布局——
  YAGNI,等有真实数据证明需要分簇再说。
- 时间线的 `edges`(相邻事件连线)保留是为了 `{nodes, edges, dangling}` 形状统一;
  SVG 脊线实际按 `layout.positions` 顺序画,不读 edges。
- `chapterRef` 不在目录里的事件:不猜位置,排到最后并在 dangling 文案里如实说明
  (GraphView 的 meta.dangling 按 kind 给不同措辞)。

## 门禁

`pnpm verify` 全绿(desktop 252 / shared 81 / ai-core 86 / reader-adapter 52 /
reader-core 24 / design-system 8),`cargo test` 213 passed,fmt/clippy/check 干净,
无 codegen 漂移(kind 不走 ts-rs)。

## 未验证

真书上时间线/概念图的观感与"章节不在目录"的降级排版需桌面版会话确认(本机无 GUI 自动化)。

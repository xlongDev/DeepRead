# B7 图谱家族 + TXT 章节规则(2026-10-13/14)

对应 `docs/plan-v0.3.md` §7.1、§7.2。B7.1 见下,B7.2 见文末。

## B7.1 图谱家族:时间线 + 概念

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

---

## B7.2 TXT 章节规则

### 做了什么

- **ai-core `chapter-rules.ts`(纯逻辑 + 单测)**:`ChapterRule{id,name,pattern,priority,enabled}`;
  `BUILT_IN_CHAPTER_RULE`(复用 `rag.ts` 的内置正则,priority 0 作兜底);
  `validateChapterPattern`(空/超 200 字/编译失败/**嵌套无界量词**四道闸);
  `mergeChapterRules`(内置 + 用户规则按 priority 降序,稳定的同优先级保持列表序);
  `chapterMatcherFromRules` / `matchChapterRule`(给 adapter 分节用);
  `previewChapterRules`(每行只被第一条命中的规则认领,逐规则命中数 + 非法原因)。
- **AI 推断**:`buildChapterRuleMessages`(取样本前 40 行推断 `{name,pattern,priority}`,上限 5 条)
  - `parseChapterRuleCandidates`;候选是**草稿**,必须过同一套预览与校验才能保存。
- **协议 + 存储**(走 codegen 管线):Rust `chapter.rules.get/set` 落 `app_settings`
  KV(键 `chapter.rules`,JSON 数组,随备份 VACUUM INTO 走,零迁移),Rust 只做形状校验
  (条数 ≤20、字段非空、pattern ≤200 字);TS `chapterRuleSchema` 与之对齐;浏览器端分流
  localStorage。`lib/chapter-rules.ts` 里带一个**线型/逻辑型互为子类型的编译期断言**。
- **adapter**:`buildTextBook` 的 `chapterPattern` 换成 `chapterRules`(走 merge + matcher);
  `FoliateAdapter.rebuildChapters(rules)` 全量替换 `#chapterRules`,`null` = 只用内置规则。
  顺手删掉已成死代码的 `chapterTitleMatcher`(单正则入口)。
- **UI** `ChapterRulesPanel`:增删改(名/正则/优先级/启用)、**预览常驻**(逐规则命中数 +
  样本行高亮 + `[规则名]` 认领标记 + 共命中行数)、**任一规则非法则保存按钮禁用**、
  AI 候选以草稿出现需点「采用」、旧版 per-book 正则可一键导入(不静默丢弃)。
  ReaderScreen 在面板打开那次点击里取 60 行样本(ref 不能在 render 读)。

### 偏差与取舍

- **Rust 不编译用户正则**:pattern 只在 webview 执行,Rust 编译它没有意义,
  也不值得为这一点引 `regex` 依赖;正则合法性/回溯风险全部在 ai-core 判定。
- **嵌套量词检查是启发式**,且只拒"内外皆无界"的形状(`(a+)+` 拒、`(?:x{0,30})?` 放行)。
  宁可误拒少数安全写法,也不要一个卡死 UI 的正则;JS 没有正则超时,这是唯一防线。
- 计划写的"增删改排序"里的**排序**用 priority 数字输入框实现(合并顺序 = 优先级降序,
  预览按合并后顺序列出),没有另做上下移动按钮 —— priority 就是模型里的排序字段。
- 旧版 per-book `localStorage` 键:`applyChapterRules` 保存成功后才删除,面板打开期间
  显示"导入为规则"入口。

### 门禁

`pnpm verify` 全绿(desktop 255 / shared 83 / ai-core 102 / reader-adapter 52 /
reader-core 24 / design-system 8),`cargo test` 220 passed,fmt/clippy/check 干净,
4 个 ts-rs 生成物入 git。

### 未验证

真书(人名章节不规则的网文 TXT)上用自定义规则完成分节,需桌面版会话确认(本机无 GUI 自动化)。

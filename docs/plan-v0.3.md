# v0.3 全量实施计划(功能 12 项 + 优化 17 项)

> 生成于 2026-10-07,来源:全库四路侦察(前端 / Rust 后端 / packages / 文档与规划)。
> 原则不变:Reader First、No Fake Implementation、协议变更同步 `docs/architecture/protocol.md`、每批结束质量门禁全绿。
> 批次编号 B0-B9 只用于本计划,不与 README 的 Phase 0-8 及原规划 Sprint 1-16 混用。

## 0. 批次总览

| 批次 | 内容                                                                     | 规模(专注人日) | 依赖                 |
| ---- | ------------------------------------------------------------------------ | -------------- | -------------------- |
| B0   | 卫生与快修(去重 / 空包 / 吞错 / 错误码补齐)                              | 1              | 无                   |
| B1   | 前端性能批(TTS 渲染风暴 / 列表 / 封面加载)                               | 1.5            | 无                   |
| B2   | Rust 安全与性能批(共享 client / 缓存清理 / secret 移除 / XML / 二分)     | 1.5            | 无                   |
| B3   | 协议 Schema-first codegen + storage.rs 拆分 + 批量同步命令               | 3-4            | B0                   |
| B4   | 批注体验(多色划线 / 划线即笔记 / 批注列表面板)                           | 2-3            | 无                   |
| B5   | 多角色听书 UI + 划选翻译 + 繁简提案                                      | 2              | B1(TTS 契约测试先行) |
| B6   | 跨书搜索 + 阅读目标                                                      | 2-3            | B3(新增协议命令)     |
| B7   | 知识图谱家族 + TXT 章节规则                                              | 3-4            | B3                   |
| B8   | 有声书导出管线(轻量任务系统)                                             | 5-8            | B3                   |
| B9   | 生态大件:i18n / OPDS / 隐蔽阅读模式 / 性能监视器 / 移动端 / 测试盲区收尾 | 另计(见 §B9)   | B2(quick-xml 复用)   |

核心批次 B0-B8 合计 ≈ 21-28 人日。B1/B2/B4 相互独立,B3 之后的批次(除 B5)都走 codegen 管线。

> **进度(2026-10-07)**:B0 ✅ · B1 ✅ · B2 ✅ · **B3 ✅**(codegen / storage 拆分 / reader.state.getAll,小结见 `docs/development/batch-b3-notes.md`)· B4-B9 未开始。

依赖关系:

```text
B0 ──→ B3 ──→ B6 ──→ B7 ──→ B8
 │             └────→ B8
 ├─→ B1 ──→ B5
 ├─→ B2 ────────────→ B9(OPDS 复用 quick-xml)
 └─→ B4(独立)
```

---

## B0 · 卫生与快修(≈1 天,无行为变化)

目标:把分析出的所有"零风险清理"一次清掉,后续批次在干净地基上开工。

| #   | 事项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 改动点                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 0.1 | 删除 `packages/tts` 空壳(无 package.json、无 src,只有 node_modules 残留)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 目录删除 + pnpm-workspace 校对                          |
| 0.2 | lint 注释统一为 `oxlint-disable`(现混用 eslint-disable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `reader-adapter/src/engine.ts` 等处全局替换             |
| 0.3 | 去重一轮(全部有明确归属):① `aiProviderConfigSchema`/`aiChatRequestSchema` 从 `ai-core/src/config.ts` 单源导出,`shared/protocol/commands.ts` 改 import;② `extractJsonObject` 只保留 `insights.ts` 版,`characters.parseCharacters` 改复用;③ base64→Blob 两个变体合并为 `lib/blob.ts`;④ 两个下载帮助函数合并为 `lib/download.ts`;⑤ 标签规范化前后端两份镜像抽为 `shared/src/tags.ts` 单源(注释声明与 Rust `set_tags` 对齐);⑥ `TtsDrawer` 5 处"取消合成+暂停音频+清定时器"拆除块抽为 `useTtsTeardown` hook;⑦ `covers.ts::extractEpubCover` 内联 loader 改复用 `openEpub` | 各对应文件                                              |
| 0.4 | `ai.rs::load_providers` prepare 失败时静默返回空列表 → 错误上抛,设置页显示"Provider 配置读取失败 + 原因"                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src-tauri/src/ai.rs` + `AiProviderSettings.tsx` 错误态 |
| 0.5 | TS `ErrorCodes` 补齐 `STORAGE_IO`/`STORAGE_CORRUPT`(Rust 枚举 13 条 vs TS 11 条,漂移已发生)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/shared/src/errors.ts` + 镜像测试              |
| 0.6 | 小修:`text-repair.ts::applyRepair` 未用参数 `void changes`;`reader-core/src/types.ts` 残留重复 doc 注释与 `'heitı'` 拼写                                                                                                                                                                                                                                                                                                                                                                                                                                             | 各对应文件                                              |

**验收**:`pnpm verify` + 四条 cargo 门禁全绿;`git grep eslint-disable` 为零;`cargo test` 含 storage/integration 全过。

---

## B1 · 前端性能批(≈1.5 天)

目标:消除用户可感知的卡顿点。全部为行为保持型优化。

| #   | 事项                                                                                                                                                                                                                  | 方案                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1.0 | **前置:给 `TtsDrawer` 补契约测试**(改它之前先有网;fake 引擎下:播放/暂停/切句/切章/取消、`setRate stopped 守卫` 行为锁定)                                                                                              | `TtsDrawer.test.tsx`,复用 `test/fake-foliate.ts` 模式                                                                 |
| 1.1 | **TTS 60ms 渲染风暴**:`TtsDrawer` 的 `setInterval(setCharPos, 60)` 让整个抽屉(含数百项无 memo 句子列表)每 60ms 重渲染                                                                                                 | 字符高亮改为 ref 直写 DOM(更新范围收窄到当前句高亮 span);句子列表行 memo 化;60ms ticker 只写 ref + 请求节流的一帧提交 |
| 1.2 | 列表性能:目录树、TTS 句子列表、笔记列表、搜索结果加 CSS `content-visibility: auto` + `contain-intrinsic-size`(零新依赖,不引虚拟化库;若实测不够再评估 react-window,走 ADR-0001)                                        | `global.css` + 对应列表容器                                                                                           |
| 1.3 | `LibraryScreen` 封面/元数据 effect 逐本串行 await + 每本一次 `setCovers` → 并发化 + 按批合并 setState(模块缓存保留)                                                                                                   | `LibraryScreen.tsx`                                                                                                   |
| 1.4 | `sha256Hex` 整文件进内存(浏览器备份路径,ponytail 已标记):`packages/shared` 新增增量 SHA-256 纯函数模块(带标准测试向量:空串 / `abc` / 跨 64 字节边界 / 1MB 随机数据对齐 SubtleCrypto 结果),`web-store.ts` 分块读取计算 | `shared/src/hash.ts` + `web-store.ts`                                                                                 |

**验收**:门禁全绿;`TtsDrawer.test.tsx` 通过且播放期间(开发者工具 Performance)抽屉重渲染频率从 ~16fps 降到每句一次;书架 100 本 fixtures 导入时封面加载只触发 O(1) 次状态提交。

---

## B2 · Rust 安全与性能批(≈1.5 天)

| #   | 事项                                                                                                                                                                                                                  | 方案                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 2.1 | **共享 reqwest client + 显式超时**:`ai.rs`/`tts.rs`/`edge_tts.rs` 每调用 `reqwest::Client::new()` 且无超时(对比 `cloud.rs:243` 有 60s) → `OnceLock<Client>` 共享(连接池复用),连接/总超时显式设置;上游挂起不再挂住任务 | 三个文件 + Rust 单测(超时配置存在性)                                                          |
| 2.2 | **TTS 缓存清理**:`tts-cache/` 目前只增不减 → 启动时 + 每日一次:按 mtime LRU 清理至总容量上限(默认 2GB,`app_settings` 可调);删除前记录日志                                                                             | `src-tauri/src/tts.rs` + 设置项透出                                                           |
| 2.3 | **移除 `secret.get`**:前端零消费方(密钥仅在 Rust 侧被 AI/WebDAV/Edge 客户端使用),协议面收窄 = 直接删命令;保留 `secret.set`/`secret.delete`;协议文档同步 + PROTOCOL_VERSION 语义注明                                   | `secrets.rs`、`lib.rs` 注册表、`shared/protocol/commands.ts`、`docs/architecture/protocol.md` |
| 2.4 | **PROPFIND 解析换 quick-xml**:手写字符串扫描 `d:href` 在 `D:` 命名空间前缀的 WebDAV 服务器上会解析失败 → quick-xml 命名空间无关提取所有 `{*}href`;"找最新备份"逻辑不变                                                | `cloud.rs` + 新增单测(两种命名空间样例 XML)                                                   |
| 2.5 | **StarDict 二分查找**:O(n) 线性扫描 → 首查时构建排序索引(词条+offset),二分;`stardict.ts` 现有测试保持全绿                                                                                                             | `reader-adapter/src/dictionary/stardict.ts`                                                   |
| 2.6 | asset protocol scope 复核:fonts/covers/tts-cache 三目录 `allow_directory`(递归)收窄为按需(cover 目录若可精确到文件则精确),能收则收,不能收则在 `docs/security-audit.md` 记录理由                                       | `lib.rs`                                                                                      |

**验收**:门禁全绿;`cargo test` 含新 XML 样例;手动验证:断网状态下触发 `ai.chat` 3 秒内返回超时错误(而非永久挂起);`docs/architecture/protocol.md` 已更新。

---

## B3 · 协议 Schema-first codegen + storage.rs 拆分(3-4 天)

R2 风险的原文触发条件——"出现第一次双端不一致 bug → 提前代码生成"——**已满足**(B0.5 那两条错误码就是漂移实例)。

### 3.1 codegen 落地(ADR-0008)

- **选型:`ts-rs`**(derive `TS` 从 Rust struct 生成 TS 类型,输出到 `packages/shared/src/protocol/generated/`)。备选 specta+tauri-specta 不选:它接管命令注册层,侵入面太大。
- **保留 zod validators 作为运行时边界**(响应视为不可信输入的原则不变);zod 单测增加对 generated 类型的 `satisfies` 断言——类型漂移从此是**编译错误**而不是靠人眼。
- **渐进三步**:① 错误码枚举 → ② 全部命令请求/响应 DTO → ③ 事件类型。
- **CI 门禁**:`cargo test` 触发生成 → `git diff --exit-code packages/shared/src/protocol/generated/`,生成物过期即红。
- `docs/architecture/protocol.md` 加"类型源 = Rust DTO,生成物不入手改"章节。

### 3.2 `storage.rs` 拆分(1480 行 → 5 个模块)

`migrations.rs` / `recovery.rs`(损坏隔离)/ `legacy_import.rs` / `backup.rs`(备份恢复 + JSON 快照)/ `kv.rs`。纯移动,不改行为,内联测试随迁。`lib.rs` 装配不变。

### 3.3 批量同步命令(第一个走新 codegen 管线的命令)

- 新增 `reader.state.getAll`:一次返回全部书的 progress + annotations + bookmarks(现在 `runSync` 每本书串行 2-3 次 IPC 往返);
- `lib/sync.ts` 改单趟合并;WebDAV put 侧保持逐书(避免单请求过大)。
- 测试:shared `sync.ts` 单测扩展 + Rust 侧返回形状测试。

**验收**:门禁全绿;CI 含生成物 diff 门禁;`pnpm smoke:web` 过;协议文档同步;用 50 本 fixtures 实测同步往返次数下降(N 本 × 3 次 → N 本 put + 1 次 getAll)。

---

## B4 · 批注体验(2-3 天,第一梯队功能)

**核心事实:`annotations` 表已有 `color TEXT NOT NULL` + `note TEXT`,协议 `annotationSchema.color` 已是自由字段——本批次零迁移、零协议变更,纯前端。**

### 4.1 多色划线

- 前端定义色板常量(5 色,亮/暗主题双套值,进 `design-system` tokens);
- 选区工具栏:复制 / **色板行(5 色,点击即划)** / 笔记 / 查词典;
- 渲染端:FoliateAdapter 的 annotation 扩展字段携带 color,经内核 overlayer 绘制;**若 foliate-js 1.0.1 不支持 per-annotation 样式,备选方案 = 按 color 值分组建注 + 书内 iframe 注入对应高亮 CSS 类**(ADR-0006 约束下不碰内核源码)。

### 4.2 划线即写笔记

- 选区工具栏"笔记"入口 → inline composer(摘录回显 + 文本域,4000 字上限与 `reader.note.update` 一致)→ 存到该 annotation 的 note 字段(空串 = 清空回纯高亮);
- 无需新命令。

### 4.3 阅读器内批注列表面板

- 目录侧栏新增"批注"标签页(与 目录/书签/搜索 并列):本章 / 全书切换;
- 列表项 = 摘录(色点标识)+ 笔记预览,点击经 CFI 跳回原文,行内编辑 / 删除;
- 数据源复用 `reader.state.get` 已返回的 annotations + `reader.note.update`。

### 4.4 测试与验证

- `ReaderScreen.test.tsx` 契约扩展:色板渲染、笔记 composer 提交、批注列表跳转/编辑/删除;
- web parity 确认:IndexedDB shape 已含 color/note,`web-handlers` 零改动;
- **真书验证**:EPUB 真书五色划线 + 笔记 + 完全退出重开恢复 + WebDAV 同步后另一端颜色/笔记一致(记录进批次小结)。

---

## B5 · 多角色听书 + 翻译(≈2 天)

### 5.1 多角色听书 UI 接线(兑现 README 宣传)

- `tts-plan.ts` 改用 `reader-core` 已有并有测试的 `splitDialogue` → `assignSpeakers` → `buildSpeechSegments` 链:合成块携带 speaker;
- `TtsDrawer` 设置区:检测到多角色段落时出现"角色"页签,每角色一行(角色名 + 出现段数)→ voice 选择器(Edge 语音列表 / 系统语音 / 云端 voice 参数),未设置回退叙述者;映射持久化进 `deepread.tts.settings`(逐字段校验模式沿用);
- 三引擎路径:Edge = 换 voice 参数(缓存 key 已含 voice,天然隔离);系统 = 每角色 `SpeechSynthesisVoice`;云端 = provider `/audio/speech` 的 voice 字段;
- 高亮:块内字符偏移映射到原文偏移的现有模型不变(segment 1:1 约束沿用)。
- **真书验证**:《金色梦乡》对话密集章抽查说话人归属;改角色音色后重合成走新缓存 key、旧缓存不失效。

### 5.2 划选翻译

- `ai-core/src/translate.ts`:prompt(整段上下文、保留原格式、术语表可选)+ zod(`{ detectedLang, translation, notes? }`),走现有 `ai.chat` 流式;
- 选区工具栏"翻译"按钮 → 弹层流式渲染 + 复制;目标语言设置项(默认:中文书 → 英,其余 → 中);
- 成本诚实:弹层显示所用 provider/model(遵守 R9「显示发送范围」),单次 ≤ 2000 字截断提示。

### 5.3 繁简转换(提案制)

- `enhance/text-repair.ts` 新提案类型 `t2s`/`s2t`:由当前 AI provider 生成逐条提案(与 AI 校对同一"检测-应用分离、逐条对照原文验证"框架),用户逐条接受;
- **不做 OpenCC 内嵌**(数据表体积与 ADR-0001 依赖纪律),UI 诚实标注"基于当前 AI 提供商"。

**验收**:门禁全绿;`tts-plan.test.ts` 扩展多角色块;`translate.ts` 单测;真书验证记录。

---

## B6 · 跨书搜索 + 阅读目标(2-3 天)

### 6.1 跨书搜索

- 新命令 `library.search(query)`:Rust 侧两层——① `books` 表 LIKE(题名/副题/作者/标签);② `ai_index.chunks` JSON LIKE(返回 bookHash + 章节 label + 摘录片段,上限 30 条,只搜已建索引的书;个人书库量级下 LIKE 足够,FTS5 是否启用视 rusqlite bundled 特性另行评估,不承诺);
- 前端书架搜索框升级:两段结果(书目匹配 / 内容匹配),内容段诚实标注"基于已建 AI 索引的 N 本书";
- 内容匹配点击 → 开书 + 首次 relocate 定位(复用 RAG chunk 的章节 label → 目录定位)。

### 6.2 阅读目标

- 设置:每日目标分钟数(`app_settings` KV,浏览器端 localStorage);
- 统计页:目标环(当日/本周达标天数)+ 现有 streak 数据可视化增强;
- 书架侧栏:今日阅读时长 vs 目标的一行摘要。
- 数据全部来自现有 `reading_stats`,零迁移。

**验收**:门禁全绿;`shelf-view`/搜索纯逻辑单测;新命令走 codegen 管线(生成物 diff 干净)。

---

## B7 · 知识图谱家族 + TXT 章节规则(3-4 天)

### 7.1 图谱家族(§40 六种先补两种)

- `ai-core`:新增 `timeline.ts`(事件抽取:`{event, chapterRef, description[]}`,按章节顺序;非日期类小说用章节轴)+ `concepts.ts`(概念/关系/解释,面向非虚构);
- `ai_artifacts` kind 枚举扩为 `summary|outline|notes|characters|timeline|concepts`(协议变更,走 codegen);
- `GraphView` 泛化:视图类型参数化(角色=现有环形布局;时间线=横向轴 + 事件节点;概念=环形簇),缩放/拖拽/导出 SVG 能力沿用;
- `AiDrawer` 洞察区新增两个入口,生成前显示发送范围(前 N 章节选)。

### 7.2 TXT 章节规则(§15)

- 规则模型 `ChapterRule { id, name, pattern, priority, enabled }`,存储 `app_settings` KV(JSON,零迁移);
- `text-book.ts` 分节改为:内置规则 + 用户规则按 priority 合并;
- 规则编辑 UI(TXT 修整面板旁):增删改排序、**保存前强制预览**——在书籍前 N 行样本上高亮命中行、显示每条规则命中数(诚实可审);
- AI 生成规则:`ai-core` prompt 从样本行推断 `{name, pattern, priority}` 候选 → 进同一预览流程,用户审核后才保存(遵守「AI 输出必须可审」);
- pattern 校验:仅接受合法且无灾难回溯风险的正则(长度上限 + 解析失败拒绝)。

**验收**:门禁全绿;`text-book`/`ai-core` 单测;真书验证:一本人名章节不规则的真实网文 TXT 用自定义规则完成分节。

---

## B8 · 有声书导出管线(5-8 天,最大单项)

### 8.0 架构决策(ADR-0009)

- **合成循环在 Rust,不在 webview**:前端用 `tts-plan` 同套分块逻辑产出整书块清单(text + voice + 章节 index,一次 IPC 交付,几 MB 量级),`tts.export.start(bookHash, blocks, options)` 在 Rust 内复用 edge_tts/tts.rs 合成 + 内容寻址缓存直接写盘——避免 GB 级音频过 IPC;**缓存复用 = 断点续跑免费**(已合成块秒级跳过)。
- 输出 v1 = `<书名>-audiobook/` 目录:`chNN-章节名.mp3`(MP3 帧拼接即合法流)+ `manifest.json`(章节表/时长/文件偏移)。**m4b 不做**(需要 ffmpeg,违反当前依赖纪律;留待 ADR 单独评估)。

### 8.1 轻量任务系统(§25/§26 最小子集)

- Rust:tokio 后台任务句柄(复用 `AiState` 的 task 注册模式),同一本书同时只允许一个导出任务;
- **事件协议首次扩展**:`EventMap` 增 `task.progress`(阶段/当前块/总块/字节)、`task.done`、`task.error`;前端 `ipc.ts` 事件订阅 + 书架侧栏任务指示(进度条 + 取消);
- 失败块重试 1 次(与 TTS 播放同节奏);取消 = token 中断,已完成文件保留(下次续跑);
- 磁盘预检:输出目录剩余空间 < 预估音频体积(块字数 × 码率估算)时拒绝启动并说明。

### 8.2 UI

- `TtsDrawer`:"导出有声书"入口(选引擎/音色映射沿用当前听书配置)→ 任务提交后可关抽屉;
- 书架侧栏:任务进度 + 完成后"在访达中显示"(Tauri reveal API)。

**验收**:门禁全绿;事件协议文档同步;真书验证:《认知觉醒》(约 10 万字)完整导出、中断后续跑不重合成、产物可被播放器按 manifest 章节定位;导出期间正常阅读无卡顿(合成在后台线程)。

---

## B9 · 生态大件(排期另议,各项独立)

| #   | 事项                                                                                                                                                                                                                                          | 方案与规模       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 9.1 | **i18n**(XL,两段式):① 文案抽取——自建 `shared/src/i18n/`(轻量 t() + JSON 目录,zh 为默认源语言,不引库),组件硬编码中文机械迁出,测试环境锁定 zh 保证现有 1,287 行 Library 契约测试不动;② en 翻译 + 语言设置。抽取期冻结新 UI 文案(与功能批次错峰) | XL               |
| 9.2 | **OPDS**(M-L):`opds.fetch` 命令复用 B2 的 quick-xml 解析 Atom/OPDS 目录;书架"添加书源"面板 → 浏览/搜索/下载 → 进现有导入管线;认证支持 Basic                                                                                                   | M-L              |
| 9.3 | **隐蔽阅读模式**(M,§76):`tauri-plugin-global-shortcut`(能力评估 + capabilities 收敛)+ 全局热键隐藏/恢复窗口 + 可选托盘图标;设置页独立开关                                                                                                     | M                |
| 9.4 | **性能监视器**(M,§139):开发模式 FPS/内存/CPU overlay(§70 预算对齐)+ 100MB+ 大书实测矩阵跑一遍并把结果写进 `docs/development/performance.md`                                                                                                   | M                |
| 9.5 | **测试盲区收尾**(M-L):`AiDrawer`/`LearningDrawer`/`SyncDrawer`/`GraphView`/`ipc.ts`/`web-handlers.ts` 契约测试;FB2/CBZ 真书样本进 `smoke:formats`(样本到手即跑,没有就保持"未验证"标注)                                                        | M-L              |
| 9.6 | **移动端 UX**(XL,独立 epic):先出侦察报告(触控翻页/长按选区/移动布局差距清单),再单独立项排期——**不进本计划承诺范围**                                                                                                                           | 侦察 M / 实施 XL |
| 9.7 | **发布运营 checklist**(S):更新器 endpoint 从 `.invalid` 占位符换真实域名 + minisign 签名证书申请,完成后跑通端到端更新;`docs/release.md` 增补                                                                                                  | S(ops)           |

---

## 横切约定(每批 DoD)

1. `pnpm verify`(lint / format / typecheck / test / build)+ `cargo fmt --check` + `clippy -D warnings` + `cargo check` + `cargo test` 全绿;
2. 涉及协议 → 同步 `docs/architecture/protocol.md` + 双端测试;涉及内核/格式 → `pnpm smoke:web` + `pnpm smoke:formats`;
3. 新依赖必须过 ADR-0001 评估(本计划全部新依赖:`ts-rs`、`quick-xml`,仅此两个);
4. 每批真书验证结果写进批次小结(没验证的如实标"未验证");
5. Conventional Commits 按功能切分提交;
6. 批次收尾把 README Roadmap / 本计划的状态列更新。

## 新增 ADR 清单

| ADR      | 决策                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| ADR-0008 | Schema-first codegen:ts-rs 生成 TS 类型,zod 保留为运行时边界,生成物入 git + CI diff 门禁 |
| ADR-0009 | 有声书导出:合成循环在 Rust、输出 = 分章 MP3 目录 + manifest,不做 m4b                     |
| ADR-0010 | 密钥面收窄:移除 `secret.get`,webview 永不接触明文密钥                                    |
| ADR-0011 | i18n:自建轻量 t() 而非引库,zh 为源语言                                                   |

## 风险与对策

| 风险                                            | 对策                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| codegen 迁移面大                                | 渐进三步(错误码 → DTO → 事件),每步门禁全绿再进下一步                      |
| foliate-js 1.0.1 可能不支持 per-annotation 颜色 | B4 已带备选方案(分组建注 + iframe CSS 类注入),不碰内核源码                |
| B8 体量失控                                     | 拆四个 PR 合入:任务运行时 → 合成循环 → 组装输出 → UI;缓存复用保证随时可停 |
| i18n 抽取与功能开发冲突                         | B9 文案冻结期错峰;抽取是纯机械替换可工具化                                |
| 「多角色听书」说话人归属在真实书上准确率未知    | B5 真书验证是验收条件,不准确就收敛为"对话归属 + 手动改角色"而不承诺全自动 |

## 本版明确不做

m4b 封装(ffmpeg 依赖)、OpenCC 内嵌、本地内嵌推理运行时(继续 Ollama/LM Studio 路线)、账号系统、移动端完整重设计、PDF 元素级深色反转(维持 R6 分级结论)。

# DeepRead

> 本地优先、隐私优先的 AI 电子书阅读器。**阅读体验第一，AI 只做增强。**

[![CI](https://github.com/xlongDev/DeepRead/actions/workflows/ci.yml/badge.svg)](https://github.com/xlongDev/DeepRead/actions/workflows/ci.yml)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![React](https://img.shields.io/badge/React-19-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6)
![Rust](https://img.shields.io/badge/Rust-2024-black)
![License](https://img.shields.io/badge/license-MIT-blue)

## 目录

- [这是什么](#这是什么)
- [功能](#功能)
- [技术栈](#技术栈)
- [架构](#架构)
- [快速开始](#快速开始)
- [命令](#命令)
- [格式支持](#格式支持)
- [目录结构](#目录结构)
- [数据与隐私](#数据与隐私)
- [Web 预览版](#web-预览版)
- [发布](#发布)
- [里程碑](#里程碑)
- [文档](#文档)
- [License](#license)

## 这是什么

一个 Tauri 2 桌面阅读器（macOS / Windows / Linux），把「读书」本身做扎实 —— 排版、翻页、批注、听书、检索 —— 再用 AI 补上读不懂、读不完、读完忘这三件事。

三条不动的底线：

1. **阅读性能与稳定性优先于一切**。任何功能让翻页变慢就不上。
2. **绝不改写原文**。AI 输出一律可审阅、可丢弃；书里的字是作者的字。
3. **本地优先、无遥测**。书籍、批注、进度、密钥都不出机器；联网只发生在你自己配置了 AI / 云同步之后。

渲染内核唯一：`foliate-js`。应用不重排、不转码书的内容，只注入样式（见 [ADR-0006](docs/architecture/decisions/ADR-0006-foliate-only-kernel.md)）。

## 功能

### 阅读

- 分页 / 滚动两种流式，单页 / 双页 / 自适应三种版式；横排与竖排（`vertical-rl`）。
- 九张阅读纸：纸白、羊皮、牛皮、苔绿、云灰（浅）· 夜间、冷夜蓝、石墨、纯黑（暗）。
- 排版可逐项覆盖：字号、行距、段距、首行缩进、字重、字体（内置霞鹜文楷 + 导入自定义字体）。默认一律「跟随原书排版」，动过才覆盖。
- 繁简转换 8 种（`s2t` / `t2s` / `s2tw` / `s2hk` / `tw2s` / `hk2s` / `s2twp` / `tw2sp`，可关闭），按书持久化。
- 阅读尺（焦点行高亮）：分页档只高亮不滚页，滚动档跟随滚页。
- 目录抽屉、全书搜索、书签、进度滑杆、本章/全书字数与剩余时间、键盘快捷键（可在设置里改）、翻页动画。
- 并排对照阅读：同一本书或两本书左右同读，位置互相驱动。
- 章节规则：给没有章节的 TXT 强制切分或让 AI 推断（先预览，再落库）。

### 批注与笔记

- 选区工具栏：复制 / 词典 / 翻译 / 问 AI / 朗读此处 / 书内搜索 / 记笔记 / 五色划线 / 关闭。
- 划线三态（highlight / underline / squiggly）+ 五色板；划完就在原地写笔记，不必绕去侧栏。
- 批注按 CFI 锚定，随书持久化；笔记页集中浏览、跳回原文、导出 Markdown。

### AI（自备 Provider，OpenAI 兼容接口）

- 流式对话 + RAG 引用（回答里每一处引用都能跳回原文），可选把选中文本作为上下文。
- 一键洞察：本章摘要、角色抽取、时间线、概念解释、知识图谱（GraphView）。
- 原文精修：AI 给出修订建议 → 逐条 Diff → 你确认才应用，且可回退。
- 划选翻译；繁简转换提案。
- Provider 与 Model 可在应用内切换；密钥只进 OS Keychain。支持探测本机 OC Ferry。

### 听书（TTS）

- 三个引擎：系统语音 / Edge TTS（Rust 侧合成 + 本地缓存）/ 云端（跟随当前 AI 服务）。
- 多角色音色：用角色图谱把对话分给不同音色，没抽取过角色就全书走叙述者，不假装有。
- 句子级歌词页、语速热调（不重合成）、跨章连播、剩余时间。
- 两种形态：阅读器内迷你条（不遮正文）与桌面悬浮窗（独立 webview，全局可控）。
- 退到书架时阅读器只隐藏不卸载 —— 听书跨屏继续。
- 退到后台不睡：`wake-lock`。

### 学习

- 从划线生成闪卡；AI 依章节出测验；答错自动进错题本。
- 间隔复习队列（当日到期）、卡片删除与重新入队。
- 闪卡导出（桌面走系统保存对话框，web 走下载）。

### 书架 · 统计

- 导入：文件选择器 + 拖放 + 系统文件关联（双击书直接开）；按内容二次校验格式，失败如实报在书架问题条。
- 智能分组（按进度现算，无需维护）：全部 / 在读 / 收藏 / 已读完；与标签筛选可叠加。
- 标签、书籍信息编辑、封面提取、批量管理、跨书搜索。
- 统计页：阅读时长热力图、每日/每月柱状图、书目榜、阅读目标（每日分钟数）、连续天数。图表都配一份 `.visually-hidden` 数据表，读屏可用。
- 外观：默认「跟随系统」（浅色系统用暖纸纯白，深色系统自动切夜间石墨），也可固定三种世界（暖纸 / 石墨 / 纯黑）× 15 套色相背景 × 6 个强调色预设（或自定义），外加重叠式玻璃壁纸折射（WebGL，暗光下不吃性能）。

### 数据与同步

- 本地 SQLite（12 张表）+ 书籍字节 / 封面 / TTS 缓存 / 字体各自落盘。
- WebDAV 双向同步：记录级合并，冲突保留双方（不做全局 LWW）；批量 `reader.state.getAll` 单趟拉取。
- 云端备份 / 恢复：JSON 快照 + 整库备份。
- 数据库损坏自动隔离重建（§127），强制退出前冲刷未落盘进度（§128）。
- 应用内更新器：minisign 公钥校验，检查 / 安装 / 忽略。

## 技术栈

| 层       | 选型                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 桌面壳   | Tauri 2.12（Rust edition 2024，MSRV 1.89）                                    |
| 前端     | React 19.3 + TypeScript 7.0（strict + `noUncheckedIndexedAccess`）            |
| 构建     | Vite 8.3 + pnpm 12.18 workspace（Node ≥ 22，CI 用 24）                        |
| 测试     | Vitest 5.1（jsdom）+ Rust `#[test]`                                           |
| 接口边界 | zod 4.6 运行时校验；`ts-rs` 从 Rust DTO 生成 TS 类型（ADR-0008）              |
| 阅读内核 | foliate-js 1.0.1（唯一），PDF 走 `foliate-pdf` + pdfjs-dist 6.5               |
| 存储     | rusqlite 0.42（bundled SQLite）+ OS Keychain（`keyring`）                     |
| 静态质量 | oxlint 1.93 + Prettier 3.9；Rust `fmt` / `clippy -D warnings` / `cargo audit` |

依赖准入见 [ADR-0001](docs/architecture/decisions/ADR-0001-monorepo-tooling.md)：不为小功能引重依赖。

## 架构

```text
apps/desktop/src          React UI（唯一 IPC 出口：lib/ipc.ts）
apps/desktop/src-tauri    Rust 后端（60 条命令 / 12 张表 / 事件总线）
packages/shared           协议 + 类型（生成物）+ 错误系统 + 统计口径
packages/design-system    Design Tokens / 主题 / 背景 / 强调色 / 动效
packages/reader-core      ReaderEngine 契约 + TTS 文本切分（纯逻辑）
packages/reader-adapter   foliate-js / PDF / MOBI / TXT / MD 适配器
packages/ai-core          Provider 客户端 + RAG + 摘要 / 角色 / 图谱 / 翻译
```

依赖只能向下，禁止反向：

- **UI 不直连 Tauri IPC**，也不 import foliate-js；只经 `lib/ipc.ts` 与 `ReaderEngine`。
- **shared 运行时中立**：不依赖 Tauri 与 DOM，Node 与 WebView 两端都能跑。
- **Rust 命令薄壳化**：校验与组装放进纯函数，无需 Tauri 运行时即可单测。

协议三层：`COMMAND` 常量 → `CommandMap` 类型表 → zod validator。类型源是 Rust DTO（`ts-rs` 生成到 `packages/shared/src/protocol/generated/`），生成物入 git，CI 用 `git diff --exit-code` 卡住过期生成物。详见 [docs/architecture/protocol.md](docs/architecture/protocol.md)。

IPC 命令（60 条，按域分）：

| 域       | 命令                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 系统     | `system.ping` `app.info`                                                                                                 |
| 阅读状态 | `reader.state.get` `reader.state.getAll` `reader.state.set` `reader.stats.*` `reading.goal.*` `chapter.rules.*`          |
| 笔记     | `reader.notes.list` `reader.note.update` `notes.export`                                                                  |
| 书架     | `library.list` `library.search` `library.import` `library.remove` `library.info.set` `library.tag.set` `library.cover.*` |
| 数据     | `storage.backup` `storage.restore`                                                                                       |
| 词典     | `dictionary.list` `dictionary.register` `dictionary.remove`                                                              |
| AI       | `ai.config.*` `ai.ocFerry.*` `ai.chat` `ai.cancel` `ai.embed` `ai.index.*` `ai.artifact.*`                               |
| 卡片     | `cards.list` `cards.add` `cards.remove` `cards.review`                                                                   |
| 听书     | `tts.audio` `tts.edge.audio` `tts.edge.voices`                                                                           |
| 字体     | `fonts.list` `fonts.import` `fonts.remove`                                                                               |
| 云       | `cloud.config.*` `cloud.webdav.*` `cloud.backup` `cloud.restore` `secret.set` `secret.delete`                            |

## 快速开始

前置：Node ≥ 22、pnpm 12、Rust 1.89+（只跑前端可省）；Linux 另需 Tauri 的 webkit2gtk 系统依赖。

```bash
pnpm install
pnpm fixtures     # 生成测试书（EPUB/FB2/MOBI/TXT/MD/PDF）到 apps/desktop/public/fixtures
pnpm dev          # 浏览器开发模式，http://localhost:5173
pnpm tauri dev    # 桌面应用（进度、批注等走 Rust + SQLite）
```

开发模式可以直开一本书，方便调阅读器：

```text
http://localhost:5173/?open=/fixtures/夜航书.epub
http://localhost:5173/?open=/fixtures/夜航书.epub&parallel=/fixtures/山中手记.fb2
```

AI 功能要自己配 Provider（设置 → AI，OpenAI 兼容端点 + 模型 + Key）。要在浏览器里试 AI，可起本地 mock 服务：`node scripts/mock-ai-server.mjs`（8787，Vite 已配 `/mock-ai` 代理）。

## 命令

| 命令                 | 作用                                                         |
| -------------------- | ------------------------------------------------------------ |
| `pnpm dev`           | 前端开发（浏览器模式）                                       |
| `pnpm tauri dev`     | 桌面开发（经 `scripts/tauri.mjs`，自动注入更新签名私钥）     |
| `pnpm build`         | `tsc --noEmit` + `vite build`（双入口：主窗口 + 迷你条）     |
| `pnpm verify`        | 完整门禁五连：lint → format:check → typecheck → test → build |
| `pnpm lint`          | oxlint（correctness / suspicious 为 error）                  |
| `pnpm format:check`  | Prettier 检查（`pnpm format` 写入）                          |
| `pnpm typecheck`     | 所有包 `tsc --noEmit`                                        |
| `pnpm test`          | 所有包 Vitest                                                |
| `pnpm smoke:web`     | 真实浏览器冒烟：导入 → 刷新 → 翻页 → 备份 → 恢复（需 5173）  |
| `pnpm smoke:formats` | 真书样本回归：MOBI / AZW3 / FB2 / CBZ（需 5173 + 样本）      |
| `pnpm cargo:check`   | `cargo check --workspace --all-targets`                      |
| `pnpm cargo:test`    | `cargo test --workspace`                                     |
| `pnpm cargo:fmt`     | `cargo fmt --all`                                            |
| `pnpm cargo:clippy`  | `cargo clippy -- -D warnings`                                |
| `pnpm tauri build`   | 打安装包（.app / .dmg / .msi / .deb / AppImage）             |
| `pnpm release`       | 发布管线：门禁 + 构建 + 产物收集 + SHA256SUMS + latest.json  |

质量门禁要求全绿。CI 三个 job：`frontend`（lint / format / typecheck / test / build）、`rust`（fmt / clippy / test + 生成物 diff 门禁，固定 ubuntu-24.04）、`audit`（`cargo audit` 阻断式）。

`smoke:*` 用**真实浏览器**，不是 jsdom：IndexedDB 与真书解析在 jsdom 里假不出来，代价是需要先起 dev server。真书样本有版权、不进仓库 —— 脚本自己去项目根目录找，或用 `--samples <dir>` 指定；找不到的格式会明确标「没测」，不会悄悄算通过。

## 格式支持

| 格式             | 状态                                                      |
| ---------------- | --------------------------------------------------------- |
| EPUB             | ✅ foliate-js 原生，浏览器 E2E                            |
| PDF              | ✅ `foliate-pdf` + pdfjs-dist；夜间可重着色               |
| MOBI / PRC / AZW | ✅ 内核原生解析 + 真书回归（`pnpm smoke:formats`）        |
| AZW3 / KF8       | ✅ 内核原生解析 + 真书回归                                |
| FB2 / FBZ        | ✅ 内核原生解析（fixture 通过，真书样本待补）             |
| CBZ              | ✅ 内核原生解析（fixture 通过；真书样本待补）             |
| TXT / Markdown   | ✅ 适配器实现内核 book 接口，不转译文本；TXT 可配章节规则 |
| CHM              | ❌ 内核无解析器，导入层直接拒收                           |

## 目录结构

```text
apps/desktop/
  src/                  React UI
    features/library/   书架 / 笔记页 / 统计页 / 侧栏 / 玻璃壁纸
    features/reader/    阅读器、抽屉（AI / 听书 / 学习 / 搜索 / 目录）、TTS 引擎
    features/settings/  设置（外观 / 快捷键 / AI / 数据）
    lib/                IPC 出口、浏览器端 handler、导入、同步、统计
    styles/sections/    13 段分层 CSS（全部进同一 legacy 层）
  src-tauri/            Rust：commands / storage / ai / tts / cloud / fonts
  public/               fixtures、内置字体、PDF.js 资源
packages/{shared,design-system,reader-core,reader-adapter,ai-core}
docs/                   架构 / ADR / 开发笔记 / 发布 / 安全审计 / 计划
scripts/                发布、冒烟、探测、fixtures、mock AI 服务
```

## 数据与隐私

- 所有书与批注留在本机：SQLite 12 张表（`books` `progress` `annotations` `bookmarks` `ai_providers` `ai_index` `ai_artifacts` `dictionaries` `cards` `app_settings` `reading_stats` `book_chunks`）。
- API Key / WebDAV 凭据只进 **OS Keychain**，不落 localStorage，也不回传给前端（`secret.get` 已删除，见 ADR-0010）。
- 生产 CSP 收紧（`default-src 'self'`），asset 协议只放行书籍、封面、缓存、字体目录。
- 前端 Logger 默认脱敏 + 长文本截断，书籍正文进不了日志。
- 无任何埋点。联网只在：你配了 AI Provider、发起云同步/备份、检查更新。

详见 [docs/security-audit.md](docs/security-audit.md)。

## Web 预览版

同一份前端代码也能跑在浏览器里（无 Tauri IPC），由 GitHub Pages 部署：**https://xlongdev.github.io/DeepRead/**

分流只有一个点：`lib/ipc.ts` 检测不到 Tauri 运行时，就把核心命令交给 `lib/web-handlers.ts` → IndexedDB。书架、书籍文件、封面、进度、批注、笔记、统计在 web 端都真实可用并可跨刷新保留；**AI / 听书 / 离线词典 / 云同步 / 密钥保管只有桌面版**，未实现的命令会明确抛「运行时不可用」，不假装能用。

## 发布

```bash
pnpm tauri build                        # 只打包
node scripts/release.mjs                # 门禁 + 打包 + 收集 + 校验和 + 更新清单
node scripts/release.mjs --skip-gates   # 门禁已单独跑过
```

版本取自 `apps/desktop/src-tauri/tauri.conf.json`，产物收进 `release/v<版本>/`。更新工件要签 minisign 私钥（`TAURI_SIGNING_PRIVATE_KEY`，本机默认读 `~/.tauri/deepread.key`，由 `scripts/tauri.mjs` 注入；CI 走 secret）。OS 代码签名未配置 —— 没有证书时产物是 ad-hoc，拿到证书后填 secrets 即生效。详见 [docs/release.md](docs/release.md)。

## 里程碑

Phase 0–8（工程骨架 → 核心阅读 → 高级排版 → AI → TTS/学习 → 同步 → 跨平台 → 生产化）已完成。当前在 v0.3 批次（[docs/plan-v0.3.md](docs/plan-v0.3.md)）：

| 批次 | 内容                                                         | 状态   |
| ---- | ------------------------------------------------------------ | ------ |
| B0   | 卫生与快修（去重 / 吞错 / 错误码补齐）                       | ✅     |
| B1   | 前端性能（TTS 渲染风暴 / 列表 / 封面加载）                   | ✅     |
| B2   | Rust 安全与性能（共享 client / 缓存清理 / 秘密面收窄 / XML） | ✅     |
| B3   | 协议 Schema-first codegen + storage 拆分 + 批量同步          | ✅     |
| B4   | 批注体验（多色划线 / 划线即笔记 / 批注列表）                 | ✅     |
| B5   | 多角色听书 UI + 划选翻译 + 繁简提案                          | ✅     |
| B6   | 跨书搜索 + 阅读目标                                          | ✅     |
| B7   | 知识图谱家族 + TXT 章节规则                                  | ✅     |
| B8   | 有声书导出管线（轻量任务系统）                               | 未开工 |
| B9   | 生态大件：i18n / OPDS / 隐蔽阅读 / 性能监视器 / 移动端       | 未开工 |

## 文档

| 文档                                                               | 内容                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| [DESIGN.md](DESIGN.md)                                             | 设计契约：视觉、排版、动效、组件的定案与取舍         |
| [PRODUCT.md](PRODUCT.md)                                           | 产品边界与不可让步项                                 |
| [docs/architecture/overview.md](docs/architecture/overview.md)     | 分层、数据流、测试策略（Phase 0 快照，需与代码对照） |
| [docs/architecture/protocol.md](docs/architecture/protocol.md)     | IPC 协议与 codegen 规则                              |
| [docs/architecture/decisions/](docs/architecture/decisions/)       | 13 份 ADR                                            |
| [docs/development/testing.md](docs/development/testing.md)         | 测试分层与探针技巧                                   |
| [docs/development/performance.md](docs/development/performance.md) | 性能预算与实测                                       |
| [docs/release.md](docs/release.md)                                 | 发布与签名                                           |

## 参与

- Conventional Commits（`feat:` / `fix:` / `refactor:` / `perf:` / `test:` / `docs:` / `chore:`）。
- 改协议必须同步 `docs/architecture/protocol.md`、两侧测试与生成物；只改生成物会被 CI 拦下。
- 架构决策写 ADR，别让「当时为什么这样」只活在提交信息里。
- lint 报错逐条修，不加白名单、不降级规则。
- 提交前 `pnpm verify` + 四条 cargo 门禁。

## License

源码在 `Cargo.toml` 声明 MIT，但仓库尚未放入 `LICENSE` 文件 —— 补上之前请视为「保留所有权利」。第三方组件许可见 `packages/reader-adapter/src/books/vendor/`。

[wbs-reply-done]: #

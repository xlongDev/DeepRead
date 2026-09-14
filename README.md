# Deepread

> 以阅读为核心、AI 为增强、知识管理为延伸的 Local-first、Privacy-first 跨平台个人阅读操作系统(Personal Reading OS)。

技术栈:**Tauri 2 · Rust · React 19 · TypeScript(strict)· Vite · Vitest**。完整工程规范见仓库根目录的《全平台 AI 电子书阅读器|工程实施版》。

## 当前状态:Phase 8 · 生产化收尾 ✅(Phase 0-7 全部完成)

Phase 0-7 已全部落地并逐一验证(ADR-0007 为跨平台验证矩阵):核心阅读与高级排版、AI 助手(RAG/引用/摘要/角色图谱)、学习工具(闪卡/测验/错题本/间隔重复)、TTS 与多角色听书(系统语音 + 云端缓存)、WebDAV 多设备同步(记录级合并 + 冲突保留双方)、云端备份恢复。

Phase 8 生产化:更新器(minisign 公钥校验,应用内检查/安装/忽略)、数据库损坏隔离重建(§127)、强制退出进度冲刷(§128)、依赖漏洞清零、`node scripts/release.mjs` 发布管线(GitHub Actions 矩阵构建,OS 签名可插拔——无证书时产物为 ad-hoc,拿到证书后 secrets 填空即生效,见 [docs/release.md](docs/release.md))。

格式支持(只列真实验证过的能力,不伪造):

| 格式                    | 状态                                            |
| ----------------------- | ----------------------------------------------- |
| EPUB                    | ✅ 浏览器 E2E 验证                              |
| PDF                     | ✅ 浏览器 E2E 验证(内核官方适配器 + pdfjs-dist) |
| MOBI / AZW3 / FB2 / CBZ | ✅ 内核原生解析(真书样本回归待补)               |
| TXT / Markdown          | ✅ 适配器实现内核 book 接口(不转译文本)         |
| CHM                     | ❌ 内核无解析器,如实报错                        |

开发速览:

```bash
pnpm install
pnpm fixtures   # 生成测试书(EPUB/FB2/TXT/MD/PDF)+ PDF.js 支持资源
pnpm dev        # 浏览器开发模式;?open=/fixtures/夜航书.epub 可直开一本书
pnpm tauri dev  # 桌面应用开发模式(阅读进度/划线持久化走 Rust 端)
```

## 目录结构

```text
apps/desktop/          Tauri 2 桌面应用(React 壳 + Rust 后端)
packages/shared/       类型 / 错误系统 / Logger / IPC 协议(唯一全局依赖)
packages/design-system/Design Tokens(CSS+TS 双源)+ Motion Tokens
packages/reader-core/  ReaderEngine 契约(内核适配器于 Sprint 4 落地)
docs/architecture/     架构报告 / 领域模型 / 协议 / 风险 / ADR
```

分层与依赖规则、协议约定、ADR 见 [docs/architecture/overview.md](docs/architecture/overview.md)。

## 开发

```bash
pnpm install              # 安装依赖
pnpm dev                  # 前端开发模式(浏览器,IPC 不可用时 UI 显示错误态)
pnpm tauri dev            # 完整桌面应用开发模式
```

> 注意:pnpm 使用镜像源时请核对实际解析的依赖版本(本项目已显式锁定 typescript)。

## 质量门禁(必须全绿)

```bash
pnpm lint            # ESLint(strict typescript-eslint)
pnpm format:check    # Prettier
pnpm typecheck       # tsc --noEmit(所有包)
pnpm test            # Vitest(所有包)
pnpm build           # tsc + vite build

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo check --workspace --all-targets
cargo test --workspace
```

或直接 `pnpm cargo:check` / `pnpm cargo:test` / `pnpm cargo:fmt` / `pnpm cargo:clippy`。

> Rust 首次编译需数分钟;CI(rust job)会先安装 Tauri Linux 系统依赖。

## 规范与约定

- Conventional Commits(`feat: / fix: / refactor: / perf: / test: / docs: / chore:`)。
- 协议变更必须同步 `docs/architecture/protocol.md` 与两侧测试。
- 架构决策记录到 `docs/architecture/decisions/ADR-*`。
- 测试策略见 [docs/development/testing.md](docs/development/testing.md)。

## Roadmap

| Phase | 内容                                                                   | 状态              |
| ----- | ---------------------------------------------------------------------- | ----------------- |
| 0     | 工程骨架 / 协议 / 错误 / Logger / Tokens / CI                          | ✅                |
| 1     | Core Reader:导入、书架、EPUB/TXT/PDF、进度、书签、批注                 | ✅                |
| 2     | Premium Reading:Liquid Glass、主题、排版、双页、选择工具栏             | ✅                |
| 3     | AI Foundation:Provider、流式、RAG、引用                                | ✅                |
| 4     | AI Book Intelligence:精修、Diff、摘要、角色、知识图谱                  | ✅                |
| 5     | TTS / Learning:多角色语音、闪卡、测验、间隔重复                        | ✅                |
| 6     | Cloud:同步、冲突、WebDAV、备份                                         | ✅                |
| 7     | Cross Platform:macOS / Windows / iOS 已验证,Linux 待 CI,Android 已出包 | ✅*               |
| 8     | Production:更新器、崩溃恢复、安全审计、发布管线                        | ✅(OS 签名待证书) |

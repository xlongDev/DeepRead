# ADR-0003 · IPC 协议:类型化目录 + 边界校验(先于代码生成)

- 状态:Accepted(2026-09-08,Phase 0)
- 背景:spec §40/§57/§58 要求类型安全 IPC 与 Schema-first。完整 schema 代码生成(Rust → TS)需要选型与工具链投入。
- 决策(Phase 0 版本):
  1. `packages/shared/src/protocol/` 为命令/事件/错误 wire 格式的 single source of truth(TS 类型 + zod 校验器);
  2. Rust 侧以 serde 结构镜像,`#[serde(rename_all = "camelCase")]`,请求体 `deny_unknown_fields`;
  3. 一致性由两侧单测锁定(形状 + 字段名 + 错误码目录),出现漂移即 CI 红;
  4. 命令名点号命名(`system.ping`),依赖 tauri ≥ 2.11 `rename` 属性;事件逻辑名点号、传输名冒号(见 protocol.md 约定 2)。
- 演进:已由 ADR-0008 兑现 —— ts-rs 从 Rust DTO 生成 TS 类型,zod 校验器保留(运行时防线不撤),手工镜像与双侧形状测试退役。
- 理由:Phase 0 命令数 = 2,生成器基建的收益尚不抵其复杂度;但**边界校验与错误归一化现在就强制**(安全不可延后)。

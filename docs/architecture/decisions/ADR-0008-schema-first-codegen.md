# ADR-0008 · Schema-first codegen:ts-rs 生成 TS 类型,zod 保留为运行时边界

- 状态:Accepted(2026-10-07,B3;兑现 ADR-0003 的演进条款)
- 背景:协议形状在 TS(`packages/shared/src/protocol/commands.ts`)与 Rust(各命令模块的 serde DTO)各镜像一份,靠双侧测试锁定。B0.5 已出现第一次真实漂移(TS `ErrorCodes` 缺 `STORAGE_IO`/`STORAGE_CORRUPT` 两条,恰好是 R2 风险的触发条件)——人眼同步不可靠,类型源必须收敛到一端。
- 决策:
  1. **类型源 = Rust DTO**。`#[derive(ts_rs::TS)]` + `#[ts(export)]` 标注全部 wire 类型(错误码枚举、全部命令请求/响应 DTO、事件 payload),`cargo test` 触发 ts-rs 生成到 `packages/shared/src/protocol/generated/`(`.cargo/config.toml` 固定导出目录;`TS_RS_LARGE_INT=number` 与既有 TS 镜像一致)。
  2. **生成物入 git,不入手改**;CI 增加 `git diff --exit-code packages/shared/src/protocol/generated/` 门禁 —— 改了 Rust DTO 忘记重新生成即红。
  3. **TS 侧手写接口删除**,由 `protocol/commands.ts`/`events.ts` 重导出生成类型(别名保持前端既有命名);`CommandMap` 的请求/响应类型全部指向生成物。
  4. **zod 校验器保留**,作为响应不可信输入的运行时边界(§133 原则不变);`protocol.test.ts` 增加两组编译期断言:校验器输出可赋给 wire 类型(形状漂移即红)+ wire 字段被校验器覆盖(防 Rust 新增字段被 zod 静默剥离);`errors.ts` 的 `WIRE_ERROR_CODES` 用 `satisfies Record<GeneratedErrorCode, …>` 锁定错误码目录。
  5. 选型 **ts-rs**(derive 式,零侵入命令注册层),不选 specta+tauri-specta(它接管命令注册,侵入面过大)。
- 语义约定:Rust `Option<T>` 字段带 `skip_serializing_if`(配合 `default`)→ 生成 `field?: T`(wire 上省略);不带 → `field: T | null`(wire 上显式 null)。两种形状都被 zod 断言钉住,新增字段时二选一,不要发明第三种。
- 理由:漂移从「测试偶尔抓到」变成「typecheck 必抓」;Rust 端改协议只有一个动作(改 DTO + `cargo test`),TS 端零手工同步。代价是 107 个生成文件入 git(可读性略降,由 CI diff 门禁与「不入手改」纪律补偿)。

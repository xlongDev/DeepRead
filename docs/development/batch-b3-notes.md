# B3 批次小结(2026-10-07)

协议 Schema-first codegen + storage.rs 拆分 + 批量同步命令。三个提交:
`0aee9d2`(B3.1 codegen)、`0946caf`(B3.2 storage 拆分)、`aafaa62`(B3.3 批量同步)。

## 落地内容

### 3.1 codegen(ADR-0008)

- 选型 ts-rs v12(derive 式,零侵入命令注册层;`.cargo/config.toml` 固定
  `TS_RS_EXPORT_DIR=packages/shared/src/protocol/generated`、`TS_RS_LARGE_INT=number`)。
- 107 个 wire 类型入 git:错误码枚举、52 组命令请求/响应 DTO、事件 payload。
- TS 手写接口全部删除,`commands.ts`/`events.ts` 重导出生成类型(别名保持前端既有命名);
  zod 校验器保留为运行时边界,输出可赋给 wire 类型 + wire 字段全覆盖两组编译期断言
  进 `protocol.test.ts`;`errors.ts::WIRE_ERROR_CODES` 锁错误码目录。
- CI(rust job)新增 `git diff --exit-code packages/shared/src/protocol/generated/` 门禁。
- 语义约定(Rust `Option<T>`):带 `skip_serializing_if` → TS `field?: T`(wire 省略),
  不带 → TS `field: T | null`(wire 显式 null);请求侧 6 个字段补 skip 属性
  (`temperature`/`speed`/`lang`/`rate`/`cfi`/`bookHash`,对仅反序列化的请求是运行时无操作)。

### 3.2 storage.rs 拆分

1481 行 → `storage/{migrations,recovery,legacy_import,backup,kv}.rs` + `mod.rs`(纯移动)。
内联测试随迁共 11 个(1+3+2+5),mod.rs 平铺重导出使既有调用点与集成测试零改动;
唯一例外:`generate_handler!` 的两条 storage 命令指向 `storage::backup::*`
(tauri 命令宏的隐藏 helper 不随 `pub use fn` 迁移)。

### 3.3 批量同步命令

- `reader.state.getAll`(codegen 管线的第一个新命令):三表 UNION 出有状态的
  book hash,复用 `load_state` 逐个装配;空状态的书不占键。
- `runSync` 改单趟:N 本书 N 次 `reader.state.get` IPC → 1 次 `getAll`;
  WebDAV put 侧保持逐书(单请求过大防护不变)。
- web parity:IndexedDB 同契约实现(`web-handlers.ts`),浏览器模式不降级。

## 验收对照

| 验收项(计划 §B3)                        | 结果                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 门禁全绿(pnpm verify + 四条 cargo 门禁) | ✅ lint/format/typecheck/test/build 通过;fmt/clippy -D warnings/cargo check/cargo test 通过          |
| CI 含生成物 diff 门禁                   | ✅ ci.yml rust job 末步                                                                              |
| `pnpm smoke:web` 过                     | ✅ 17/17(含备份/恢复/进度/批注路径)                                                                  |
| 协议文档同步                            | ✅ protocol.md「类型源与 codegen」章节 + `reader.state.getAll` 条目;ADR-0008 新建、ADR-0003 标注兑现 |
| 50 本 fixtures 实测往返下降             | ✅(契约级)`sync.test.ts` 50 本书用例断言 1 次 getAll、0 次 state.get、52 次 WebDAV get               |

## 真书验证

**未执行**(需要真实 WebDAV 服务与双端环境)。替代覆盖:Rust 返回形状测试 +
`sync.test.ts` 合并/持久化/push 全路径契约测试 + smoke:web 的浏览器端备份恢复链路。
留待下次真机同步会话补记。

## 测试增量

- Rust:`get_all_returns_only_books_that_have_state`(+wire 形状断言)
- TS:`sync.test.ts` 4 例(单趟、双向合并 set+push、两端一致零写入、50 本实测)
- 编译期断言常量:`RESPONSE_WIRE_TYPES` / `RESPONSE_WIRE_FIELDS` / `EVENT_WIRE_TYPES`
  / `WIRE_ERROR_CODES`

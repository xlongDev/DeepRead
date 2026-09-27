# IPC Protocol

> 单一事实源:`packages/shared/src/protocol/`(TS 侧)与 `apps/desktop/src-tauri/src/`(Rust 镜像,测试锁定一致)。
> Sprint 2 计划引入 Schema-first 代码生成(Rust 类型 → TS 类型),替代手工镜像。

## 约定

1. **命令名**:点号命名 `<domain>.<action>`(如 `system.ping`)。Rust 侧用 `#[tauri::command(rename = "…")]`(要求 tauri ≥ 2.11)。
2. **事件名**:逻辑名使用点号(`app.ready`);Tauri 事件名禁止 `.`,传输名将 `.` 替换为 `:`(`app:ready`)。映射只在两侧边界实现:TS `listenEvent()`、Rust `events::transport_name()`。
3. **数据形状**:JSON,camelCase 字段(Rust 侧 `#[serde(rename_all = "camelCase")]`),时间一律 ISO 8601 UTC。
4. **不可信边界**:前端校验所有响应与事件 payload(zod);Rust 校验请求(serde 类型 + `deny_unknown_fields` + 显式规则)。
5. **错误**:所有命令 `Result<T, AppError>`;wire 格式见下。

## Command 目录(Phase 0)

### `system.ping`

|          |                                                              |
| -------- | ------------------------------------------------------------ |
| Request  | `{ nonce: string }`(1..=128 字符)                            |
| Response | `{ nonce: string, serverTime: ISO8601, appVersion: string }` |
| Errors   | `SYSTEM_VALIDATION`(nonce 非法)                              |
| 用途     | 类型安全 IPC 回环验证/心跳。                                 |

### `app.info`

|          |                                                                     |
| -------- | ------------------------------------------------------------------- |
| Request  | `undefined`                                                         |
| Response | `{ appName: string, appVersion: string, os: string, arch: string }` |
| Errors   | `SYSTEM_INTERNAL`(预期不发生)                                       |
| 用途     | 应用壳信息展示。                                                    |

### `reader.state.get` / `reader.state.set`

|                |                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Request (get)  | `{ bookHash: string }`(小写 SHA-256 hex,前端 WebCrypto 计算)                                                      |
| Response (get) | `{ state: { progress: { cfi, fraction } \| null, annotations: AnnotationRecord[], updatedAt: ISO8601 } \| null }` |
| Request (set)  | `{ bookHash, state }`                                                                                             |
| Response (set) | `{ savedAt: ISO8601 }`                                                                                            |
| Errors         | `SYSTEM_VALIDATION`(hash 非法)、`STORAGE_IO`、`STORAGE_CORRUPT`                                                   |
| 用途           | 按书籍文件哈希持久化阅读进度(CFI)与批注锚点;SQLite 落地前的真实 JSON 存储。                                       |

### `library.list` / `library.import` / `library.remove` / `library.rename`

|             |                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| list        | Request `undefined`;Response `{ books: LibraryBook[] }`(按加入时间倒序)                                                   |
| import      | Request `{ path: string }`(来自系统文件对话框);Response `{ book: LibraryBook }`                                           |
| remove      | Request `{ bookHash: string }`;Response `{ removed: boolean }`                                                            |
| rename      | Request `{ bookHash, displayName }`;Response `{ book: LibraryBook }`                                                      |
| LibraryBook | `{ hash, fileName, displayName: string \| null, format, path, size, addedAt }`                                            |
| Errors      | `BOOK_UNSUPPORTED_FORMAT`、`BOOK_OPEN_FAILED`、`SYSTEM_VALIDATION`(hash 非法)、`STORAGE_IO/CORRUPT`                       |
| 约定        | 文件保留原位(永不移动/删除用户文件);内核经 asset 协议流式读取,导入时按文件逐一授权 scope                                  |
| 约定        | `displayName` 为书籍自带元数据标题,前端惰性解析后经 `rename` 回写;`null` 表示尚未解析(书架回退到清洗后的文件名)           |
| 约定        | `remove` 同时清理 progress / annotations / bookmarks / cards / ai_index / ai_artifacts(外键 CASCADE 未开 PRAGMA,显式删除) |

### `ai.*` 与 `secret.*`(Phase 3)

| 命令                         | 请求 → 响应                                                                                            | 说明                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `ai.config.list/save/remove` | Provider 配置(不含密钥)→ 保存时密钥写入钥匙串                                                          | 配置存 `ai-config.json`;密钥地址 `ai.key.<id>` |
| `ai.chat`                    | `{ taskId, configId, messages }` → `{ taskId }`;SSE 经 **Channel** 流回(chunk/done/cancelled/error 帧) | Rust 代持密钥直连上游;前端只收流               |
| `ai.cancel`                  | `{ taskId }` → `{ cancelled }`                                                                         | 原子旗标,流循环即时生效                        |
| `ai.embed`                   | `{ taskId, configId, texts[] }` → `{ vectors[][] }`                                                    | POST `{base}/embeddings`,密钥服务端解析        |
| `ai.index.get/set`           | 按书籍哈希存取 `{ chunks[label,text,vector], embeddingModel, createdAt }`                              | `ai-index/<hash>.json`,64MB 上限 + 损坏防护    |
| `secret.set/get/delete`      | 钥匙串优先,无服务时降级 0600 文件                                                                      | 密钥永不回传 UI(仅 AI HTTP 客户端使用)         |

错误码:`AI_PROVIDER_ERROR`(连接失败/上游非 2xx/响应不合法,多数可重试)、`STORAGE_IO/CORRUPT`。

## Event 目录(Phase 0)

### `app.ready`(v1)

|          |                                                                        |
| -------- | ---------------------------------------------------------------------- |
| Payload  | `{ startedAt: ISO8601, appVersion: string }`                           |
| 发出时机 | Rust `setup` 完成后(单次)                                              |
| 备注     | 前端订阅晚于发出时会错过该事件;Phase 1 的进度类事件为持续型,不受影响。 |

## Error wire 格式(ADR-0004)

```json
{
  "code": "SYSTEM_VALIDATION",
  "message": "nonce must not be empty",
  "cause": "…可选,字符串化的根因链",
  "retryable": false,
  "context": { "field": "nonce" }
}
```

- `code`:`<域>_<原因>` 大写蛇形;前缀域:`BOOK_ READER_ AI_ RAG_ SYNC_ AUTH_ STORAGE_ TTS_ PDF_ SYSTEM_ SECURITY_`。
- 前端 `normalizeIpcError` 将其重建为 `AppError`;非法 code 归一化为 `SYSTEM_INTERNAL`。
- UI 只允许展示 `message` + `code`;`cause`/栈信息仅进入日志(spec §60)。

## 版本化

- 协议版本常量:`PROTOCOL_VERSION = 1`(`packages/shared/src/protocol/events.ts`)。
- 兼容规则:新增命令/事件 = minor;修改已有字段类型 = 破坏性变更,必须走版本化(新字段名或 envelope 版本),禁止原地改义。
- 每次协议变更必须同步更新本文档 + 两侧测试。

## 目录演进规则(供后续 Phase 遵守)

| 域        | 前缀            | 命令示例(规划)                           |
| --------- | --------------- | ---------------------------------------- |
| Book      | `BOOK_*`        | `book.import`、`book.open`、`book.close` |
| Reader    | `READER_*`      | `reader.goto`、`reader.progress.get/set` |
| AI        | `AI_*`          | `ai.chat`、`ai.task.cancel`              |
| Sync      | `SYNC_*`        | `sync.start`、`sync.resolve`             |
| Auth      | `AUTH_*`        | `auth.login`、`auth.logout`              |
| Storage   | `STORAGE_*`     | `storage.backup`、`storage.restore`      |
| TTS / PDF | `TTS_* / PDF_*` | `tts.start`、`pdf.render.page`           |

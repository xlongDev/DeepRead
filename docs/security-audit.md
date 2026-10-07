# 安全审计记录(Phase 8,spec §67/§68/§49)

- 日期:2026-09-15 · 范围:Phase 0-7 全部代码 + 依赖
- 结论:**无已知的阻断性安全问题**;依赖漏洞清零;遗留项见文末。

## 1. 威胁模型核对(spec §67)

| 威胁                | 现状        | 证据/机制                                                                                                                                                   |
| ------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS                 | ✅ 防御     | CSP:`script-src 'self'`(无 unsafe-eval/inline);EPUB/TXT/MD 渲染进 blob iframe,注入脚本被 CSP 阻断;词典 HTML 经 `sanitizeDefinitionHtml` 白名单清洗          |
| Malicious EPUB/HTML | ✅ 防御     | 同上;书内容永远视为不可信输入(spec §133),在内核 iframe 沙箱内渲染,无 IPC 能力(见下)                                                                         |
| 任意文件访问        | ✅ 防御     | asset 协议 scope 仅在启动时逐书 allow(启动重授权),TTS 缓存目录单独 allow;所有以 bookHash 为键的命令先过 `validate_hash`(sha256 hex)                         |
| Path Traversal      | ✅ 防御     | `validate_hash` 拒绝非十六进制路径段;artifact kind 白名单;备份/恢复目标由用户对话框显式选择                                                                 |
| Command Injection   | ✅ 不适用   | 后端无 `std::process::Command` 调用(仅 §127 隔离用 fs rename;随机源用 /dev/urandom)                                                                         |
| SSRF                | ✅ 边界明确 | 出网仅两处:AI 代理与 WebDAV,均指向用户显式配置的 http(s) 地址(cloud.rs `validate_endpoint` 强制);应用自身无遥测                                             |
| API Key Leakage     | ✅ 防御     | 密钥只存 OS 钥匙串(secrets.rs),Rust 侧代取;从不过 IPC 回传 webview;TTS/聊天在 Rust 端注入 Bearer                                                            |
| Unsafe URL          | ✅ 防御     | IPC 响应统一 zod 校验(`responseValidators`),事件载荷同样校验;book 打开走 asset 协议而非任意 URL                                                             |
| EPUB 沙箱(spec §68) | ✅ 防御     | 书内容 iframe:不能读系统文件、不能触达 Secret、不能执行 native 命令、**不能访问任意 IPC**——IPC 桥只在主 frame 上下文注入,书 iframe 无 `__TAURI_INTERNALS__` |

## 2. 权限面(Tauri capabilities)

`capabilities/default.json` 仅授予:`core:default`、`log:default`、`dialog:default`、`updater:default`、`process:allow-restart/allow-exit`。文件系统/Shell/HTTP 插件未启用;webview 无法绕过业务命令直接触盘。

## 3. 依赖审计

- **npm**(`pnpm audit`,2026-09-15):0 漏洞。修复:devDependency 链上 `ansi-regex` ReDoS(GHSA-93q8-gq69-wqmw)经 `pnpm-workspace.yaml` overrides 强制 ^6.1.0(仅测试工具链使用,不进产物)。
- **Rust**:建议在有网环境运行 `cargo install cargo-audit && cargo audit`(本机未安装,未执行);核心依赖(tauri 2.11、rusqlite bundled、reqwest+rustls)为广泛审计的主流实现。

## 4. 加固清单(已实现)

- IPC 全量 schema 校验:请求与响应双向校验,校验失败归类 `SECURITY_VALIDATION_FAILED`。
- 数据库损坏恢复(§127):启动 `quick_check`,损坏文件**隔离备份**(从不删除)后重建空库。
- 更新签名(§56):updater 走 minisign 公钥校验(公钥固化于 tauri.conf.json),私钥不入库(`~/.tauri/`)。
- 日志脱敏:log 插件级别生产为 Info;密钥/正文永不入日志(无打印路径)。
- `secret.get` 命令移除(B2/ADR-0010):webview 不存在任何能读取明文密钥的命令面,密钥仅在 Rust 侧被 AI/TTS/WebDAV 客户端代取。

### 4.1 asset 协议 scope 收窄评估(B2.6,2026-10-07)

书文件已是最小粒度(`allow_file` 逐本)。其余三个目录评估结论:**维持 `allow_directory`(非递归),不做逐文件收窄**,理由:

1. **运行时动态增删**:封面在 `library.cover.put` 落盘、TTS 音频在听书过程中逐块生成、字体由用户导入 —— 逐文件 allow 要求每条写路径在创建后回写运行时 scope,漏一处就是"新封面/新音频加载不出来"的功能性回归;目录 allow 与写入路径天然一致。
2. **增量收益趋零**:目录位于用户自己的应用数据目录,内容全部是 app 自产(content-addressed 图片/音频、导入的字体);能往该目录写文件的进程本就拥有用户权限,scope 收窄不改变其威胁面。
3. **目录内没有可执行/敏感内容**:三个目录只承载媒体与字体,泄漏面是"图片和音频被读走"——攻击前提(已能写数据目录)成立时该前提自身即已击穿。

若未来 cover/tts 文件改为固定的预生成清单(如导出管线),按文件 allow 的成本会下降,届时重新评估。

## 5. 遗留项(不阻断发布)

1. Rust 侧 `cargo audit` 未在本机执行(无 cargo-audit 二进制)→ 收录进 CI 任务清单。
2. 恶意 EPUB 的深度模糊测试(fuzzing)未做;CSP 阻断脚本执行是主要防线,`link/样式注入` 仍在书 iframe 内生效(表现为排版,无数据访问)。
3. `frame-src blob:` 允许 blob iframe——内核要求;若未来内核支持 CSP 隔离,可进一步收紧。

# ADR-0010: 密钥面收窄——移除 `secret.get`,webview 永不接触明文密钥

日期:2026-10(B2 批次落地)
状态:已接受(已实施)

## 背景

早期设计里 webview 通过 `secret.get` 读取密钥,再由前端 fetch 调 AI/WebDAV。
这意味着任何能跑进 webview 的脚本(书 iframe 的内容、AI 回复里注入的 HTML、
未来某个被污染的依赖)都能把用户明文密钥拖走。书 iframe 渲染的是不受信任的
第三方内容,这个面必须归零。

## 决策

1. **`secret.get` 命令移除**:协议里只保留 `secret.set/delete`(写入与删除面)。
   webview 不存在任何能读取明文密钥的命令面。
2. **密钥只在 Rust 侧被消费**:AI/TTS/WebDAV 的 HTTP 请求全部由 Rust 客户端
   代发,密钥在 Rust 侧读取后直接注入请求头,永不回传 webview
   (`ai.rs`/`cloud.rs`/`edge_tts.rs`/`tts.rs` 的客户端各自代取)。
3. **存储分层**:OS 钥匙串优先(macOS Keychain / Windows Credential Manager /
   Linux keyutils,keyring crate);无钥匙串服务时(无头 CI、部分 Linux)降级
   为应用数据目录下 0600 JSON 文件。密钥按不透明字符串寻址
   (`ai.key.<configId>` 等),与配置记录解耦。

## 后果

- webview 被完全攻破也拿不到密钥 —— 攻击者最多能以用户身份发请求,不能把
  凭据导出去别处用。
- 前端再无「带鉴权的直连」能力:任何需要密钥的请求都必须走 Rust 命令。
  这是刻意收紧 —— 新增云功能时先问「Rust 侧能否代发」,而不是把密钥递回来。
- 降级文件模式的保护弱于钥匙串(依赖文件系统权限),已被 0600 + 应用目录
  约束到可接受下限;文档如实标注,不做伪装。

# B9.2 · OPDS 书源 —— 批次小结(2026-11-18)

## 落地面

- **Rust**(`opds.rs`):`opds.fetch`(Atom 目录解析,quick-xml 按局部名匹配 —— 与 cloud.rs 的 WebDAV multistatus 同一套惯用法,前缀/默认命名空间一视同仁;4MB 目录上限、15s 超时、401 单独说人话)+ `opds.download`(下载落 `opds-downloads/`,temp+rename 原子提交,512MB 上限,扩展名按 URL→content-type 兜底猜测)。Basic 认证可选,凭证只留在 Rust。
- **UI**:书架工具栏"书源"键 → `OpdsDrawer`(目录地址/账户/密码,浏览 → 条目列表 → 每条"导入" = `opds.download` → `library.import` 两跳;`nextUrl` 翻页追加;上次书源地址落 localStorage)。下载格式偏好前端排序:epub > mobi > fb2 > cbz > pdf > text。
- **协议**:6 个 ts-rs 类型 + zod 校验 + `docs/architecture/protocol.md` 同步。

## 测试

- Rust 11 例:样例目录解析(双格式/封面/翻页/实体转义)、病态 XML 不 panic、扩展名偏好、URL stem 清洗、wire 拒绝未知字段。
- 前端 5 例:`downloadScore` 偏好序、浏览→条目上屏→导入选 epub(跳过在场 pdf)→两跳落库→按钮终态、错误终态。
- 门禁:TS 525 + Rust 273 全绿,clippy/fmt/prettier 干净。

## 偏离与未做

- OpenSearch 检索模板未做(多数书源翻页即可用);OPDS 2(JSON)不支持,目录打不开时如实报错。
- 封面 URL 已解析但 v1 不拉取展示(列表信息够用);真书验证待 GUI(公网书源需用户环境)。

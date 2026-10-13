# B6 批次小结:跨书搜索 + 阅读目标

对应 `docs/plan-v0.3.md` §B6(≈2-3 人日)。两个子项全部落地,均走 codegen 管线
(ts-rs 生成 3+3 个类型),零新依赖、零迁移(阅读目标存 `app_settings` KV)。

---

## 6.1 跨书搜索(`library.search`)

- **Rust**(`library.rs`):两层搜索。① 书目层 —— `books` 表 LIKE,字段
  `display_name/file_name/author/subtitle/tags`,`%`/`_` 用 `ESCAPE '\'` 按字面
  转义(搜 "100%" 不会变成通配符),ASCII 大小写不敏感靠 SQLite 的 `LIKE` 语义 +
  前端 `matchesBookQuery` 同规则镜像;② 正文层 —— 先查**全部书**的标题建 map,
  再扫 `ai_index.chunks`。`chunks` 列是裸 JSON 数组 `[{label,text,vector}]`,
  反序列化只取 label/text(`ChunkForSearch`),vector 原样留在 `Value` 里不过手。
  命中片段 = query 前后各 60 字符,钳到字符边界;上限 30 条。
- **协议**:`LibrarySearchRequest/Response/Hit` 走 ts-rs;`protocol.test.ts` 两组
  校验器测试 + 编译期 wire 断言。
- **前端**:
  - `lib/library-search.ts`:`matchesBookQuery`(镜像 Rust WHERE 字段)供 demo
    书架(仅内存、没写 IndexedDB)本地过滤;web handler 只做书目层并诚实报
    `indexedBooks: 0`。
  - 书架:查询词防抖 200ms 调命令,`searchSeqRef` 丢过期回包;书目命中进网格,
    正文命中单独一列(在网格上方),标注"基于已建 AI 索引的 N 本书"与"(已达上限)"。
  - 开书定位:RAG chunk 没有 CFI → `OpenedBook.sectionLabel` + ReaderScreen
    `findTocItem`(递归、trim 容错)按目录 `href` 跳;找不到发 notice
    「没找到「X」这一章,已按常规位置打开。」且**仍然恢复上次进度**。
- **偏差记录**:`openShelfBook` 原先只收 2 参,JSX 第三参(sectionLabel)被静默
  丢弃 —— 测试(`onOpenBook` 断言 `sectionLabel`)当场抓住,已修。

## 6.2 阅读目标(`reading.goal.get/set`)

- **Rust**(`state.rs`):目标分钟数存 `app_settings` KV(键
  `reading.goal.dailyMinutes`),备份走 VACUUM INTO 全量快照天然带上,零迁移。
  读路径把非法/越界/旧版遗留值一律过滤成 0(与 `tts.rs::cache_limit` 同一条
  规矩);0 = 没有目标,也落库(少一条 DELETE 的错处理路径)。
- **共享纯逻辑**(`shared/src/stats.ts`):`goalRatio`(无目标返回 null —— 不画
  0% 的环冒充"今天完全没读")、`goalReached`、`goalDays`(最近 N 天达标数,
  含今天,判定与 streak 同一个"读够了才算"的思路)。
- **设置**(设置弹窗新「阅读」页签):数字输入 + 保存/清除;`commitGoal(minutesText)`
  显式收值 —— 「清除」按钮第一版靠先 setState 再读 state,存回去的是旧目标
  (stale closure,测试抓住)。非法值(空/小数/越界)给明确错误,不发 IPC。
- **统计页**:今日目标环(SVG stroke-dasharray,百分比照实 —— 超额显示 200%,
  环画满)+「本周达标 N/7 天」;柱状图达标日上方加小旗(不改柱高语义)。
- **书架侧栏**:底部一行摘要「今日 10 分 / 目标 20 分(· 已达成)」;统计未取到
  时整行不显示,不摆猜出来的数字。
- **双端**:web handler 分流到 localStorage(`deepread.reading.goal`),读写同一
  份收敛规则;挂载即取(侧栏常驻),进统计页再取最新的。

## 测试与门禁

- Rust:goal 3 例(默认 0/往返、0 = 清除、越界拒 + 脏值过滤);cargo 213 passed。
- shared:stats 3 例 + protocol 2 组;80 passed。
- desktop:跨书搜索 4 例(防抖单发/上限提示/零命中不渲染/清空收起)+
  sectionLabel 定位 2 例 + 阅读目标 5 例(侧栏无目标/保存联动/超额/清除/非法值);
  252 passed。`App.test.tsx` mock 补 `reader.stats.get`/`reading.goal.get` 的
  真实形状(挂载加载后,假形状会在 `stats.days.find` 处炸)。
- `pnpm verify`(lint 0/0 · format · typecheck · test · build)与四条 cargo 门禁
  全绿;ts-rs 生成物 6 个新文件入 git,CI diff 门禁干净。

## 未做 / 未验证

- **真书验证未做**:跨书搜索正文命中定位、目标环动效需在桌面版真书上确认
  (本机无 GUI 自动化,如实标注)。
- FTS5 未启用(计划原文:个人书库量级 LIKE 足够,是否启用另行评估)。
- 「现有 streak 数据可视化增强」只做到了目标环 + 达标小旗;连续天数本身没有
  额外的图形化(四块指标契约测试锁着 tile 数量,不想为动效改契约)。

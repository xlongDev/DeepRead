# Risk Register

> Sprint 0 产物;每个 Sprint 复审。分级:影响 × 概率(高/中/低)。

## R1 · foliate-js API 不确定性 — 影响:中 / 概率:低(已大幅缓解)

~~契约基于规范而非实测~~ → **2026-09-09 已实测集成**(ADR-0006):npm 官方包 1.0.1,EPUB/PDF 真书浏览器 E2E 通过,内核契约以 ambient 类型声明锁定(`reader-adapter/src/foliate-js.d.ts`)。

**残余风险**(2026-09-30 更新):**MOBI / AZW3 已过真书回归**(`pnpm smoke:formats`,
正文分别渲染出 820 / 295 字符);FB2 / CBZ 仍只有 fixtures。内核升级可能破坏未声明 API。
**缓解**:升级时跑 `pnpm fixtures` + `pnpm smoke:web` + `pnpm smoke:formats`。

> 真书样本**不进仓库**(有版权),所以原计划的「补入 fixtures」改成了:脚本自己去
> 项目根目录找,或用 `--samples <dir>` 指定。没有样本的格式会被标成「未验证」
> 而不是悄悄算通过。

## R2 · 协议双端漂移 — 影响:中 / 概率:中

TS(zod)与 Rust(serde)手工镜像,存在不一致风险。

**缓解**:三重测试锁定(zod 单测、serde 单测、camelCase 字段断言);Sprint 2 落地 Schema-first 代码生成(schemars / ts-rs 或specta 选型 spike)。**触发条件**:出现第一次双端不一致 bug → 提前代码生成。

## R3 · Tauri 命令 rename 依赖 ≥ 2.11 — 影响:低 / 概率:低

点号命令名依赖 `#[tauri::command(rename)]`(2.11 引入)。已用 2.11.4。

**缓解**:lockfile 固定;升级 Tauri 时回归 `system.ping` 回环。**回退**:命令名改蛇形(仅影响协议文档)。

## R4 · npmmirror 镜像元数据不全 — 影响:中 / 概率:高(已发生)

`^5` 曾把 TypeScript 解析到 5.0.2。**已处置**:关键工具链显式锁定精确版本(typescript 5.9.3);`pnpm-lock.yaml` 入库。**后续**:新增依赖后核对实际解析版本;必要时对单包指定 `--registry=https://registry.npmjs.org`。

## R5 · 大文件与内存目标(100MB+)— 影响:高 / 概率:中

Phase 1 导入管线若一次性载入 JS 内存将直接违反性能目标。

**缓解**:Rust 侧流式 hash/落盘;foliate 只接收 URL;TXT 管线分块处理;Sprint 5 验收含 100MB+ 样本。

## R6 · PDF 深色模式的"精准反转"承诺 — 影响:中 / 概率:高

像素级元素分类(图片/图表/公式保护)成本极高。**缓解**:按规范 §27 明确实现分级 —— 简单反色必须标记"近似模式";元素级反转作为实验特性(FeatureFlag)。绝不伪装精准。

## R7 · 跨平台能力差异(Tauri Mobile)— 影响:高 / 概率:中

移动端多插件/能力不可用(安全存储、全局快捷键等)。**缓解**:所有原生能力经 `PlatformService` 抽象(Phase 7 落地);每个 Phase 的 DoD 含桌面/移动适配检查;移动端在 Phase 7 前不承诺。

## R8 · 阅读性能目标(60/120fps)— 影响:高 / 概率:中

React 重渲染、玻璃效果与动画可能挤压渲染预算。**缓解**:阅读画布独立于 React 树(引擎自绘);玻璃仅用于容器;Phase 1 起纳入 PerfMonitor 基线。

## R9 · AI 成本与隐私 — 影响:高 / 概率:中

全书处理可能将完整书籍发送云端。**缓解**:默认本地优先;云端调用必须显示 Provider/Model/发送范围(spec §48);UI 层强制确认门。

## R11 · 极短章节的进度分数偏差 — 影响:低 / 概率:高(已观察)

两章小书打开时进度显示 50.1%(kernel SectionProgress 对"整章一页"的 pageFraction 取值)。真实书籍章节多页,现象不显著。**缓解**:polish 阶段向内核提 issue 或在前端对首屏 relocate 做校正。

## R10 · 依赖供应链 — 影响:中 / 概率:低

**缓解**:pnpm lockfile + `pnpm approve-builds` 白名单(仅 esbuild);CI 固定依赖版本安装(`--frozen-lockfile`);引入新依赖必须评估(ADR-0001 规则)。注意:CI 镜像源在本仓库不用,仅用官方 registry。

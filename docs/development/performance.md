# 性能预算与测量(Phase 8,spec §69/§70/§139)

目标:快速启动、低内存、阅读 60fps+(高刷 90/120Hz 自适应)、大书(100MB+)不卡顿、AI/同步不阻塞阅读。

## 当前基线(2026-09-15,macOS arm64 release 构建)

| 指标                           | 数值                                            | 预算         |
| ------------------------------ | ----------------------------------------------- | ------------ |
| 前端产物(dist)                 | 5.5 MB(主 JS 664 KB,PDF 适配器 424 KB 独立分包) | 主 JS ≤ 1 MB |
| Rust 二进制(release,strip+LTO) | 12 MB                                           | ≤ 20 MB      |
| 阅读路径阻塞                   | 渲染全在 foliate-js;rAF 由内核管理              | 60fps+       |

## 已落实的机制

- **懒加载**:PDF(pdf-book + pdfjs)按需动态 import;AI/词典/TTS/学习均为用户触发的独立面板,不在阅读路径上。
- **流式/后台**:AI 聊天与 TTS 走 Rust 异步代理(不阻塞 UI);导入哈希在 Rust 流式计算;同步为显式触发。
- **Release profile**:`lto = "thin"`、`codegen-units = 1`、`strip = "symbols"`。
- **进度防抖**:阅读进度 800ms 防抖 + pagehide/hidden 冲刷(§128),避免高频写库。

## 测量方法

```bash
# 前端产物
pnpm build && du -sh apps/desktop/dist/assets/*
# 启动时间(手动):冷启动到书架可交互,用 Xcode Instruments → App Launch 模板
# 阅读帧率(开发模式):spec §139 的性能监视器尚未实现,暂用浏览器 devtools FPS meter
# 内存:Xcode Instruments → Allocations,打开 100MB+ TXT/PDF 样书前后对比
```

## 开发模式监视器(plan B9.4,2026-11-18 落地)

`DevStatsOverlay`(src/components/)在 `import.meta.env.DEV` 挂载:每秒结算
FPS(rAF 计数)+ Chromium 私有 `performance.memory` 堆读数,并轮询
`dev.process.stats`(Rust 侧 `ps -o rss=,pcpu=`)拿进程 RSS 与 CPU%。生产
构建整组件被 Vite 树摇掉。**读数锚点:交互帧预算 16ms(≈60fps),FPS 持续
< 55 就去 Performance 面板找原因,不要猜。**

## 100MB+ 大书实测矩阵(待真机实测,数据到手即填)

构建:release。工具:overlay 读数 + `xcrun instruments`(macOS)。矩阵行
按「书格式 × 书大小」给,每格填 打开耗时 / 翻页 P95 / 全书搜索 / 内存峰值。

| 格式        | 大小 | 打开 | 翻页 P95 | 全书搜索 | 内存峰值 |
| ----------- | ---- | ---- | -------- | -------- | -------- |
| EPUB        | 待填 | 待填 | 待填     | 待填     | 待填     |
| TXT(100MB+) | 待填 | 待填 | 待填     | 待填     | 待填     |
| PDF(100MB+) | 待填 | 待填 | 待填     | 待填     | 待填     |
| AZW3/MOBI   | 待填 | 待填 | 待填     | 待填     | 待填     |

> 约定:没有实测数据就保持「待填」,不编数。跑矩阵的步骤:打开 dev 构建 →
> overlay 记录稳态 RSS → 各操作三轮取 P95 → 填表并带日期。

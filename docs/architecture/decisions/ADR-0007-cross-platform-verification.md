# ADR-0007 · 跨平台验证矩阵与移动端工程策略

- 状态:Accepted(2026-09-14,Phase 7)
- 背景:spec PHASE 7 要求按序支持 macOS / Windows / Linux / Android / iOS,且"每个平台必须单独验证"。本机为 macOS(arm64);验证手段与瓶颈因平台而异,需要一次如实的矩阵记录,避免"声明支持却从未验证"。
- 决策:
  1. **验证矩阵**(2026-09-14 实测,工具链:Xcode 27 beta、NDK 28.2、mingw-w64、Rust 1.9x):
     | 平台             | 验证方式                                                                                         | 结果                                                                                                                                             |
     | ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
     | macOS (arm64)    | `tauri build` 完整打包                                                                           | ✅ `Deepread.app` 产出(ad-hoc 签名;DMG 封装依赖 Finder/AppleScript,本无头环境不可用,属 Phase 8 签名/发布管线事项)                                |
     | Windows (x86_64) | `cargo check --target x86_64-pc-windows-gnu`(mingw 提供 C 交叉编译器;不链接、不产包)             | ✅ 全依赖树类型检查通过;**期间抓到并修复一个 Windows 专属编译错误**(`getrandom_fill` 的 `&mut [u8]` move,unix 分支编译时 Windows 分支从不被检查) |
     | Linux            | 本机无 GTK 系统库,无法交叉验证                                                                   | ❌ 未验证;reqwest(rustls)/keyring(sync-secret-service)等依赖均为跨平台选型,留待 Linux 机器或 CI                                                  |
     | Android (arm64)  | `tauri android init` + `tauri android build --target aarch64 --debug`                            | ✅ `app-universal-debug.apk`(含 `lib/arm64-v8a/libdeepread_desktop_lib.so`);无模拟器系统镜像,运行时验证待真机/模拟器                             |
     | iOS (sim)        | `tauri ios init` + `tauri ios build --target aarch64-sim --debug` + iPhone 17 Pro 模拟器安装启动 | ✅ 构建、安装、**运行时验证通过**(书架空状态 UI 完整渲染,进程存活;截图记录于会话)                                                                |
  2. **移动端 Xcode 27 适配**(产生两处模板修补,均已入库):
     - `IPHONEOS_DEPLOYMENT_TARGET` 14.0 → 15.0(Xcode 27 支持区间 15.0-27.x)。
     - `deepread-desktop_iOS/Info.plist` 增加 `UIApplicationSceneManifest`,且 `UIApplicationSupportsMultipleScenes=true`:iOS 27 SDK 对未采用 UIScene 生命周期的应用直接 `EXC_BREAKPOINT`(trap 栈:`UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`)。tao 0.35.3 已实现 `application:configurationForConnectingSceneSession:` 并动态挂载 `TaoSceneDelegate`,但其 `multiple_scenes_enabled()` 以 manifest 中 `UIApplicationSupportsMultipleScenes` 的**值**为开关——设 false 时反而不注册回调(tao#1308,open)。设 true 规避,代价是 iPad 上可能出现多窗口阅读;上游修复 #1308 后应改回 false。
  3. **gen/ 移动工程入库**:Tauri 惯例——`gen/apple`、`gen/android` 是会被持续定制(签名团队、图标、manifest)的源工程,提交入库;其构建产物(`build/`、`**/build/`、`.gradle`)继续忽略。
  4. **Platform 抽象遵循 spec §114/§115**:前端不做 `if isMac` 分支;平台差异收敛在两处——Rust 侧(cfg(unix)/cfg(windows) 能力实现,如 secrets 权限、随机源)与 Webview 能力探测(如 TTS:系统语音不可用时 UI 如实降级提示并可选云端语音,即 spec 的 Platform Adapter 形态)。
- 事实记录:
  - 移动构建的 Rust 编译由 Xcode/Gradle 脚本阶段回连 `tauri` CLI 的本地 JSON-RPC 端口完成——直接调 `xcodebuild`/`gradlew` 而无父 CLI 时必然 `ConnectionRefused`,必须走 `tauri ios/android build` 入口。
  - `android-studio-script`/`xcode-script` 的 panic(SIGABRT/134)即上述回连失败,不是 Rust 代码崩溃。
  - SwiftPM 依赖 swift-rs 需在构建期 clone 自 GitHub;直连 443 超时的网络下,用**作用域环境变量** `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.git@github.com:.insteadOf GIT_CONFIG_VALUE_0=https://github.com/` 重写为 SSH(不改全局 git 配置)。
  - `tauri ios build` 二次运行报 `os error 66`(Directory not empty):上次产物残留在 `build/arm64-sim/Deepread.app`,删除目标目录重跑即可。
  - mingw-w64 使 `cargo check --target x86_64-pc-windows-gnu` 可用(ring 的 C 部分由 mingw gcc 编译);MSVC 目标的检查需要 MSVC 编译器,本机不可行。
- 后果:iOS/Android 的发布级验证(签名、真机、商店合规)顺延至 Phase 8 与真机可用时;Linux 需要 CI 任务(`ubuntu-latest` + tauri 依赖)补齐;上游 wry 0.57/tao 0.36 的 Android 生命周期重命名等变更暂不追升,等 tauri 核心发布对应依赖再随更。

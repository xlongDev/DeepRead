# ADR-0014: 隐蔽阅读模式 —— 全局热键隐藏/恢复窗口

日期:2026-11-18
状态:已接受

## 背景

「上班摸鱼看书」是阅读器的经典场景:全局热键一键把整个窗口(连同任务栏/Dock)
藏起来,再按同键恢复。窗口级快捷键做不到——焦点在别的应用时收不到按键,
这必须是**系统级** hook。关窗 = 隐藏进托盘的既有行为(ADR-0013)已经把窗口
生命周期铺好了,本 ADR 只补"全局热键"这一条腿。

## 考虑的选项

1. **tauri-plugin-global-shortcut**(官方):注册系统级快捷键,回调给
   Rust。跨平台(⌘/Win/Meta 由 `CmdOrMeta` 抹平),零自研。
2. 前端 `navigator.keyboard`/window 级监听:焦点不在本应用时收不到,
   语义上就不成立,排除。
3. 自研平台 hook(macOS Carbon RegisterEventHotKey / Windows
   RegisterHotKey):三平台三套 unsafe 代码,无收益。

选 1。这是 ADR-0011 之后第一个新运行时依赖(官方插件)。**权限面收敛**:
注册/注销只发生在 Rust 侧(setup 读 app_settings + 专用命令),不向
webview 开放该插件的任何 permission(capabilities 不加条目)——webview
对全局热键没有直接操控面,只有「隐私开关」这一个语义动作。

## 决定

- 开关落 `app_settings`(`privacy.hideHotkey`,"on"/"off"),**默认关闭**
  —— 隐蔽模式是显式选择的功能,不给用户惊喜。
- 热键固定 `⌥⌘H`(Windows/Linux `Alt+Meta+H`),v1 不可改(项目级键位
  自定义体系管的是应用内快捷键;全局热键撞系统注册冲突的处理成本另议)。
- 行为 = 窗口可见则隐藏、不可见则恢复:与托盘菜单共享同一个 toggle。
- 托盘菜单加「隐藏 / 恢复窗口」项,与热键同语义。

## 后果

- 设置页新增隐私开关(快捷键分区,它本来就是键盘快捷键语义)。
- 全局热键与其他应用的注册冲突时 `register` 报错:开关如实报错而不是
  假装已开启。

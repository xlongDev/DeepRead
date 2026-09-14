# 发布与签名指南(Phase 8,spec §56/§126/§138)

当前状态:**没有代码签名证书**——发布产物为 ad-hoc 签名/未签名,更新器签名(minisign,免费)已完整可用。拿到证书后按第 3 节填空即可,管线不需要改动。

## 1. 本地发布

```bash
node scripts/release.mjs                # 全门禁 + 构建 + 产物收集 + 校验和
node scripts/release.mjs --skip-gates   # 跳过门禁(已单独跑过时)
```

产物落在 `release/v<版本>/`,附 `SHA256SUMS`;macOS 下 `.app` 会打 zip(dmg 封装依赖 Finder/AppleScript,交给 CI 或手动)。

macOS 本地直接打开未签名 app:右键 → 打开,或 `xattr -cr Deepread.app`(ad-hoc 签名会被 Gatekeeper 拦)。

## 2. 更新器(updater,spec §56)

- 公钥已固化在 `tauri.conf.json → plugins.updater.pubkey`(minisign,2026-09-15 生成)。
- 私钥在 `~/.tauri/deepread.key`(**不入库,务必备份;丢失后已发布的更新通道作废**)。
- `TAURI_SIGNING_PRIVATE_KEY=/absolute/path/to/key pnpm tauri build` 会产出 `.sig` 更新工件与 `latest.json`(脚本自动聚合)。
- 更新源:endpoint 目前是占位(`deepread-updates.example.invalid`),在 conf 里换成真实地址即可。静态托管最省事:把 `latest.json` 与对应工件传到任意静态桶,URL 模板 `https://<host>/{{target}}/{{arch}}/{{current_version}}`。
- 应用内入口:书架 → 设置 → 更新 →「检查更新 / 下载并安装 / 忽略此版本」(校验失败会明确报错,不会静默安装)。
- 渠道(spec §138):stable/beta/nightly 用不同路径前缀即可(如 `/stable/...`),CI 的 workflow_dispatch 已带 channel 参数(prerelease 标记)。

## 3. OS 代码签名(有证书后)

| 平台    | 需要什么                                                                                                  | 接线点                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Apple Developer ID Application 证书 + 公证(Apple ID / App-specific password 或 App Store Connect API key) | CI secrets:`APPLE_SIGNING_IDENTITY`、`APPLE_CERTIFICATE(+_PASSWORD)`、`APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID`(tauri-action 自动公证与 stapler) |
| Windows | Authenticode 证书(EV/OV)或 Azure Trusted Signing                                                          | CI secrets 提供证书后 tauri-action 自动 sign;本地用 `signtool sign /fd SHA256`                                                                 |
| Linux   | 无强制签名;可选 AppImage 签名                                                                             | —                                                                                                                                              |

签名是纯增量:secrets 配好即生效,`release.yml` 已把环境变量占位接好;本地无证书时这些变量为空,行为不变。

## 4. 版本与回滚

- 版本号唯一来源:`apps/desktop/src-tauri/tauri.conf.json → version`(spec §124)。
- 更新器安装失败由 OS 安装器自回滚;应用数据在 SQLite(WAL)中,更新只替换程序文件,数据不受影响(§128)。
- 灾难回滚:重新发布上一个版本号 +1 的补丁包(更新器不降级)。

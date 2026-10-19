# 发布签名与更新通道

应用更新客户端已接入 Tauri updater，公钥保存在 `src-tauri/tauri.conf.json`，更新清单地址指向本仓库 Release 的 `latest.json`。安装前会询问保存工作与处理事务；更新下载有进度，安装后可重启。

## 当前材料状态

- 本机已生成更新签名密钥：`.release/updater.key` 与 `.release/updater.key.pub`。目录被 Git 忽略，私钥权限为 0600，未写入日志或提交。不要删除/轮换这对密钥后继续使用已分发客户端的旧公钥。
- 仓库目前没有签名 Secrets，本机没有可用 Developer ID 签名身份。正式原生签名、公证和签名更新发布不能仅靠修改代码完成。
- 本次没有同步远端 Secrets，也未触发新版本发布。后续明确安排发布配置时，再将对应材料写入仓库 Secrets。

## GitHub Actions Secrets

| 用途 | 名称 | 来源 |
|---|---|---|
| macOS 签名 | `APPLE_CERTIFICATE` | Developer ID Application 证书和私钥的 P12，以 Base64 存储 |
| P12 解密 | `APPLE_CERTIFICATE_PASSWORD` | 对应证书密码；未加密 P12 可为空 |
| 签名身份 | `APPLE_SIGNING_IDENTITY` | 完整 Developer ID Application 身份名称 |
| 公证 | `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` | Apple 账号、公证用 app-specific password、Team ID |
| Windows 签名 | `WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD` | 包含私钥的 PFX（Base64）及其密码 |
| 更新包签名 | `TAURI_SIGNING_PRIVATE_KEY` | 本地 `.release/updater.key` 的内容；不是原生签名证书 |
| 更新密钥密码 | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 本地这对密钥使用空密码，Secret 可为空 |

真实材料只放本地忽略目录或 Secret 管理，不放配置模板、Git 或正文。Windows 导入脚本使用临时文件并及时移除；公钥和证书 thumbprint 不是私钥。

## 流程与校验

`.github/scripts/prepare-release.mjs` 生成临时配置 overlay，不把密码或私钥写入该文件。选择平台的原生签名材料不完整时会在打包前失败；未配置原生证书时仍可按既有流程生成未签名包，并在 Release 文案中说明。

配置更新私钥后，overlay 开启 `createUpdaterArtifacts`，Tauri action 生成签名和更新清单。必须先发布包含 updater 的新版本，且随后的更新包使用与客户端公钥匹配的私钥。HTTP 或未签名清单不能作为回退渠道。

版本仍按 package.json、Cargo.toml/Cargo.lock、Tauri 配置和标签同步的现有流程维护。Rust 最低版本更新为 1.88，SQLx 与 SQLite FFI 版本固定配套，避免底层 handle ABI 不一致。

参考：[Tauri updater](https://v2.tauri.app/plugin/updater/)、[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Tauri Windows 签名](https://v2.tauri.app/distribute/sign/windows/)。

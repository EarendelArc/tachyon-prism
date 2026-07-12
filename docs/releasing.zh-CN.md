# Prism 发布流程

## 通道与标签

发布工作流只接受以下两类已经存在的 Git 标签：

- stable：`vMAJOR.MINOR.PATCH`，例如 `v0.1.0`。
- prerelease：`vMAJOR.MINOR.PATCH-(alpha|beta|rc|pre|preview)[.N]`，例如
  `v0.1.0-alpha.1` 或 `v0.1.0-rc.2`。

标签后缀前的版本必须与 `package.json`、`src-tauri/Cargo.toml` 和
`src-tauri/tauri.conf.json` 一致。推送标签时从标签自动判断通道；手动触发时必须填写
一个已存在的标签并选择通道，二者不一致会在测试和构建前失败。手动任务检出的是标签
本身，不是启动工作流时所在的分支。

stable 会被标记为 GitHub Latest Release。prerelease 会被标记为预发布，并明确排除在
Latest 之外。重新运行并编辑已有 Release 时也会按已校验标签重设这两个状态，避免保留
旧通道信息。

## 构建矩阵

| 下载标识 | GitHub runner | Rust target | 发布包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | NSIS `.exe`、MSI `.msi` |
| Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | NSIS `.exe` |
| macOS x64 | `macos-15-intel` | `x86_64-apple-darwin` | `.dmg` |
| macOS ARM64 | `macos-15` | `aarch64-apple-darwin` | `.dmg` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | Debian `.deb` |
| Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | Debian `.deb` |

CI 会在相同的六组 runner/target 上运行 Rust check 和 tests。静态发布契约测试会比较
CI 与 Release 矩阵，发生漂移就失败。GitHub 目前仍把标准 Windows ARM64 和 Linux
ARM64 runner 标记为 public preview，因此首次发布前仍需确认仓库或组织可以使用这些
runner。

每个构建都会上传 Actions artifact。发布任务只有在六个 artifact 目录都包含实际产物
和签名状态记录时，才会创建或更新 GitHub Release。Release 文件名包含平台标识，
`SHA256SUMS.txt` 覆盖全部可下载安装包和发布说明。

## 签名策略

工作流绝不伪造签名。stable 缺少任意 Windows 或 Apple 必需值都会失败。prerelease
只有在某平台的整组凭据全部为空时，才允许明确跳过该平台签名；只配置半套凭据会失败。
生成的 Release Notes 会记录每个目标的实际签名状态。

Windows Authenticode 签名需要配置以下 GitHub Actions secrets：

- `WINDOWS_CERTIFICATE`：包含代码签名证书和私钥的 PFX，经 base64 编码后的内容。
- `WINDOWS_CERTIFICATE_PASSWORD`：PFX 导出密码。

同时把证书颁发机构提供的 RFC 3161 时间戳服务地址配置为仓库 Actions variable
`WINDOWS_TIMESTAMP_URL`。工作流会把 PFX 导入临时 runner 的证书库，通过临时 Tauri
配置完成签名，并用 `Get-AuthenticodeSignature` 验证每个 EXE/MSI。

macOS Developer ID 签名与公证需要配置以下 GitHub Actions secrets：

- `APPLE_CERTIFICATE`：Developer ID Application `.p12` 的 base64 内容。
- `APPLE_CERTIFICATE_PASSWORD`：`.p12` 导出密码。
- `APPLE_API_ISSUER`：App Store Connect API issuer ID。
- `APPLE_API_KEY`：App Store Connect API key ID。
- `APPLE_API_PRIVATE_KEY`：对应 `.p8` 私钥文件的完整内容。

工作流会创建临时 keychain，严格要求 Developer ID Application identity，并把 App
Store Connect API key 交给 Tauri。构建后再使用 `codesign`、`stapler` 和 `spctl`
验证签名与公证结果。

Linux Debian 包目前没有 GPG 签名，发布状态会写为 `not-applicable-unsigned`；用户必须
校验 `SHA256SUMS.txt`。后续增加 Linux 包签名时，需要单独托管签名私钥，并先确定和
公布公钥验证策略。

## 校验

无需构建安装包即可在本地运行静态契约检查：

```bash
python scripts/validate_release.py --check-workflows
python scripts/validate_release.py --tag v0.1.0-alpha.1 --channel prerelease
```

发布 stable 前，先通过正常的应用版本变更流程同步三个版本字段，运行 CI，创建并推送
精确的 stable 标签，并确认全部签名凭据已配置。工作流会执行最后的版本、通道、产物、
签名和 checksum 门禁。

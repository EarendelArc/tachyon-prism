# Prism 发布流程

## 通道与标签

发布工作流只接受已经存在的 Git 标签：

- 稳定版：`vMAJOR.MINOR.PATCH`，例如 `v0.1.0`。
- 预发布版：`vMAJOR.MINOR.PATCH-(alpha|beta|rc|pre|preview)[.N]`。

标签版本必须与 `package.json`、`src-tauri/Cargo.toml` 和
`src-tauri/tauri.conf.json` 一致。stable 会成为 GitHub Latest Release；
prerelease 必须明确排除在 Latest 之外。

发布标签必须是 annotated tag，lightweight tag 会直接失败。prepare job 会把远端标签
取到隔离 ref，验证 tag object、peeled commit 和完整对象 ID。后续测试、构建和发布 job
全部检出同一个已验证 commit。相同标签共享不可取消的并发组，避免两个发布事务竞争。

仓库必须在发布前启用 GitHub immutable releases，并配置覆盖 `refs/tags/v*` 的 active
tag ruleset，禁止 update、deletion 和 non-fast-forward，且不得配置 bypass。最终标签复核
紧邻创建 draft 的 API 写操作，但它不能替代远端不可变策略。

## Core 兼容契约

`core-contract.json` 固定 `EarendelArc/tachyon-core` 的 annotated release tag、完整 tag
object 和 peeled commit。当前契约为：

- tag：`v0.1.0-alpha.21`
- tag object：`26ac54b682c7d0e3a65f8a35662c6d7f11724001`
- commit：`12df9c561a921bed7fc5f63a2ea166e7227d773f`

CI 与 Release 在 Linux、macOS 和 Windows 上检出该精确提交并验证 tag peel。真实契约测试
使用 Prism 生产配置生成器构造 `client.json`，验证合法配置，并注入 `not-a-cidr`，要求
Core 拒绝且错误定位到 `client.tun.game_routes[0]`。Linux/macOS 必须在 TUN ready 前拒绝
不受支持的选择性路由。Windows 使用 `go test -json` 精确证明以下五个测试各产生一次
`run` 和一次 `pass`，且没有 `fail` 或 `skip`：

- `TestParseGameRoutePrefixesNormalizesHostBits`
- `TestPlanSelectiveRoutesNormalizesAndDeduplicates`
- `TestWindowsRouteRowsRequireExactIdentityAndAttributes`
- `TestInstallRouteTransactionRollsBackInReverseOrder`
- `TestWindowsRouteJournalRecordFailureRollsBackCreatedRouteUnderLock`

这些测试不会启用真实系统代理、路由或 TUN。

## 构建矩阵

| 下载标识 | GitHub runner | Rust target | 发布包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | NSIS `.exe`、MSI `.msi` |
| Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | NSIS `.exe` |
| macOS x64 | `macos-15-intel` | `x86_64-apple-darwin` | `.dmg` |
| macOS ARM64 | `macos-15` | `aarch64-apple-darwin` | `.dmg` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | Debian `.deb` |
| Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | Debian `.deb` |

最终 Release 必须精确包含 11 个资产：7 个安装包、`RELEASE_NOTES.md`、
`RELEASE_NOTES.zh-CN.md`、`BUILD_METADATA.json` 和 `SHA256SUMS.txt`。清单必须精确覆盖
其余 10 个资产。带 schema 版本的构建元数据记录完整 Prism tag object/commit、Core
tag/tag object/commit、`SOURCE_DATE_EPOCH`、工具版本，以及按文件名稳定排序的 7 个安装包
SHA-256 映射。

工作流会把暂存文件和目录的时间戳归一化为 `SOURCE_DATE_EPOCH`，但不宣称签名安装包能够
逐字节复现。Authenticode 时间戳、Apple 签名和公证、安装器内部数据仍可能变化。

## 发布事务与远端复核

发布采用 fail-on-existing：相同标签只要已有任意 Release（包括 draft）就停止。事务创建
新 draft，只上传一次完整资产集，不使用 `--clobber`，然后发布该 draft。上传或 PATCH
失败时，EXIT trap 只检查本事务返回的 release ID；仅当它仍是相同标签且 `draft=true`
时才删除。已成为正式 Release 的对象绝不会被清理逻辑删除。

Release 正文由完整英文说明、分隔线和完整中文说明组成。发布后必须通过 GitHub API
fail-closed 复核：tag、完整 target commit、`draft=false`、prerelease 状态、
`immutable=true`、Latest 语义、双语正文、精确 11 个资产和每个远端 digest 都必须与本地
暂存契约一致。任何字段缺失或不一致都会让发布 job 失败。

## 签名策略

签名不会被模拟。稳定版缺少任意 Windows 或 Apple 必需凭据都会失败；预发布版仅在某平台
整组凭据完全为空时允许明确发布未签名产物，半套凭据仍会失败。Windows 使用
Authenticode，macOS 使用 Developer ID 与公证。Linux `.deb` 当前没有 GPG 签名，用户
必须验证 `SHA256SUMS.txt`。

## 本地校验

```bash
python scripts/validate_release.py --check-workflows
python scripts/validate_release.py --tag v0.1.0-alpha.22 --channel prerelease
npm test
```

发布前还必须确认源码已推送且远端 CI 在同一完整 commit 上通过，并读回 immutable release
设置与 tag ruleset。工作流负责最终版本、通道、Core 契约、资产、签名、清单和发布后状态
门禁。

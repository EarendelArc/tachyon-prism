# Prism 发布流程

## 通道与标签

发布工作流只接受已经存在的 Git 标签：

- 稳定版：`vMAJOR.MINOR.PATCH`，例如 `v0.1.0`。
- 预发布版：`vMAJOR.MINOR.PATCH-(alpha|beta|rc|pre|preview)[.N]`。

标签版本必须与 `package.json`、`src-tauri/Cargo.toml` 和
`src-tauri/tauri.conf.json` 一致。stable 会成为 GitHub Latest Release；
prerelease 必须明确排除在 Latest 之外。

发布标签必须是带有效密码学签名的 annotated tag；lightweight tag 与未签名 annotated tag
都会直接失败。prepare job 会把远端标签
取到隔离 ref，验证 tag object、peeled commit 和完整对象 ID。后续测试、构建和发布 job
全部检出同一个已验证 commit。相同标签共享不可取消的并发组，避免两个发布事务竞争。

仓库必须在发布前启用 GitHub immutable releases，并配置覆盖 `refs/tags/v*` 的 active
tag ruleset，禁止 update、deletion 和 non-fast-forward，且不得配置 bypass。最终标签复核
紧邻创建 draft 的 API 写操作，但它不能替代远端不可变策略。

## Core 兼容契约

`core-contract.json` 固定 `EarendelArc/tachyon-core` 的 annotated release tag、完整 tag
object 和 peeled commit。当前契约为：

- tag：`v0.1.0-alpha.22`
- tag object：`65f57643ae5644233033c3a3a7332290ff1ceeb6`
- commit：`80d9fb742c025387c1f036da846fc663ed8a7067`

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

最终 Release 必须精确包含 13 个资产：7 个安装包、`RELEASE_NOTES.md`、
`RELEASE_NOTES.zh-CN.md`、`BUILD_METADATA.json`、`RELEASE_INDEX.json`、
`RELEASE_MANIFEST.json` 和 `SHA256SUMS.txt`。清单必须精确覆盖其余 12 个资产。带 schema
版本的构建元数据记录完整 Prism tag object/commit、Core
tag/tag object/commit、`SOURCE_DATE_EPOCH`、工具版本，以及按文件名稳定排序的 7 个安装包
SHA-256 映射。

工作流会把暂存文件和目录的时间戳归一化为 `SOURCE_DATE_EPOCH`，但不宣称签名安装包能够
逐字节复现。Authenticode 时间戳、Apple 签名和公证、安装器内部数据仍可能变化。

## 发布事务与远端复核

发布是可重入的四作业事务。A 作业只使用 `RELEASE_SETTINGS_TOKEN` 执行 immutable release
与 ruleset 预检；B 作业只使用具有 contents write 权限的 `GITHUB_TOKEN` 创建或恢复精确
draft，并在不使用 `--clobber` 的前提下仅上传缺失资产；C 作业再次只使用设置令牌复检治理
状态；D 作业只使用 contents write 令牌校验完整 draft、公开并执行 immutable 读回验证。
设置令牌和内容写令牌不会出现在同一个 step 或进程环境中。

同标签已有 draft 仅在其数字 ID、完整 target commit、名称、预发布标记、双语正文，以及
每个已有资产的 digest/size 都与本地事务一致时才允许恢复。额外、重复或被修改的资产以及
错误 target 都会 fail-closed。上传失败或第二次治理复检失败时，draft 保持私有并原样保留，
供 workflow rerun 幂等续传；流程不会删除 Release。已有公开 Release 绝不会被编辑或替换。

Release 正文由完整英文说明、分隔线和完整中文说明组成。发布后必须通过 GitHub API
fail-closed 复核：tag、完整 target commit、`draft=false`、prerelease 状态、
`immutable=true`、Latest 语义、双语正文、精确 13 个资产和每个远端 digest/size 都必须与本地
暂存契约一致。任何字段缺失或不一致都会让发布 job 失败。

两个纯治理作业会在第一次 GitHub 写操作前和公开 draft 前分别执行独立预检：读取 immutable releases 设置，
分页枚举仓库 ruleset 摘要，再读取每个候选 ruleset 的完整内容。只有至少一个 active tag
ruleset 覆盖 `refs/tags/v*`、没有 bypass actor，并同时包含 deletion、update 和
non-fast-forward 规则时才允许继续。分页缺失、JSON 结构异常、权限错误或 API 故障全部
fail-closed。Latest 读回同样只把明确的 HTTP 404 解释为“没有 Latest”；401、403、网络错误
和服务端错误都会阻断发布。

`BUILD_METADATA.json` 按完整 schema 精确校验。prepare job 显式传入已验证 tag object、
commit 时间戳、标签验证方式、可复现性声明和完整工具版本对象；这些值在上传前及最终远端
复核时都必须完全一致，不能仅凭字段格式合法而通过。

仓库 Actions secret 必须配置 `RELEASE_SETTINGS_TOKEN`。该独立细粒度凭据需要能够读取仓库
immutable release 设置和包含 `bypass_actors` 的完整 ruleset 内容。它应与普通发布
`GITHUB_TOKEN` 分离。GitHub 可能只向具有 ruleset 写权限的凭据返回 bypass actor，尽管
Prism 实际只执行 GET 请求。工作流顶层权限为 `contents: read`，只有草稿与公开作业具有
job 级 `contents: write`；设置令牌只进入治理 step，写令牌只进入草稿/公开 step。

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

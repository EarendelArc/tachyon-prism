# Tachyon Prism

[English](README.md)

Tachyon Prism 是 Tachyon 的图形化控制面。

Prism 设计目标是成为支持 Tachyon Core 的 Xray GUI 客户端，但当前仍处于 alpha 阶段。它负责交互、可视化、订阅、节点选择、Xray 生命周期、Xray JSON 生成、路由 UI、规则 UI、游戏进程检测和双核心编排。普通代理流量走 Xray，游戏 UDP 流量可以交给 Tachyon Core 做低延迟加速。

stable 线目标是逐步成为较完整的 Xray GUI，并提供可选 Tachyon 游戏加速，但当前 alpha 还不能宣称完整或稳定。Windows 系统代理控制已经实现并接入 UI，但仍是 alpha 功能，尚未针对真实 Windows 宿主注册表完成验收；macOS 和 Linux 系统代理仍不支持。TUN 一键接管仍保持禁用，并且是 stable 发布门禁。

## 当前功能

- 运行时与游戏配置状态看板。
- 双核心实时流量图，分别显示 Tachyon 与 Xray 的上行/下行曲线。
- 本地手动游戏程序配置。
- 本地 Steam 游戏库扫描与游戏配置建议。
- 持久化 Steam 启动器策略，包括子进程跟踪、游戏 UDP 加速和可选 Steam 下载加速。
- 按程序配置 UDP/TCP 路由策略。
- 支持从订阅 URL 或粘贴内容导入节点。
- 本地节点列表与选中节点持久化。
- 桌面端通过 Prism 侧 TCP 连接探测刷新节点延迟。
- 根据选中节点生成 Xray 客户端 JSON 草稿。
- 生成用于 TGP 游戏路径的 Tachyon Core 客户端 JSON 草稿。
- 一键把生成的 `client.json` 和 `xray-client.json` 保存到 Tauri 应用配置目录。
- 持久化 Xray Core 和 Tachyon Core 的运行二进制路径。
- 运行时网络设置，包含 Xray SOCKS、Xray HTTP 探测入站、Xray StatsService、Tachyon IPC、Tachyon gRPC、TUN 地址/MTU 和遥测间隔。
- 通过生成的 Xray HTTP/SOCKS 入站进行本地代理探测，不修改系统代理，也不启用 TUN。
- Windows 系统代理使用事务式 WinINet 流程，包含快照、应用后验证、恢复和启动时崩溃恢复。该功能尚未达到生产可用，仍需真实宿主注册表验收。
- macOS 和 Linux 系统代理不受支持。Tachyon TUN 一键接管仍禁用，并且是 stable 发布门禁。
- 把本地二进制安装到 Prism 应用配置目录下的托管 `bin` 目录。
- 从 GitHub release channel 发现、下载、SHA-256 校验并托管安装最新版 Xray Core 和 Tachyon Core。
- 只读 Core release diagnostics，用于排查发布通道、tag、资产、checksum、安装路径、
  版本状态和错误。
- 脱敏客户端诊断导出，用于 alpha 支持包回传；不会启动核心、切换代理、启用 TUN 或写入 runtime settings。
- 为 Xray Core 与 Tachyon Core 的托管下载分别选择 `stable` / `preview` 发布通道。
- 作为独立子进程启动和停止 Xray Core 与 Tachyon Core。
- 启动前配置验证：每次启动前都会用 `xray run -test -config` 校验 Xray 配置，并用 `tachyon-core validate --config` 校验 Tachyon Core 配置。
- Tachyon Core TUN 权限检测是只读状态提示；当前 alpha 不因 TUN 权限不足阻止 Core 启动，因为生成配置会强制关闭 OS 级 TUN 接管。
- Windows 运行时会检查 Tachyon Core 配置二进制同目录下必需的 `wintun.dll` sidecar。

## 订阅边界

Prism 在本地解析订阅内容，并把选中节点保存在桌面控制面。Prism 也负责游戏配置和启动器扫描。Core 不保存订阅，不拉取订阅 URL，也不管理 GUI 侧游戏规则。

当前解析器支持的输入格式：

| 输入 | 当前行为 |
| --- | --- |
| `vless://...` | 导入为 Xray 兼容 outbound 草稿，并保留常见 transport/TLS 字段。 |
| `vmess://...` | 导入并保留 transport 设置，包括 WebSocket 分享链接。 |
| `trojan://...` | 导入为 Xray Trojan outbound；Trojan-Go 兼容参数会在 Xray 支持范围内映射。 |
| `ss://...` | 导入为 Xray Shadowsocks outbound。 |
| `socks://...` / `socks5://...` | 导入为 Xray SOCKS outbound。 |
| `http://...` / `https://...` | 导入为 Xray HTTP outbound。 |
| `hysteria://...` / `hysteria2://...` / `hy2://...` | 导入并保留常见 Clash/Mihomo TLS、auth、ALPN 和 UDP idle 字段。 |
| `tuic://...` | 支持从 URI 和 Clash/Mihomo proxy 输入导入为可选择的 Xray 兼容节点。 |
| 基础 `wireguard://...` | 存在密钥材料时导入，并保留常见 peer 和 interface 字段。 |
| 完整 Xray outbound JSON 对象 | 尽量无损保存，并直接用于生成 Xray 配置草稿。 |
| 带 `outbounds` 的完整 Xray config JSON | 抽取并保留可用 outbound 对象。 |
| 普通或 Base64 多行 payload | 解码为支持的分享链接；跳过/无效条目会显示在导入诊断中。 |

完整 Xray JSON 路径会尽量无损：Prism 原样保存 outbound 对象，只抽取界面展示所需的节点摘要。这条路径用于覆盖完整 Xray 能力，包括 transport settings、TLS、REALITY、mux、proxy settings 和未来新增字段。

每个节点都会保留完整 Xray outbound 草稿。Tachyon 服务器档案与 Xray 订阅节点相互独立，并为可选 UDP 游戏加速提供所需的 TGP relay 端点。

## 配置草稿

Config 面板会根据当前选中的 Xray 节点和 Tachyon 服务器档案生成两份 JSON 草稿：

- `xray-client.json`：本地 SOCKS/HTTP inbound 加选中节点对应的 Xray outbound。HTTP inbound 用于 Prism 的本地代理探测，也可供支持显式 HTTP 代理的应用使用。启用 Xray 统计时，Prism 还会按 Xray 官方 API 方式加入 `StatsService` inbound，让概览图可以显示 Xray 流量而不需要 Tachyon Core 参与。
- `client.json`：Tachyon Core 客户端配置，描述 TGP UDP 游戏路径，并把 Prism 管理的游戏配置写入 `client.routing.game_profiles`，把启动器策略写入 `client.routing.launchers`，把单独持久化的游戏服务器 CIDR 写入 `client.tun.game_routes`。

设置 > 规则会明确分开游戏服务器网段、手动程序规则和 Steam 游戏规则。游戏服务器网段列表为空表示 Prism 不接管任何目的网段。程序和 Steam 规则只在流量被捕获后负责分类，不会自行添加系统路由；CIDR 路由按目的地址生效，因此会影响访问该网段的所有程序。Prism 会清除 IPv4/IPv6 host bits、保存 canonical 网络 CIDR，并拒绝语义等价的重复网段；如果持久化列表包含损坏项或非字符串项，则整体按空列表 fail-closed，避免损坏设置静默增加路由。

为了完整支持 Xray 能力，Prism 优先使用订阅或完整 Xray JSON 输入里保留下来的 outbound 对象，而不是重新猜测所有字段。

Save 操作会把生成文件写入 Tauri 应用配置目录，并在 Config 面板显示确切路径。Core 仍然保持纯粹，只需要生成的 `client.json`；Xray 由 Prism 启动和配置。游戏配置由 Prism 管理，但会嵌入生成的 Core JSON，因此单个 Core 配置即可表达预期的 UDP 加速策略。启动器设置同样由 Prism 管理并嵌入生成的 Core JSON，这样 Steam 子进程检测与可选下载加速可以在 GUI 中调整，而不把订阅或界面职责放进 Core。

Binaries 面板可以把本地 `xray` 或 `tachyon-core` 可执行文件复制到 Prism 应用配置目录下的托管 `bin` 目录，并让 `runtime-settings.json` 指向这个托管副本。它也可以查询最新版 Xray Core 和 Tachyon Core GitHub release，选择当前平台压缩包，下载匹配的 `.dgst` / `SHA256SUMS.txt` 校验资产，校验压缩包 SHA-256，解出 `xray`/`xray.exe` 或 `tachyon-core`/`tachyon-core.exe`，并原子安装到托管 `bin` 目录。

每个托管核心都有独立的发布通道选择器。`stable` 会忽略 GitHub prerelease，`preview` 会优先选择 prerelease 构建。Xray Core 默认使用 `stable`；Tachyon Core 在 alpha 阶段默认使用 `preview`。如果 Tachyon Core 暂无正式 release，`stable` 会显示清晰空状态并提示切换到 `preview`，不会静默安装 prerelease。
每个核心的 Diagnose 操作都是只读的，只使用已保存的 runtime settings。它会报告选中的
发布通道、解析到的 tag、资产、checksum 状态、已安装路径、版本状态和最近错误。它不会
写设置或生成配置，不会启动任一核心，不会执行已安装二进制，也不会启用系统代理或
Tachyon TUN。

Runtime 面板会把二进制路径保存到 `runtime-settings.json`。`Start All` 会先写入并验证最新生成的配置文件：Xray 使用原生 `run -test -config` 模式，Tachyon Core 使用 `validate --config`。随后 Prism 启动 Xray 并等待其本地 readiness，通过后才启动 Tachyon Core 并等待本地 Core `/v1/health`；任一启动或 readiness 失败都会回滚本次事务已经启动的核心。Config Drafts 区域也提供手动验证按钮，并会保留最近一次验证结果。同一个 Runtime 面板还会保存本地监听端口与核心传输设置：Xray SOCKS、Xray HTTP 探测入站、Xray StatsService、Tachyon HTTP IPC、Tachyon gRPC、TUN 地址/MTU 和遥测间隔。Alpha 配置生成始终写入 `client.tun.auto_route=false`、`client.tun.dns_hijack=false` 与 `client.tun.tgp_only=true`；默认 MTU 为 1280，`tgp.max_datagram_size` 为 1352，超过 1284 字节的内层 MTU 预算会被拒绝。Prism 不再生成 Core 不支持的 `domain` 或 `geoip` 客户端规则。在 Windows 上，Tachyon Core 还要求 `wintun.dll` 与配置的 `tachyon-core.exe` 位于同一目录；Prism 会在 Runtime readiness 中提示，并在缺少必需 sidecar 时阻止启动 Core。Prism 也会检查当前进程是否具备管理 TUN 设备的权限，但这个检查只读，不是当前 alpha 的启动门槛，也不会自行启用 TUN。

概览页快捷操作里提供本地 HTTP/SOCKS 代理探测。它会检查配置的本地 Xray HTTP inbound 和 SOCKS inbound，并分别显示状态码、耗时和错误。这个测试只验证当前选中 Xray outbound 的代理链路，不会修改系统代理，也不会触发 Tachyon TUN 模式。

设置 > 核心 中提供客户端诊断导出，用于 alpha 支持包回传。它会生成脱敏 JSON，包含 Prism 版本/平台、当前 release channel、Core/Xray 路径、release diagnostics 摘要、订阅组和节点数量、协议统计、当前选中节点摘要、最近错误，以及最近一次本地代理探针结果。导出是只读、no-spawn、no-proxy、no-TUN 操作：不会写 runtime settings，不会生成配置，不会启动或执行核心，不会启用系统代理，也不会启用 Tachyon TUN。发送前请检查文件，不要额外附上完整订阅 URL、分享链接、密码、PSK 或私钥。

在 Windows 上，系统代理 UI 操作会管理当前用户的 WinINet 注册表设置。Prism 会快照原值、验证应用结果、在释放接管时恢复快照，并通过恢复日志处理崩溃后的启动恢复。这是已经实现的 alpha 功能，不代表生产可用；真实 Windows 注册表现场验收尚未执行。macOS 和 Linux 不支持该操作。TUN 一键接管仍保持禁用。

概览页流量图刻意使用两个遥测来源：Tachyon 曲线来自 Tachyon Core 的 SSE 遥测流；Xray 曲线由 Prism 通过生成配置暴露的 Xray `StatsService` 轮询获得。Core 不读取订阅、不管理 Xray，也不采集 Xray 统计。

托管二进制 API 与启动控制刻意分离。未来可以继续在同一层补齐镜像选择、后台进度事件以及权限提升流程，而不需要改 Runtime 面板的启动契约。

## 开发环境

本仓库使用 `mise` 管理 Node 与 Rust 版本。

```bash
mise install
npm install
npm run typecheck      # TypeScript 类型检查
npm test               # 前端单元测试（Vitest）
npm run web:build      # Vite 生产构建
cd src-tauri && cargo check   # Rust 编译检查
cd src-tauri && cargo test    # Rust 后端测试
```

CI 会在每次推送时运行 typecheck、前端测试、Rust check 和 Rust tests。Cargo 依赖会通过 `.cargo/config.toml` 中的项目本地镜像配置获取。

## Release 构建

GitHub Actions 会从严格校验的 stable 或 prerelease 标签构建 Prism。Release 工作流会产出可下载的 Windows x64/ARM64、macOS x64/ARM64 和 Linux x64/ARM64 安装包，并随包发布 `SHA256SUMS.txt`；CI 会检查相同的六目标矩阵。CI 与 Release 还会检出 `core-contract.json` 固定的 Tachyon Core tag 与完整 commit，构建该精确 Core 版本，并用它验证 Prism 真实生成逻辑产生的 JSON。

stable 发布严格要求完整的 Windows Authenticode 与 Apple Developer ID 签名/公证凭据。prerelease 只有在某平台整组凭据全部缺失时才允许明确发布 unsigned 产物；半套凭据会直接失败。标签规则、包格式、凭据名称、签名门禁和本地校验方式见[发布流程](docs/releasing.zh-CN.md)。
真实 VPS、真实客户端和真实游戏 UDP 加速链路仍需实测；当前 alpha 不能宣称 stable 或完整。

## 文档

- [快速上手](docs/getting-started.zh-CN.md) / [Getting Started](docs/getting-started.md)
- [Alpha 客户端测试计划](docs/alpha-client-test-plan.zh-CN.md) / [Alpha Client Test Plan](docs/alpha-client-test-plan.md)
- [架构](docs/architecture.zh-CN.md) / [Architecture](docs/architecture.md)
- [IPC 设计](docs/ipc.zh-CN.md) / [IPC Design](docs/ipc.md)
- [开发](docs/development.zh-CN.md) / [Development](docs/development.md)
- [发布流程](docs/releasing.zh-CN.md) / [Release Process](docs/releasing.md)

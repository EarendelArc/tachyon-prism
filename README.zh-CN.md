# Tachyon Prism

[English](README.md)

Tachyon Prism 是 Tachyon 的图形化控制面。

Prism 是完整的 Xray GUI 客户端，并额外支持 Tachyon Core。它负责交互、可视化、订阅、节点选择、Xray 生命周期、Xray JSON 生成、路由 UI、规则 UI、游戏进程检测和双核心编排。普通代理流量走 Xray，游戏 UDP 流量可以交给 Tachyon Core 做低延迟加速。

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
- 通过生成的 Xray HTTP 入站进行本地代理探测，不修改系统代理，也不启用 TUN。
- 跨平台系统代理控制已接入 Prism 本地 Xray HTTP/SOCKS 入站。停止全部运行时时，会先清理 Prism 持有的系统代理状态，再停止 Xray。
- 把本地二进制安装到 Prism 应用配置目录下的托管 `bin` 目录。
- 从 GitHub release channel 发现、下载、SHA-256 校验并托管安装最新版 Xray Core 和 Tachyon Core。
- 为 Xray Core 与 Tachyon Core 的托管下载分别选择 `stable` / `preview` 发布通道。
- 作为独立子进程启动和停止 Xray Core 与 Tachyon Core。
- 启动前配置验证：每次启动前都会用 `xray run -test -config` 校验 Xray 配置，并用 `tachyon-core validate --config` 校验 Tachyon Core 配置。
- Tachyon Core TUN 模式运行权限检测。Prism 会显示当前桌面进程是否具备创建 TUN/Wintun 设备的权限，并在权限不足时阻止 Core 启动且给出明确提示。
- Windows 运行时会检查 Tachyon Core 配置二进制同目录下必需的 `wintun.dll` sidecar。

## 订阅边界

Prism 在本地解析订阅内容，并把选中节点保存在桌面控制面。Prism 也负责游戏配置和启动器扫描。Core 不保存订阅，不拉取订阅 URL，也不管理 GUI 侧游戏规则。

当前解析器支持的输入格式：

- `vless://...`
- `vmess://...`
- `trojan://...`
- `ss://...`
- `socks://...` / `socks5://...`
- `http://...` / `https://...`
- `hysteria://...` / `hysteria2://...` / `hy2://...`
- 包含密钥材料的基础 `wireguard://...` 链接。
- 完整 Xray outbound JSON 对象。
- 带 `outbounds` 数组的完整 Xray config JSON。
- 普通多行节点文本。
- Base64 编码的多行节点文本。

完整 Xray JSON 路径会尽量无损：Prism 原样保存 outbound 对象，只抽取界面展示所需的节点摘要。这条路径用于覆盖完整 Xray 能力，包括 transport settings、TLS、REALITY、mux、proxy settings 和未来新增字段。

每个节点都会保留完整 Xray outbound 草稿。Core 只接收 UDP 游戏加速所需的 TGP relay 端点。

## 配置草稿

Config 面板会根据当前选中节点生成两份 JSON 草稿：

- `xray-client.json`：本地 SOCKS/HTTP inbound 加选中节点对应的 Xray outbound。HTTP inbound 用于 Prism 的本地代理探测，也可供支持显式 HTTP 代理的应用使用。启用 Xray 统计时，Prism 还会按 Xray 官方 API 方式加入 `StatsService` inbound，让概览图可以显示 Xray 流量而不需要 Tachyon Core 参与。
- `client.json`：Tachyon Core 客户端配置，描述 TGP UDP 游戏路径，并把 Prism 管理的游戏配置写入 `client.routing.game_profiles`，把启动器策略写入 `client.routing.launchers`。

为了完整支持 Xray 能力，Prism 优先使用订阅或完整 Xray JSON 输入里保留下来的 outbound 对象，而不是重新猜测所有字段。

Save 操作会把生成文件写入 Tauri 应用配置目录，并在 Config 面板显示确切路径。Core 仍然保持纯粹，只需要生成的 `client.json`；Xray 由 Prism 启动和配置。游戏配置由 Prism 管理，但会嵌入生成的 Core JSON，因此单个 Core 配置即可表达预期的 UDP 加速策略。启动器设置同样由 Prism 管理并嵌入生成的 Core JSON，这样 Steam 子进程检测与可选下载加速可以在 GUI 中调整，而不把订阅或界面职责放进 Core。

Binaries 面板可以把本地 `xray` 或 `tachyon-core` 可执行文件复制到 Prism 应用配置目录下的托管 `bin` 目录，并让 `runtime-settings.json` 指向这个托管副本。它也可以查询最新版 Xray Core 和 Tachyon Core GitHub release，选择当前平台压缩包，下载匹配的 `.dgst` / `SHA256SUMS.txt` 校验资产，校验压缩包 SHA-256，解出 `xray`/`xray.exe` 或 `tachyon-core`/`tachyon-core.exe`，并原子安装到托管 `bin` 目录。

每个托管核心都有独立的发布通道选择器。`stable` 会忽略 GitHub prerelease，`preview` 会允许 prerelease 构建。Xray Core 默认使用 `stable`；Tachyon Core 在 alpha 阶段默认使用 `preview`。

Runtime 面板会把二进制路径保存到 `runtime-settings.json`。`Start All` 会先写入最新生成的配置文件，再用 `xray-client.json` 启动 Xray，并用 `client.json` 启动 Tachyon Core。每次启动前都会先验证刚写入的配置：Xray 使用原生 `run -test -config` 模式，Tachyon Core 使用 `validate --config`。Config Drafts 区域也提供手动验证按钮，并会保留最近一次验证结果。同一个 Runtime 面板也会保存本地监听端口与核心传输设置：Xray SOCKS、Xray HTTP 探测入站、Xray StatsService、Tachyon HTTP IPC、Tachyon gRPC、TUN 地址/MTU 和遥测间隔。在 Windows 上，Tachyon Core 还要求 `wintun.dll` 与配置的 `tachyon-core.exe` 位于同一目录；Prism 会在 Runtime readiness 中提示，并在缺少必需 sidecar 时阻止启动 Core。Prism 也会检查当前进程是否具备管理 TUN 设备的权限：Windows 需要管理员，macOS/Linux 通常需要 root 或等效网络能力。这个检查只读，不会自行启用 TUN。

概览页快捷操作里提供本地 HTTP 代理探测。它会向配置的本地 Xray HTTP inbound 发送 absolute-form HTTP 请求，并显示返回状态码与耗时。这个测试只验证当前选中 Xray outbound 的代理链路，不会修改系统代理，也不会触发 Tachyon TUN 模式。

系统代理快捷操作是真正的 OS 级代理开关。它会先确保 Xray 已使用生成配置运行，然后把系统 HTTP/HTTPS 流量指向本地 Xray HTTP inbound，把 SOCKS 流量指向本地 Xray SOCKS inbound。绕过列表可以在 设置 > 核心 中修改。自动化测试只覆盖命令构造与本地代理探测，刻意不会在测试中切换宿主系统代理。

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

GitHub Actions 会在 release tag 或手动 workflow dispatch 时构建 Prism。Release 工作流会产出 Windows x64、Windows ARM64、macOS Intel、macOS Apple Silicon、Linux x64 和 Linux ARM64 包，并随包发布 `SHA256SUMS.txt`。

当前产物还没有代码签名。加入 Authenticode 签名和 Apple notarization 之前，Windows SmartScreen 与 macOS Gatekeeper 可能会提示风险。

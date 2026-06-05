# Tachyon Prism

[English](README.md)

Tachyon Prism 是 Tachyon 的图形化控制面。

Prism 是完整的 Xray GUI 客户端，并额外支持 Tachyon Core。它负责交互、可视化、订阅、节点选择、Xray 生命周期、Xray JSON 生成、路由 UI、规则 UI、游戏进程检测和双核心编排。普通代理流量走 Xray，游戏 UDP 流量可以交给 Tachyon Core 做低延迟加速。

## 当前功能

- Core 状态看板。
- 手动游戏程序配置。
- Steam 游戏库扫描入口。
- 按程序配置 UDP/TCP 路由策略。
- 支持从订阅 URL 或粘贴内容导入节点。
- 本地节点列表与选中节点持久化。
- 根据选中节点生成 Xray 客户端 JSON 草稿。
- 生成用于 TGP 游戏路径的 Tachyon Core 客户端 JSON 草稿。
- 一键把生成的 `client.json` 与 `xray-client.json` 保存到 Tauri 应用配置目录。
- 持久化 Xray Core 与 Tachyon Core 的运行二进制路径。
- 把本地二进制安装到 Prism 应用配置目录下的托管 `bin` 目录。
- 从 GitHub release channel 发现、下载、SHA-256 校验并托管安装最新版 Xray Core 与 Tachyon Core。
- 作为独立子进程启动和停止 Xray Core 与 Tachyon Core。

## 订阅边界

Prism 在本地解析订阅内容，并把选中节点保存在桌面控制面。Core 不保存订阅，也不拉取订阅 URL。

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

每个节点都会保留完整 Xray outbound 草稿。Core 只接收 UDP 游戏加速所需的 TGP Relay 端点。

## 配置草稿

Config 面板会根据当前选中节点生成两份 JSON 草稿：

- `xray-client.json`：本地 SOCKS inbound 加选中节点对应的 Xray outbound。
- `client.json`：Tachyon Core 客户端配置，只描述 TGP UDP 游戏路径。

为了完整支持 Xray 能力，Prism 优先使用订阅或完整 Xray JSON 输入里保留下来的 outbound 对象，而不是重新猜测所有字段。

Save 操作会把生成文件写入 Tauri 应用配置目录，并在 Config 面板显示确切路径。Core 仍然保持纯粹，只需要生成的 `client.json`；Xray 由 Prism 启动和配置。

Binaries 面板可以把本地 `xray` 或 `tachyon-core` 可执行文件复制到 Prism 应用配置目录下的托管 `bin` 目录，并把 `runtime-settings.json` 指向这个托管副本。它也可以查询最新版 Xray Core 与 Tachyon Core GitHub release，选择当前平台压缩包，下载匹配的 `.dgst` / `SHA256SUMS.txt` 校验资产，校验压缩包 SHA-256，解压 `xray`/`xray.exe` 或 `tachyon-core`/`tachyon-core.exe`，并原子安装到托管 `bin` 目录。

Runtime 面板会把二进制路径保存到 `runtime-settings.json`。`Start All` 会先写入最新生成的配置文件，再用 `xray-client.json` 启动 Xray，并用 `client.json` 启动 Tachyon Core。

托管二进制 API 与启动控制刻意分离。未来可以继续在同一层补齐镜像选择、后台进度事件以及权限提升流程，而不需要改 Runtime 面板的启动契约。

## 开发环境

本仓库使用 `mise` 管理 Node 与 Rust 版本。

```bash
mise install
npm install
npm run typecheck
npm run web:build
cd src-tauri && cargo check
```

Cargo 依赖会通过 `.cargo/config.toml` 中的项目本地镜像配置获取。

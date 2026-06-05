# Tachyon Prism

[English](README.md)

Tachyon Prism 是 Tachyon 的图形化控制面。

Prism 负责交互、可视化、订阅获取、订阅解析、节点选择，以及后续生成
Core/Xray 可消费的 JSON 配置。Tachyon Core 保持无头和纯粹：只读取明确的
JSON 配置，并执行流量接管、路由、Xray 子进程管理和 TGP 传输。

## 当前功能

- Core 状态看板。
- 手动游戏程序配置。
- Steam 游戏库扫描入口。
- 按程序配置 UDP/TCP 路由策略。
- 支持从订阅 URL 或粘贴内容导入节点。
- 本地节点列表与选中节点持久化。
- 根据选中节点生成 Xray 客户端 JSON 草稿。
- 生成指向 `xray-client.json` 的 Tachyon Core 客户端 JSON 草稿。
- 一键把生成的 `client.json` 与 `xray-client.json` 保存到 Tauri 应用配置目录。

## 订阅边界

Prism 在本地解析订阅内容，并把选中节点保存在桌面控制面。Core 不保存订阅，
也不拉取订阅 URL。

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

完整 Xray JSON 路径会尽量无损：Prism 原样保存 outbound 对象，只抽取界面展示
所需的节点摘要。这条路径用于覆盖完整 Xray 能力，包括 transport settings、
TLS、REALITY、mux、proxy settings 和未来新增字段。

VLESS 节点会保留用户 UUID，并可以转换为 Core `proxy` JSON 配置片段。每个节点
也会保留完整 Xray outbound 草稿。把生成配置应用到运行中的 Core 进程会作为后续
控制面能力继续推进。

## 配置草稿

Config 面板会根据当前选中节点生成两份 JSON 草稿：

- `xray-client.json`：本地 SOCKS inbound 加选中节点对应的 Xray outbound。
- `client.json`：Tachyon Core 客户端配置，其中 `xray.config_file` 指向
  `xray-client.json`。

为了完整支持 Xray 能力，Prism 优先使用订阅或完整 Xray JSON 输入里保留下来的
outbound 对象，而不是重新猜测所有字段。

Save 操作会把生成文件写入 Tauri 应用配置目录，并在 Config 面板显示确切路径。
Core 仍然保持纯粹，只需要使用生成的 `client.json` 启动。

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

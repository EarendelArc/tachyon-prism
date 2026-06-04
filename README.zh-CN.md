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

## 订阅边界

Prism 在本地解析订阅内容，并把选中节点保存在桌面控制面。Core 不保存订阅，
也不拉取订阅 URL。

当前解析器支持：

- `vless://...`
- `trojan://...`
- `ss://...`
- 普通多行节点文本。
- Base64 编码的多行节点文本。

VLESS 节点会保留用户 UUID，并可以转换为 Core `proxy` JSON 配置片段。把生成
配置应用到运行中的 Core 进程会作为后续控制面能力继续推进。

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

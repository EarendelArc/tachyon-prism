# 开发环境

[English](development.md)

Tachyon Prism 使用 `mise` 管理 Node 和 Rust 版本。

```bash
mise install
npm install
npm run typecheck
```

UI 必须和数据包路由保持解耦。Prism 调用 Core IPC API 并渲染状态，不在本地实现路由决策。

## Cargo 源

Prism 在 `.cargo/config.toml` 中使用项目本地 Cargo 源替换配置。默认 crates.io 源会被替换为 RSProxy sparse registry 镜像，以提升中国大陆网络环境下依赖下载的稳定性。

该配置只作用于本仓库，不会修改用户全局 Cargo 配置。

Node 与 Rust 版本应在确认 Node.js 和 Rust 官方发布页后跟随最新正式版。直接 npm 与 Cargo 依赖在发布构建前应从对应 registry 的 `latest` stable 版本刷新。

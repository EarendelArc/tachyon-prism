# Tachyon Prism

[English](README.md)

Tachyon Prism 是 Tachyon 的图形化控制面。

推荐技术栈是 Tauri v2 加 React。Prism 只负责交互和可视化；Core 负责路由、数据包接管和传输行为。

## 初始功能

- Core 状态看板。
- Xray 版本管理器。
- 手动游戏配置管理。
- Steam 游戏库扫描入口。
- 按程序配置 UDP/TCP 路由策略。

## 开发环境

本仓库使用 `mise` 管理 Node 和 Rust 版本。

```bash
mise install
npm install
npm run typecheck
```

Cargo 依赖会通过 `.cargo/config.toml` 中的项目本地镜像配置获取。

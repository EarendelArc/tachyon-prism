# Tachyon Prism 架构

[English](architecture.md)

Prism 是一个 Tauri 桌面应用，前端为 React，后端为 Rust。

## 前端 / 后端分层

```text
src/                        src-tauri/src/
  App.tsx                     lib.rs
  domain/                       Tauri 命令
    configDrafts.ts              Rust 辅助函数
    desktopConfig.ts             测试（40+）
    gameProfiles.ts
    runtime.ts
    subscriptions.ts
```

前端负责订阅解析、节点选择、配置生成和所有 UI 状态。Rust 后端负责文件系统访问、二进制管理、进程启动以及与 Core 的 HTTP 桥接。

Tauri `invoke()` 连接两端：前端调用 Rust 命令，Rust 返回 JSON 可序列化结果。

## 视图

| 视图 | 用途 |
| --- | --- |
| Overview | 运行时状态、游戏模式概要、就绪计数 |
| Nodes | 导入订阅、浏览节点、选择活跃节点 |
| Game Mode | 手动配置文件、Steam 扫描建议 |
| Launchers | Steam 启动器检测、子进程跟踪、UDP 加速 |
| Runtime | 二进制管理、从 release 安装、启动/停止核心、就绪检查 |
| Config | 生成和保存 Xray + Core JSON 配置草稿 |

## 配置生成

Prism 根据选中的节点和用户设置生成两个 JSON 文件：

- `xray-client.json`：本地 SOCKS 入站 + 选中节点的 Xray 出站。
- `client.json`：Tachyon Core 客户端配置，包含 `client.routing.game_profiles` 中的游戏配置文件和 `client.routing.launchers` 中的启动器策略。

生成的配置写入 Tauri 应用配置目录，也可从 Config 面板复制到剪贴板。

## 二进制管理

Binaries 面板管理 Xray Core 和 Tachyon Core 可执行文件：

- 将本地二进制复制到 Prism 托管的 `bin` 目录。
- 查询 GitHub release 最新版本并下载 + SHA-256 校验。
- 在 Windows 上检测 Tachyon Core 二进制旁边的 `wintun.dll` sidecar。

二进制路径存储在 `runtime-settings.json` 中。Runtime 面板在启动核心时使用这些路径。

## 运行时生命周期

```text
全部启动：
  1. 写入配置草稿（client.json + xray-client.json）
  2. 保存运行时设置
  3. 预检查（二进制路径、sidecar、节点、配置草稿）
  4. 用 xray-client.json 启动 Xray
  5. 用 client.json 启动 Tachyon Core
  6. 轮询 Core /v1/health（3 秒超时）获取状态
```

Runtime 面板实时显示两个核心的进程状态，并支持单独启动/停止控制。

## 测试覆盖

| 层 | 工具 | 数量 |
| --- | --- | --- |
| Rust 后端 | `cargo test` | 65 个测试 |
| 前端领域 | Vitest | 6 个常规套件 + 1 个需手动启用的 live 套件 |
| TypeScript 类型 | `tsc --noEmit` | 在 CI 中强制执行 |

CI 在每次推送时运行所有三层（ubuntu、windows、macos）。

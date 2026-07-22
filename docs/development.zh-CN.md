# 开发

[English](development.md)

Tachyon Prism 使用 `mise` 管理 Node 与 Rust 版本。

```bash
mise install
npm install
npm run typecheck
npm test
npm run test:core-contract
```

`npm test` 会排除全部 `*.live.test.ts`。Core live contract 只由
`npm run test:core-contract` 显式运行，要求存在固定 Core 源码，并由 CI/Release 在
Linux、macOS、Windows 上执行。测试不会启用 TUN：Linux/macOS 使用真实 Core 进程确认
非空选择性路由会在 `TUN device ready` 前失败；Windows 解析 `go test -json`，要求每个
指定的内存路由模拟测试分别产生自己的 run/pass 事件。

UI 必须保持与实际网络转发解耦。Prism 调用 Core IPC API 并渲染状态，但不在本地实现包路由决策。

## Cargo Registry

Prism 使用仓库本地的 Cargo source replacement 配置。默认 crates.io source 会替换为 RSProxy sparse registry mirror，以提高中国大陆网络环境下的依赖获取稳定性。

这个设置只作用于当前仓库，不会修改用户全局 Cargo 配置。

Node 与 Rust 版本在 release 构建前应根据 Node.js 与 Rust 官方 release 页面跟踪最新正式稳定版。直接 npm 与 Cargo 依赖也应在发布前从对应 registry 的 latest stable 版本刷新。

## Release 构建

Prism release 产物由 `.github/workflows/release.yml` 生成。推送 `v*` tag 或手动 workflow dispatch 时，工作流会先运行前端与 Rust 测试，然后构建 Windows x64、Windows ARM64、macOS x64、macOS ARM64、Linux x64 和 Linux ARM64 的 Tauri 包。

生成的产物会和 `SHA256SUMS.txt`、可复现源码元数据一起上传到 GitHub Release。跨仓测试使用 `core-contract.json` 中固定的精确 Tachyon Core 发布版本；源码或 ref 不可用时会失败，不会跳过验证。当前契约固定 annotated tag `v0.1.0-alpha.21` 的 tag object `26ac54b682c7d0e3a65f8a35662c6d7f11724001`，peel 后必须是 commit `12df9c561a921bed7fc5f63a2ea166e7227d773f`。

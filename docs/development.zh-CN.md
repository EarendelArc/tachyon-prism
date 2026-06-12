# 开发

[English](development.md)

Tachyon Prism 使用 `mise` 管理 Node 与 Rust 版本。

```bash
mise install
npm install
npm run typecheck
```

UI 必须保持与实际网络转发解耦。Prism 调用 Core IPC API 并渲染状态，但不在本地实现包路由决策。

## Cargo Registry

Prism 使用仓库本地的 Cargo source replacement 配置。默认 crates.io source 会替换为 RSProxy sparse registry mirror，以提高中国大陆网络环境下的依赖获取稳定性。

这个设置只作用于当前仓库，不会修改用户全局 Cargo 配置。

Node 与 Rust 版本在 release 构建前应根据 Node.js 与 Rust 官方 release 页面跟踪最新正式稳定版。直接 npm 与 Cargo 依赖也应在发布前从对应 registry 的 latest stable 版本刷新。

## Release 构建

Prism release 产物由 `.github/workflows/release.yml` 生成。推送 `v*` tag 或手动 workflow dispatch 时，工作流会先运行前端与 Rust 测试，然后构建 Windows x64、Windows ARM64、macOS x64、macOS ARM64、Linux x64 和 Linux ARM64 的 Tauri 包。

生成的产物会和 `SHA256SUMS.txt` 一起上传到 GitHub Release。当前这些包还没有签名；正式分发前还需要补齐 Windows Authenticode 签名、Apple Developer ID 签名和 macOS notarization。

# Development

[中文说明](development.zh-CN.md)

Tachyon Prism uses `mise` for Node and Rust version management.

```bash
mise install
npm install
npm run typecheck
```

The UI should stay decoupled from packet routing. Prism calls Core IPC APIs and
renders state; it does not implement routing decisions locally.

## Cargo Registry

Prism uses a project-local Cargo source replacement in `.cargo/config.toml`.
The default crates.io source is replaced with the RSProxy sparse registry mirror
to improve dependency fetch reliability in mainland China.

This setting is intentionally local to the repository and does not modify the
user's global Cargo configuration.

Node and Rust versions should track the latest official stable releases after
checking the Node.js and Rust release pages. Direct npm and Cargo dependencies
should be refreshed from their registry `latest` stable versions before release
builds.

## Release Builds

Prism release artifacts are built by `.github/workflows/release.yml` on `v*`
tags or manual workflow dispatch. The workflow runs frontend and Rust tests
first, then builds Tauri bundles for Windows x64, Windows ARM64, macOS x64,
macOS ARM64, Linux x64, and Linux ARM64.

The generated artifacts are uploaded to the GitHub release together with
`SHA256SUMS.txt`. These packages are unsigned for now; production distribution
still needs Windows Authenticode signing, Apple Developer ID signing, and macOS
notarization.

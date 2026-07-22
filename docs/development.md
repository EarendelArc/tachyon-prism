# Development

[中文说明](development.zh-CN.md)

Tachyon Prism uses `mise` for Node and Rust version management.

```bash
mise install
npm install
npm run typecheck
npm test
npm run test:core-contract
```

`npm test` excludes every `*.live.test.ts` file. The Core live contract runs
only through `npm run test:core-contract`, requires the pinned Core source, and
is executed by CI/Release on Linux, macOS, and Windows. It does not enable TUN:
Linux/macOS assert the real Core process rejects non-empty selective routes
before the `TUN device ready` point, while Windows parses `go test -json` and
requires every named in-memory route simulation to emit its own run/pass events.

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
`SHA256SUMS.txt` and reproducible source metadata. The cross-repository test uses
the exact Tachyon Core release pin in `core-contract.json`; it fails when that
source/ref is unavailable instead of skipping validation. The current contract
is the annotated `v0.1.0-alpha.21` tag object
`26ac54b682c7d0e3a65f8a35662c6d7f11724001`, peeled to commit
`12df9c561a921bed7fc5f63a2ea166e7227d773f`.

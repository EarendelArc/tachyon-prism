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

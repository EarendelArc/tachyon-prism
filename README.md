# Tachyon Prism

[中文说明](README.zh-CN.md)

Tachyon Prism is the graphical control plane for Tachyon.

The intended stack is Tauri v2 plus React. Prism owns interaction and
visualization only; Core owns routing, packet capture, and transport behavior.

## Initial Features

- Core status dashboard.
- Xray version manager.
- Manual game profile management.
- Steam library scan entry point.
- Per-program UDP/TCP routing policy controls.

## Development Environment

This repository uses `mise` for Node and Rust version management.

```bash
mise install
npm install
npm run typecheck
```

Cargo dependencies are fetched through the project-local mirror configuration in
`.cargo/config.toml`.

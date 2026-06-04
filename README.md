# Tachyon Prism

[中文说明](README.zh-CN.md)

Tachyon Prism is the graphical control plane for Tachyon.

Prism owns interaction, visualization, subscription retrieval, subscription
parsing, node selection, and future Core/Xray JSON config generation. Tachyon
Core stays headless and pure: it reads explicit JSON config and performs packet
capture, routing, Xray subprocess control, and TGP transport.

## Current Features

- Core status dashboard.
- Manual game profile management.
- Steam library scan entry point.
- Per-program UDP/TCP routing policy controls.
- Basic subscription import from URL or pasted payload.
- Local node list with selected-node persistence.

## Subscription Boundary

Prism parses subscription payloads locally and stores the selected node in the
desktop control plane. Core does not store subscriptions and does not fetch
subscription URLs.

Supported node URI formats in the current parser:

- `vless://...`
- `trojan://...`
- `ss://...`
- Plain newline-separated payloads.
- Base64-encoded newline-separated payloads.

VLESS nodes preserve the user UUID and can be converted into a Core `proxy`
JSON draft. Applying that generated config to a running Core process is a later
control-plane step.

## Development Environment

This repository uses `mise` for Node and Rust version management.

```bash
mise install
npm install
npm run typecheck
npm run web:build
cd src-tauri && cargo check
```

Cargo dependencies are fetched through the project-local mirror configuration in
`.cargo/config.toml`.

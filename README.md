# Tachyon Prism

[中文说明](README.zh-CN.md)

Tachyon Prism is the graphical control plane for Tachyon.

Prism is the desktop integration client: it owns interaction, visualization,
subscription retrieval, subscription parsing, node selection, Xray lifecycle,
Xray JSON generation, and Tachyon Core orchestration. Tachyon Core stays
headless and pure: it reads explicit JSON config and performs only UDP game
capture, game routing, TGP transport, and TGP relay work.

## Current Features

- Core status dashboard.
- Manual game profile management.
- Steam library scan entry point.
- Per-program UDP/TCP routing policy controls.
- Basic subscription import from URL or pasted payload.
- Local node list with selected-node persistence.
- Xray client JSON draft generation from the selected node.
- Tachyon Core client JSON draft generation for the TGP game path.
- One-click saving of generated `client.json` and `xray-client.json` to the
  Tauri app config directory.

## Subscription Boundary

Prism parses subscription payloads locally and stores the selected node in the
desktop control plane. Core does not store subscriptions and does not fetch
subscription URLs.

Supported input formats in the current parser:

- `vless://...`
- `vmess://...`
- `trojan://...`
- `ss://...`
- `socks://...` / `socks5://...`
- `http://...` / `https://...`
- `hysteria://...` / `hysteria2://...` / `hy2://...`
- Basic `wireguard://...` links when key material is present.
- Full Xray outbound JSON objects.
- Full Xray config JSON with an `outbounds` array.
- Plain newline-separated payloads.
- Base64-encoded newline-separated payloads.

The full Xray JSON path is intentionally lossless: Prism stores the outbound
object as-is and extracts only the node summary needed for display. This is the
path used for complete Xray feature coverage, including transport settings,
TLS, REALITY, mux, proxy settings, and future fields.

Complete Xray outbound drafts are preserved per node. Core receives only the
TGP relay endpoint needed for UDP game acceleration.

## Config Drafts

The Config panel generates two JSON drafts from the selected node:

- `xray-client.json`: a local SOCKS inbound plus the selected Xray outbound.
- `client.json`: a Tachyon Core client config for the TGP UDP game path.

For complete Xray feature support, Prism prefers the preserved outbound object
from the subscription or full Xray JSON input instead of rebuilding fields from
scratch.

The Save action writes the generated files into the Tauri app config directory
and shows the exact paths in the Config panel. Core still remains pure and only
needs the generated `client.json`; Xray is launched and configured by Prism.

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

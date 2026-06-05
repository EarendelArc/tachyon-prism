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
- Xray client JSON draft generation from the selected node.
- Tachyon Core client JSON draft generation that points to `xray-client.json`.
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

VLESS nodes preserve the user UUID and can be converted into a Core `proxy`
JSON draft. Complete Xray outbound drafts are also preserved per node. Applying
that generated config to a running Core process is a later control-plane step.

## Config Drafts

The Config panel generates two JSON drafts from the selected node:

- `xray-client.json`: a local SOCKS inbound plus the selected Xray outbound.
- `client.json`: a Tachyon Core client config whose `xray.config_file` points at
  `xray-client.json`.

For complete Xray feature support, Prism prefers the preserved outbound object
from the subscription or full Xray JSON input instead of rebuilding fields from
scratch.

The Save action writes the generated files into the Tauri app config directory
and shows the exact paths in the Config panel. Core still remains pure and only
needs to be started with the generated `client.json`.

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

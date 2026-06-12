# Tachyon Prism

[中文说明](README.zh-CN.md)

Tachyon Prism is the graphical control plane for Tachyon.

Prism is a full Xray GUI client with Tachyon Core support. It owns interaction,
visualization, subscriptions, node selection, Xray lifecycle, Xray JSON
generation, routing UI, rules UI, game-process detection, and dual-core
orchestration. Normal proxy traffic runs through Xray. Game UDP traffic can be
sent through Tachyon Core for low-latency acceleration.

## Current Features

- Runtime and profile status dashboard.
- Local manual game profile management.
- Local Steam library scan and game-profile suggestions.
- Persistent Steam launcher settings for child-process tracking, game UDP
  acceleration, and optional Steam download acceleration.
- Per-program UDP/TCP routing policy controls.
- Basic subscription import from URL or pasted payload.
- Local node list with selected-node persistence.
- Xray client JSON draft generation from the selected node.
- Tachyon Core client JSON draft generation for the TGP game path.
- One-click saving of generated `client.json` and `xray-client.json` to the
  Tauri app config directory.
- Persistent runtime binary path settings for Xray Core and Tachyon Core.
- Managed local binary installation into Prism's app config `bin` directory.
- Online Xray Core and Tachyon Core latest-release discovery, download,
  SHA-256 verification, and managed install from GitHub release channels.
- Independent `stable` / `preview` release-channel selection for Xray Core and
  Tachyon Core managed downloads.
- Runtime controls for launching and stopping Xray Core and Tachyon Core as
  separate subprocesses.
- Windows runtime readiness detects Tachyon Core's required `wintun.dll`
  sidecar next to the configured Core binary.

## Subscription Boundary

Prism parses subscription payloads locally and stores the selected node in the
desktop control plane. Prism also owns game profiles and launcher discovery.
Core does not store subscriptions, does not fetch subscription URLs, and does
not manage GUI-side game rules.

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
- `client.json`: a Tachyon Core client config for the TGP UDP game path,
  including Prism-managed game profiles under `client.routing.game_profiles`
  and launcher policy under `client.routing.launchers`.

For complete Xray feature support, Prism prefers the preserved outbound object
from the subscription or full Xray JSON input instead of rebuilding fields from
scratch.

The Save action writes the generated files into the Tauri app config directory
and shows the exact paths in the Config panel. Core still remains pure and only
needs the generated `client.json`; Xray is launched and configured by Prism.
Game profiles are owned by Prism but embedded into the generated Core JSON so a
single Core config captures the intended UDP acceleration policy.
Launcher settings are also owned by Prism and embedded into the generated Core
JSON so Steam child-process detection and optional Steam download handling can
be changed without adding subscription or GUI responsibilities to Core.

The Binaries panel can copy a local `xray` or `tachyon-core` executable into
Prism's managed app config `bin` directory and point `runtime-settings.json` at
that managed copy. It can also query the latest Xray Core and Tachyon Core
GitHub releases, choose the current platform archive, download the matching
`.dgst` / `SHA256SUMS.txt` checksum asset, verify the archive SHA-256, extract
`xray`/`xray.exe` or `tachyon-core`/`tachyon-core.exe`, and atomically install
the executable into the managed `bin` directory.

Each managed core has an independent release channel selector. `stable` ignores
GitHub prereleases, while `preview` accepts prerelease builds. Xray Core defaults
to `stable`; Tachyon Core defaults to `preview` while Tachyon releases are still
alpha-stage.

The Runtime panel stores binary paths in `runtime-settings.json`. `Start All`
first writes the latest generated config files, then launches Xray with
`xray-client.json` and Tachyon Core with `client.json`.
On Windows, Tachyon Core also requires `wintun.dll` in the same directory as
the configured `tachyon-core.exe`; Prism reports this in Runtime readiness and
blocks Core start when the required sidecar is missing.

The managed-binary API is intentionally separate from launch control so future
mirror selection, background progress events, and privilege-elevation flows can
be added without changing the Runtime panel contract.

## Development Environment

This repository uses `mise` for Node and Rust version management.

```bash
mise install
npm install
npm run typecheck      # TypeScript typecheck
npm test               # Frontend unit tests (Vitest)
npm run web:build      # Vite production build
cd src-tauri && cargo check   # Rust compile check
cd src-tauri && cargo test    # Rust backend tests
```

CI runs typecheck + frontend tests + Rust tests (check + test) on every push.
Cargo dependencies are fetched through the project-local mirror configuration in
`.cargo/config.toml`.

## Release Builds

GitHub Actions builds Prism on release tags and manual workflow dispatches. The
release workflow produces Windows x64, Windows ARM64, macOS Intel, macOS Apple
Silicon, Linux x64, and Linux ARM64 bundles, then publishes them with
`SHA256SUMS.txt`.

Current release artifacts are unsigned. Windows SmartScreen and macOS Gatekeeper
may warn until Authenticode signing and Apple notarization are added.

## Documentation

- [Getting Started](docs/getting-started.md) / [快速上手](docs/getting-started.zh-CN.md)
- [Architecture](docs/architecture.md) / [架构](docs/architecture.zh-CN.md)
- [IPC Design](docs/ipc.md) / [IPC 设计](docs/ipc.zh-CN.md)
- [Development](docs/development.md) / [开发](docs/development.zh-CN.md)

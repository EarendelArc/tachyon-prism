# Changelog

All notable changes to Tachyon Prism will be documented in this file.

## [Unreleased]

### Added
- Independent `stable` / `preview` release-channel settings for Xray Core and
  Tachyon Core managed downloads.
- Tachyon Core release discovery can consume prerelease alpha builds when the
  `preview` channel is selected.
- Tachyon Core TGP FEC runtime settings in the Core settings page, including
  data shards, parity shards, group timeout, adaptive FEC, and adaptation window.
- Live subscription smoke test gated by `TACHYON_LIVE_SUBSCRIPTION_URL` so real
  subscription parsing can be verified without exposing node details in logs.
- Subscription import diagnostics report skipped entries, duplicate nodes, and
  unsupported protocols without polluting Tachyon Core.
- Optional Prism/Core config contract test gated by `TACHYON_CORE_BINARY_PATH`,
  validating generated Tachyon Core client JSON with the real Core binary.
- Runtime switches for Tachyon Core TUN auto-route and DNS hijack generation,
  both defaulting off for TGP-only safe mode.
- Windows Wintun sidecar installer for Tachyon Core, including SHA-256
  verification and per-architecture `wintun.dll` extraction.
- GitHub Actions release workflow for unsigned Prism desktop bundles on Windows
  x64, Windows ARM64, macOS x64, macOS ARM64, Linux x64, and Linux ARM64.
- Real-time telemetry client consuming Core SSE stream (`src/domain/telemetry.ts`).
- Live Telemetry panel in overview showing packet counters, TGP sessions, goroutines, and recent routing decisions.
- Telemetry auto-reconnect with exponential backoff (1s to 30s).
- Route list CSS styling.
- Architecture documentation (`docs/architecture.md`, EN + ZH).
- Getting-started guide (`docs/getting-started.md`, EN + ZH).
- Documentation section in README with links to all docs.

### Fixed
- Generate canonical Xray outbound settings from URI and Clash/Mihomo
  subscriptions (`vnext` / `servers`) instead of display-only shorthand fields.
- Preserve VMess share-link transport settings correctly, including WebSocket
  links where VMess `type` means header type rather than network.
- Parse Trojan-Go-compatible links as Xray Trojan outbounds when their
  parameters map to Xray transport settings.
- Preserve common Clash/Mihomo TLS and Hysteria fields, including ALPN lists,
  skip-cert-verify, Hysteria bandwidth hints, and UDP idle timeout.
- Upgrade previously saved URI subscription nodes on load so old cached nodes
  get canonical Xray outbound settings without requiring a manual re-import.
- Stabilize the custom Windows titlebar drag/no-drag regions and verify no
  visible console window appears in native smoke tests.

### Verified
- Real subscription URL smoke test, Prism/Core config contract test, default
  frontend tests, TypeScript typecheck, Vite production build, native window
  smoke, and UI screenshot smoke.
- Parsed VMess WebSocket, Trojan-Go-compatible, and Hysteria subscription nodes
  round-trip into generated Xray client config drafts.

## [v0.1.0-alpha.1]

### Added
- Tauri desktop shell with React frontend and Rust backend.
- Subscription import from URL or pasted payload (VLESS, VMess, Trojan, SS, SOCKS, Hysteria, WireGuard, full Xray JSON).
- Local node list with selected-node persistence.
- Local manual game profile management with CRUD.
- Steam library scan and game-profile suggestions (VDF parser for `libraryfolders.vdf` and `appmanifest_*.acf`).
- Persistent Steam launcher settings (child-process tracking, game UDP acceleration, optional Steam download acceleration).
- Xray client JSON and Tachyon Core client JSON draft generation from selected node.
- One-click config save to Tauri app config directory.
- Managed binary installation (local copy + GitHub release download with SHA-256 verification).
- Runtime controls for launching/stopping Xray Core and Tachyon Core as subprocesses.
- Real Core health check via `GET /v1/health` (3-second timeout).
- Runtime readiness checks (binary paths, sidecars, node, config drafts).
- Windows `wintun.dll` sidecar detection.
- GitHub Actions CI: TypeScript typecheck + Vitest tests + Rust check + Rust tests (ubuntu, windows, macos).
- 40 Rust backend tests, 3 Vitest frontend test suites (configDrafts, subscriptions, gameProfiles).
- Comprehensive README (EN + ZH) with architecture overview and development guide.


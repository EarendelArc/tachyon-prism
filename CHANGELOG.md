# Changelog

All notable changes to Tachyon Prism will be documented in this file.

## [Unreleased]

### Added
- Architecture documentation (`docs/architecture.md`, EN + ZH).
- Getting-started guide (`docs/getting-started.md`, EN + ZH).
- Documentation section in README with links to all docs.

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

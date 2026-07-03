# Changelog

All notable changes to Tachyon Prism will be documented in this file.

## [Unreleased]

### Added
- Nothing yet.

### Fixed
- Nothing yet.

### Verified
- Nothing yet.

## [v0.1.0-alpha.13] - 2026-07-04

### Fixed
- Fixed Prism release asset naming so uploaded bundles and
  `SHA256SUMS.txt` entries use the same platform/package names, and added a
  release-workflow self-check that verifies the generated checksum file before
  upload.
- Tightened managed Core release selection: the `stable` channel skips GitHub
  prereleases, while the `preview` channel can select prerelease Core builds
  during alpha testing.
- Made SHA-256 lookup prefer exact asset filenames while still allowing the
  intended Prism filename aliases, preventing unrelated similarly named assets
  from satisfying checksum verification.
- Added minimal TUIC subscription parsing for URI and Clash/Mihomo proxy input
  so TUIC nodes can be imported as selectable Xray-compatible profiles.

### Known Limitations
- Release artifacts are still unsigned and not notarized.
- System Proxy and Tachyon TUN one-click takeover remain disabled by default in
  alpha builds; this release does not promote them to stable behavior.
- Managed Core release discovery still depends on GitHub release metadata and
  asset/checksum availability.

### 中文说明
- 修复 Prism release asset 命名，使上传包名和 `SHA256SUMS.txt` 条目保持一致，
  并在 release workflow 中加入 checksum 文件上传前自检。
- 修正托管 Core 的 release 选择：`stable` 会跳过 GitHub prerelease，`preview`
  可在 alpha 验证期间选择预发布 Core 构建。
- SHA-256 校验查找现在优先精确匹配资产文件名，同时保留预期的 Prism 文件名
  alias，避免相近名称的无关资产误通过校验。
- 增加 TUIC 订阅最小解析，支持从 URI 和 Clash/Mihomo proxy 输入导入为可选择的
  Xray 兼容节点。
- 系统代理和 Tachyon TUN 一键接管在 alpha 中仍默认禁用；本发布不表示这些能力
  已 stable 或完整可用。

## [v0.1.0-alpha.12] - 2026-07-03

### Added
- Independent Tachyon server profiles for relay name, address, port, PSK, and
  remarks. The selected profile feeds generated Tachyon Core client drafts and
  writes non-empty PSKs to `tgp.auth.psk` without mixing Tachyon servers with
  ordinary Xray subscription nodes.
- Tachyon Core defaults to the `preview` release channel while alpha Core
  builds are prereleases. Managed Xray Core and Tachyon Core downloads now have
  independent `stable` / `preview` release-channel settings; `stable` ignores
  GitHub prereleases, while `preview` can select prerelease builds.
- Stable release checks now show a clear message when no compatible full release
  is available and point users to the Pre channel for prerelease Core builds.
- Managed release download and install flow for Xray Core and Tachyon Core,
  including platform asset selection, checksum asset download, SHA-256
  verification, extraction, and atomic install into Prism's managed `bin`
  directory.
- Windows Wintun sidecar installer and readiness checks for Tachyon Core,
  including SHA-256 verification, per-architecture `wintun.dll` extraction, and
  startup blocking when required sidecars are missing.
- `Start All` now starts Xray Core and Tachyon Core independently so one core
  failing readiness checks does not prevent the other from starting.
- Startup preflight validation for generated configs: Xray uses
  `xray run -test -config`, and Tachyon Core uses
  `tachyon-core validate --config` before launch.
- Local Xray proxy probe for the selected node through Prism's generated HTTP
  and SOCKS inbounds. The probe reports HTTP and SOCKS status independently and
  does not enable OS system proxy or Tachyon TUN mode.
- Runtime settings for Tachyon Core IPC listen address and port, gRPC listen
  address and port, telemetry interval, TGP FEC settings, local bind addresses,
  multipath, and connection migration.
- Overview runtime presence for Xray and Tachyon, current Xray node, current
  Tachyon server profile, empty-state traffic charts when no telemetry exists,
  and dual-source traffic display for Xray StatsService and Tachyon telemetry.
- UI smoke coverage for 800x540, 1024x720, and 1366x768 key pages, including
  overview, subscriptions, settings, routing modes, config drafts, and the local
  HTTP/SOCKS proxy panel.
- Subscription import diagnostics for skipped entries, duplicate nodes, and
  unsupported protocols without leaking Xray subscription details into Tachyon
  Core.
- Live subscription smoke test gated by `TACHYON_LIVE_SUBSCRIPTION_URL` and
  optional Prism/Core config contract test gated by `TACHYON_CORE_BINARY_PATH`.
- Real-time telemetry client consuming the Tachyon Core SSE stream, with
  auto-reconnect and an overview panel for packet counters, TGP sessions,
  goroutines, and recent routing decisions.
- GUI.for.SingBox-style desktop workflow improvements, including the overview
  current-node card opening the node selector drawer, route-list styling, custom
  frameless titlebar controls, and fixed-size smoke-tested desktop layouts.
- Architecture and getting-started documentation in English and Chinese, plus a
  README documentation index.

### Changed
- Generated Tachyon Core client drafts force
  `client.tun.auto_route=false` and `client.tun.dns_hijack=false` in alpha
  builds, even if an internal caller passes true, so Prism cannot unexpectedly
  alter OS routing or DNS while users are playing.
- Tachyon server profile guidance now calls out that the server must configure
  `allowed_targets`, and that PSK values must come from the Tachyon server's
  `tgp.auth.psk` rather than any Xray subscription node.
- Core config draft validation warns before launch when multipath is enabled
  without at least two local bind addresses or without connection migration.

### Fixed
- Generate current Xray outbound settings from URI and Clash/Mihomo
  subscriptions using flat `settings.address` / `settings.port` fields instead
  of legacy `vnext` / `servers` arrays where appropriate, while still reading
  old JSON outbounds.
- Preserve VMess share-link transport settings correctly, including WebSocket
  links where VMess `type` means header type rather than network.
- Parse Trojan-Go-compatible links as Xray Trojan outbounds when their
  parameters map to Xray transport settings.
- Preserve common Clash/Mihomo TLS and Xray-compatible Hysteria fields,
  including ALPN lists, skip-cert-verify, auth, and UDP idle timeout.
- Align Xray transport parsing with current Project X behavior: current mKCP
  fields are preserved, while deprecated QUIC markers no longer emit invalid
  `network: "quic"` values.
- Preserve richer WireGuard settings from URI and Clash/Mihomo subscriptions,
  including interface addresses, reserved bytes, workers, no-kernel-tun, and
  peer pre-shared-key, keepalive, and allowed-ips fields.
- Upgrade previously saved URI subscription nodes on load so old cached nodes
  get canonical Xray outbound settings without requiring manual re-import.
- Preserve desktop subscription fetch errors from the Tauri backend instead of
  masking them with browser CORS fallback errors.
- Respect the configured Tachyon Core IPC listen address and port for overview
  telemetry and native Core health checks instead of probing a hard-coded
  `127.0.0.1:55123` endpoint.
- Restore the shared i18n dictionary so Chinese and English status strings do
  not fall back to mojibake text.
- Stabilize custom Windows titlebar drag/no-drag regions with a native
  hit-test/subclass path for frameless WebView windows.
- Keep the overview page within the fixed 800x540 desktop smoke-test viewport
  after adding current-node, runtime presence, and proxy-probe UI.

### Verified
- TypeScript typecheck, Vitest, Vite production build, Rust check/tests, and UI
  smoke pass for the alpha.12 release candidate.
- Parsed VMess WebSocket, Trojan-Go-compatible, Hysteria, Clash/Mihomo, and
  WireGuard subscription nodes round-trip into generated Xray client config
  drafts.
- Rust tests cover local HTTP and SOCKS proxy probing without changing host
  system proxy settings.

### Known Limitations
- Release artifacts are unsigned and not notarized. Windows SmartScreen and
  macOS Gatekeeper may warn until signing and notarization are added.
- The System Proxy quick action is intentionally disabled in alpha builds.
- Tachyon Core TUN auto-route and DNS hijack are alpha-disabled and forced to
  false in generated Core client drafts.
- The local proxy probe validates Prism's local Xray HTTP/SOCKS inbounds, but
  real Xray nodes, real VPS reachability, and game UDP acceleration still need
  user-side testing in the target network environment.
- Tachyon server profiles require a correctly deployed Tachyon server with
  `allowed_targets` and matching `tgp.auth.psk`; Prism cannot validate the
  remote server policy offline.

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


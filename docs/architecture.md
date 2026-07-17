# Tachyon Prism Architecture

[中文说明](architecture.zh-CN.md)

Prism is a Tauri desktop shell with a React frontend and a Rust backend.

## Frontend / Backend Split

```text
src/                        src-tauri/src/
  App.tsx                     lib.rs
  domain/                       Tauri commands
    configDrafts.ts              Rust helpers
    desktopConfig.ts             Tests (40+)
    gameProfiles.ts
    runtime.ts
    subscriptions.ts
```

The frontend owns subscription parsing, node selection, config draft generation,
and all UI state. Tachyon Core stays pure: it receives generated config and does
not parse subscriptions or manage Xray nodes. The Rust backend owns filesystem
access, binary management, process spawning, and HTTP bridge calls to Core.

Tauri `invoke()` connects the two: the frontend calls named Rust commands, and
the Rust side returns JSON-serializable results.

## Views

| View | Purpose |
| --- | --- |
| Overview | Runtime status, game mode summary, readiness count |
| Nodes | Import subscription, browse nodes, select active node |
| Game Mode | Explicit server CIDRs, manual profiles, Steam scan suggestions |
| Launchers | Steam launcher detection, child-process tracking, UDP acceleration |
| Runtime | Binary management, install-from-release, start/stop cores, readiness |
| Config | Generate and save Xray + Core JSON drafts |

## Config Draft Generation

Prism generates two JSON files from the selected node and user settings:

- `xray-client.json`: local SOCKS inbound + Xray outbound from the selected node.
- `client.json`: Tachyon Core client config for the TGP game path, including
  game profiles under `client.routing.game_profiles`, launcher policy under
  `client.routing.launchers`, explicit destination CIDRs under
  `client.tun.game_routes`, TGP bind addresses under
  `client.proxy.local_addrs`, connection migration under
  `tgp.connection_migration`, and the multipath switch under `tgp.multipath`.

The generated configs are written to the Tauri app config directory and can also
be copied to clipboard from the Config panel.

## Binary Management

The Binaries panel manages Xray Core and Tachyon Core executables:

- Copy a local binary into Prism's managed `bin` directory.
- Query GitHub releases for the latest version and download + SHA-256 verify.
- On Windows, detect the required `wintun.dll` sidecar next to the Tachyon Core
  binary.

Binary paths are stored in `runtime-settings.json`. The Runtime panel uses these
paths when starting cores.

## Runtime Lifecycle

```text
Start All:
  1. Write config drafts (client.json + xray-client.json)
  2. Save runtime settings
  3. Validate configs and run preflight checks
  4. Start Xray and wait for local Xray readiness
  5. Start Tachyon Core and wait for local Core /v1/health readiness
  6. Roll back every core started by this transaction on any failure
```

The Runtime panel shows live process state for both cores and supports
individual start/stop controls.

Windows system proxy control is an implemented alpha transaction over the
current-user WinINet registry settings. It snapshots prior state, verifies the
applied values, restores the snapshot when control is released, and journals
recovery for the next launch after a crash. Real Windows host-registry
acceptance testing has not yet been performed, so this is not production-ready.
macOS and Linux system proxy control are unsupported.

TUN one-click takeover remains disabled and is a stable-release gate. Generated
Core configs force `client.tun.auto_route=false` and
`client.tun.dns_hijack=false`, require `client.tun.tgp_only=true`, and use the
safe MTU/datagram budget 1280/1352. The local HTTP/SOCKS probe only validates Prism's
generated Xray inbounds and does not change host network state.

## Test Coverage

| Layer | Tool | Count |
| --- | --- | --- |
| Rust backend | `cargo test` | 66 tests |
| Frontend domain | Vitest | 6 suites plus 1 live opt-in suite |
| TypeScript types | `tsc --noEmit` | Enforced in CI |

CI runs all three layers on every push (ubuntu, windows, macos).

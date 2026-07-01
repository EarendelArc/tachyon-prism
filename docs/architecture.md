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
and all UI state. The Rust backend owns filesystem access, binary management,
process spawning, and HTTP bridge calls to Core.

Tauri `invoke()` connects the two: the frontend calls named Rust commands, and
the Rust side returns JSON-serializable results.

## Views

| View | Purpose |
| --- | --- |
| Overview | Runtime status, game mode summary, readiness count |
| Nodes | Import subscription, browse nodes, select active node |
| Game Mode | Manual profiles, Steam scan suggestions |
| Launchers | Steam launcher detection, child-process tracking, UDP acceleration |
| Runtime | Binary management, install-from-release, start/stop cores, readiness |
| Config | Generate and save Xray + Core JSON drafts |

## Config Draft Generation

Prism generates two JSON files from the selected node and user settings:

- `xray-client.json`: local SOCKS inbound + Xray outbound from the selected node.
- `client.json`: Tachyon Core client config for the TGP game path, including
  game profiles under `client.routing.game_profiles`, launcher policy under
  `client.routing.launchers`, TGP bind addresses under
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
  3. Preflight checks (binary paths, sidecars, node, config drafts)
  4. Start Xray with xray-client.json
  5. Start Tachyon Core with client.json
  6. Poll Core /v1/health (3s timeout) for status
```

The Runtime panel shows live process state for both cores and supports
individual start/stop controls.

## Test Coverage

| Layer | Tool | Count |
| --- | --- | --- |
| Rust backend | `cargo test` | 66 tests |
| Frontend domain | Vitest | 6 suites plus 1 live opt-in suite |
| TypeScript types | `tsc --noEmit` | Enforced in CI |

CI runs all three layers on every push (ubuntu, windows, macos).

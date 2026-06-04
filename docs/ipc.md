# Prism IPC Contract

[中文说明](ipc.zh-CN.md)

Prism stores UI state locally but treats Core as the source of truth for routing
profiles and runtime status.

## Game Profile Payload

```json
{
  "id": "cs2",
  "displayName": "Counter-Strike 2",
  "enabled": true,
  "manual": true,
  "priority": 100,
  "match": {
    "processNames": ["cs2.exe"],
    "paths": [],
    "pathPrefixes": [],
    "sha256": [],
    "steamAppIds": [730]
  },
  "udpPolicy": "tgp",
  "tcpPolicy": "auto"
}
```

Manual profiles are sent to Core through `AddGameProfile` or
`UpdateGameProfile`. Steam scanning should create suggestions first, then let
the user promote them into manual profiles.

## HTTP Bridge

The initial Core bridge exposes JSON endpoints on `127.0.0.1:55123`:

- `GET /v1/health`
- `GET /v1/routing/game-profiles`
- `POST /v1/routing/game-profiles`
- `PUT /v1/routing/game-profiles/{id}`
- `DELETE /v1/routing/game-profiles/{id}`

This HTTP bridge is intentionally small. It lets Prism ship a real profile
management loop while the long-term gRPC/WebSocket transport is finalized.

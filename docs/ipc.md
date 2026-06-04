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

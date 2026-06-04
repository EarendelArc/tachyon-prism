# Prism IPC 契约

[English](ipc.md)

Prism 可以在本地保存 UI 状态，但 Core 是路由配置和运行时状态的事实来源。

## 游戏配置载荷

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

手动配置通过 `AddGameProfile` 或 `UpdateGameProfile` 发送给 Core。Steam 扫描应先生成建议，再由用户确认提升为手动配置。

## HTTP Bridge

第一版 Core bridge 在 `127.0.0.1:55123` 暴露 JSON 端点：

- `GET /v1/health`
- `GET /v1/routing/game-profiles`
- `POST /v1/routing/game-profiles`
- `PUT /v1/routing/game-profiles/{id}`
- `DELETE /v1/routing/game-profiles/{id}`

这个 HTTP bridge 会保持很小。它让 Prism 先拥有真实的配置管理闭环，同时为后续 gRPC/WebSocket 传输定稿留出空间。

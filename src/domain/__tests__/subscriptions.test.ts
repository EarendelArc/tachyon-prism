import { describe, expect, it } from "vitest";
import {
  activeSubscription,
  buildXrayOutboundDraft,
  createSubscriptionSnapshot,
  loadSubscriptionSnapshot,
  parseSubscription,
  removeSubscription,
  selectSubscription,
  selectSubscriptionNode,
  totalSubscriptionNodes,
} from "../subscriptions";
import type { ProxyNode } from "../subscriptions";

describe("parseSubscription", () => {
  it("parses a VMess URI", () => {
    const uri = "vmess://eyJ2IjoiMiIsInBzIjoiVGVzdCBTZXJ2ZXIiLCJhZGQiOiIxMC4wLjAuMSIsInBvcnQiOiI0NDMiLCJpZCI6InRlc3QtdXVpZCIsImFpZCI6IjAiLCJuZXQiOiJ3cyIsInR5cGUiOiJub25lIiwiaG9zdCI6ImV4YW1wbGUuY29tIiwicGF0aCI6Ii9wYXRoIiwidGxzIjoidGxzIn0=";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("vmess");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(443);
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      vnext: [
        {
          address: "10.0.0.1",
          port: 443,
          users: [{ id: "test-uuid", alterId: 0, security: "auto" }],
        },
      ],
    });
  });

  it("parses VLESS URIs", () => {
    const uri = "vless://test-uuid@10.0.0.1:443?type=ws&security=tls&path=/ws#My VLESS";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("vless");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(443);
    expect(nodes[0].credential).toBe("test-uuid");
    expect(nodes[0].name).toBe("My VLESS");
    expect(nodes[0].transport).toBe("websocket");
    expect(nodes[0].security).toBe("tls");
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      vnext: [
        {
          address: "10.0.0.1",
          port: 443,
          users: [{ id: "test-uuid", encryption: "none" }],
        },
      ],
    });
  });

  it("maps SplitHTTP share parameters to Xray xhttp stream settings", () => {
    const uri = "vless://uuid@example.com:443?type=splithttp&security=reality&sni=www.example.com&pbk=public-key&path=/xhttp&mode=auto#XHTTP";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].transport).toBe("xhttp");
    expect(nodes[0].outbound?.streamSettings).toMatchObject({
      network: "xhttp",
      security: "reality",
      xhttpSettings: {
        path: "/xhttp",
        mode: "auto",
      },
    });
  });

  it("parses Trojan URIs", () => {
    const uri = "trojan://password@example.com:8443#Trojan Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("trojan");
    expect(nodes[0].address).toBe("example.com");
    expect(nodes[0].port).toBe(8443);
    expect(nodes[0].credential).toBe("password");
    expect(nodes[0].name).toBe("Trojan Node");
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      servers: [{ address: "example.com", port: 8443, password: "password" }],
    });
  });

  it("parses Shadowsocks URIs with SIP002 format", () => {
    const uri = "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@10.0.0.1:8388#SS Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("shadowsocks");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(8388);
    expect(nodes[0].name).toBe("SS Node");
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      servers: [
        {
          address: "10.0.0.1",
          port: 8388,
          method: "aes-256-gcm",
          password: "password",
        },
      ],
    });
  });

  it("parses Hysteria URIs", () => {
    const uri = "hysteria://example.com:443?auth=secret&insecure=1#Hysteria Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("hysteria");
    expect(nodes[0].address).toBe("example.com");
    expect(nodes[0].port).toBe(443);
    expect(nodes[0].name).toBe("Hysteria Node");
  });

  it("parses SOCKS URIs", () => {
    const uri = "socks5://user:pass@10.0.0.1:1080#SOCKS Proxy";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("socks");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(1080);
    expect(nodes[0].credential).toContain("user");
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      servers: [
        {
          address: "10.0.0.1",
          port: 1080,
          users: [{ user: "user", pass: "pass" }],
        },
      ],
    });
  });

  it("parses HTTP outbound URIs into Xray server arrays", () => {
    const uri = "http://user:pass@proxy.example.com:8080#HTTP Proxy";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: "HTTP Proxy",
      protocol: "http",
      address: "proxy.example.com",
      port: 8080,
      credential: "user:***",
    });
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      servers: [
        {
          address: "proxy.example.com",
          port: 8080,
          users: [{ user: "user", pass: "pass" }],
        },
      ],
    });
  });

  it("parses WireGuard URIs", () => {
    const uri = "wireguard://cHVibGljLWtleQ==@10.0.0.1:51820?secretKey=c2VjcmV0LWtleQ==&address=10.1.0.2/24&mtu=1420#WG Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("wireguard");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(51820);
  });

  it("parses base64-encoded subscription payloads", () => {
    const encoded = Buffer.from("vmess://eyJ2IjoiMiIsInBzIjoiRW5jb2RlZCIsImFkZCI6IjEwLjAuMC4xIiwicG9ydCI6IjQ0MyIsImlkIjoidGVzdC11dWlkIiwiYWlkIjoiMCJ9").toString("base64");
    const nodes = parseSubscription(encoded);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("Encoded");
  });

  it("parses mixed Xray subscription payloads", () => {
    const payload = [
      "trojan://password@example.com:443?security=reality&sni=www.microsoft.com&fp=chrome#Reality Trojan",
      "vless://test-uuid@example.com:443?encryption=none&security=reality&type=tcp&sni=www.cloudflare.com&fp=chrome&pbk=public-key&sid=01#Reality VLESS",
      "hysteria2://secret@example.com:443?sni=game.example.com&insecure=1#Game Hysteria",
    ].join("\n");
    const nodes = parseSubscription(Buffer.from(payload).toString("base64"));

    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => node.protocol)).toEqual(["trojan", "vless", "hysteria"]);
    expect(nodes[0].security).toBe("reality");
    expect(nodes[1].transport).toBe("raw");
    expect(nodes[2].name).toBe("Game Hysteria");
  });

  it("extracts metadata from legacy Xray VLESS and VMess outbounds", () => {
    const payload = JSON.stringify({
      outbounds: [
        {
          tag: "Legacy VLESS",
          protocol: "vless",
          settings: {
            vnext: [
              {
                address: "vless.example.com",
                port: 443,
                users: [{ id: "vless-uuid", encryption: "none", flow: "xtls-rprx-vision" }],
              },
            ],
          },
          streamSettings: {
            network: "tcp",
            security: "reality",
            realitySettings: { serverName: "www.microsoft.com" },
          },
        },
        {
          tag: "Legacy VMess",
          protocol: "vmess",
          settings: {
            vnext: [
              {
                address: "vmess.example.com",
                port: 8443,
                users: [{ id: "vmess-uuid", security: "auto" }],
              },
            ],
          },
        },
      ],
    });

    const nodes = parseSubscription(payload);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      name: "Legacy VLESS",
      protocol: "vless",
      address: "vless.example.com",
      port: 443,
      credential: "vless-uuid",
      security: "reality",
      sni: "www.microsoft.com",
    });
    expect(nodes[1]).toMatchObject({
      name: "Legacy VMess",
      protocol: "vmess",
      address: "vmess.example.com",
      port: 8443,
      credential: "vmess-uuid",
    });
    expect(buildXrayOutboundDraft(nodes[0]).settings).toHaveProperty("vnext");
  });

  it("extracts metadata from legacy Xray server arrays", () => {
    const payload = JSON.stringify({
      outbounds: [
        {
          tag: "Legacy Trojan",
          protocol: "trojan",
          settings: {
            servers: [{ address: "trojan.example.com", port: 443, password: "secret" }],
          },
        },
        {
          tag: "Legacy Shadowsocks",
          protocol: "shadowsocks",
          settings: {
            servers: [
              {
                address: "ss.example.com",
                port: 8388,
                method: "2022-blake3-aes-128-gcm",
                password: "ss-secret",
              },
            ],
          },
        },
        {
          tag: "Legacy HTTP",
          protocol: "http",
          settings: {
            servers: [
              {
                address: "http.example.com",
                port: 8080,
                users: [{ user: "alice", pass: "password" }],
              },
            ],
          },
        },
      ],
    });

    const nodes = parseSubscription(payload);

    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({
      name: "Legacy Trojan",
      protocol: "trojan",
      address: "trojan.example.com",
      port: 443,
      credential: "secret",
    });
    expect(nodes[1]).toMatchObject({
      name: "Legacy Shadowsocks",
      protocol: "shadowsocks",
      address: "ss.example.com",
      port: 8388,
      credential: "2022-blake3-aes-128-gcm:ss-secret",
    });
    expect(nodes[2]).toMatchObject({
      name: "Legacy HTTP",
      protocol: "http",
      address: "http.example.com",
      port: 8080,
      credential: "alice:***",
    });
  });

  it("keeps all built-in Xray outbound protocols from JSON configs", () => {
    const payload = JSON.stringify({
      outbounds: [
        { tag: "Direct", protocol: "freedom", settings: { domainStrategy: "UseIP" } },
        { tag: "Block", protocol: "blackhole", settings: { response: { type: "http" } } },
        { tag: "DNS", protocol: "dns", settings: { address: "1.1.1.1", port: 53 } },
        { tag: "Loop", protocol: "loopback", settings: { inboundTag: "tachyon-socks" } },
      ],
    });

    const nodes = parseSubscription(payload);

    expect(nodes.map((node) => node.protocol)).toEqual([
      "freedom",
      "blackhole",
      "dns",
      "loopback",
    ]);
    expect(buildXrayOutboundDraft(nodes[0])).toMatchObject({
      protocol: "freedom",
      settings: { domainStrategy: "UseIP" },
    });
    expect(nodes[1].name).toBe("Block");
    expect(nodes[2]).toMatchObject({ address: "1.1.1.1", port: 53 });
  });

  it("parses common Clash/Mihomo YAML proxy lists", () => {
    const payload = `
proxies:
  - name: Clash VLESS Reality
    type: vless
    server: vless.example.com
    port: 443
    uuid: vless-uuid
    network: ws
    tls: true
    servername: www.cloudflare.com
    flow: xtls-rprx-vision
    reality-opts:
      public-key: reality-public-key
      short-id: "01"
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: Clash SS
    type: ss
    server: ss.example.com
    port: 8388
    cipher: 2022-blake3-aes-128-gcm
    password: ss-secret
proxy-groups:
  - name: Selector
    type: select
    proxies:
      - Clash VLESS Reality
      - Clash SS
`;

    const nodes = parseSubscription(payload);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      name: "Clash VLESS Reality",
      protocol: "vless",
      address: "vless.example.com",
      port: 443,
      credential: "vless-uuid",
      security: "reality",
      transport: "websocket",
      sni: "www.cloudflare.com",
    });
    expect(nodes[0].outbound?.streamSettings).toMatchObject({
      security: "reality",
      wsSettings: {
        path: "/ws",
        headers: { Host: "cdn.example.com" },
      },
    });
    expect(nodes[1]).toMatchObject({
      name: "Clash SS",
      protocol: "shadowsocks",
      address: "ss.example.com",
      port: 8388,
      credential: "2022-blake3-aes-128-gcm:ss-secret",
    });
  });

  it("deduplicates nodes with the same ID", () => {
    const uri = "vless://uuid@10.0.0.1:443\nvless://uuid@10.0.0.1:443";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseSubscription("")).toHaveLength(0);
    expect(parseSubscription("   ")).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const uri = "# This is a comment\nvless://uuid@10.0.0.1:443";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
  });
});

describe("createSubscriptionSnapshot", () => {
  const nodes: ProxyNode[] = [
    {
      id: "node-aaaaaaaa",
      name: "Node A",
      protocol: "vmess",
      address: "10.0.0.1",
      port: 443,
      rawUri: "vmess://test",
      outbound: { protocol: "vmess" },
    },
    {
      id: "node-bbbbbbbb",
      name: "Node B",
      protocol: "vless",
      address: "10.0.0.2",
      port: 443,
      rawUri: "vless://test",
      outbound: { protocol: "vless" },
    },
  ];

  it("creates a snapshot with the first node selected", () => {
    const snapshot = createSubscriptionSnapshot("https://example.com/sub", nodes, undefined, "Main");
    expect(snapshot.sourceUrl).toBe("https://example.com/sub");
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(activeSubscription(snapshot)?.name).toBe("Main");
    expect(snapshot.selectedNodeId).toBe("node-aaaaaaaa");
    expect(snapshot.updatedAt).toBeTruthy();
  });

  it("preserves previous selection when node still exists", () => {
    const prev = createSubscriptionSnapshot("https://example.com/sub", nodes);
    const updated = selectSubscriptionNode(prev, "node-bbbbbbbb");
    const next = createSubscriptionSnapshot("https://example.com/sub", nodes, updated);
    expect(next.selectedNodeId).toBe("node-bbbbbbbb");
  });

  it("uses the last URL path segment as the default subscription name", () => {
    const snapshot = createSubscriptionSnapshot(
      "http://earendel.art:45098/unsubscribe/Earendel",
      nodes,
    );

    expect(activeSubscription(snapshot)?.name).toBe("Earendel");
  });

  it("throws when nodes array is empty", () => {
    expect(() => createSubscriptionSnapshot("url", [])).toThrow(
      "No supported nodes found",
    );
  });

  it("keeps multiple named subscriptions", () => {
    const first = createSubscriptionSnapshot("https://example.com/a", nodes, undefined, "Alpha");
    const second = createSubscriptionSnapshot(
      "https://example.com/b",
      [nodes[1]],
      first,
      "Beta",
    );

    expect(second.subscriptions).toHaveLength(2);
    expect(totalSubscriptionNodes(second)).toBe(3);
    expect(activeSubscription(second)?.name).toBe("Beta");

    const alphaId = second.subscriptions.find((item) => item.name === "Alpha")?.id ?? "";
    const selected = selectSubscription(second, alphaId);
    expect(activeSubscription(selected)?.name).toBe("Alpha");
    expect(selected.nodes).toHaveLength(2);

    const removed = removeSubscription(selected, alphaId);
    expect(removed.subscriptions).toHaveLength(1);
    expect(activeSubscription(removed)?.name).toBe("Beta");
  });
});

describe("selectSubscriptionNode", () => {
  const nodes: ProxyNode[] = [
    {
      id: "node-00000001",
      name: "Node 1",
      protocol: "vmess",
      address: "10.0.0.1",
      port: 443,
      rawUri: "vmess://test",
      outbound: { protocol: "vmess" },
    },
  ];

  it("selects an existing node", () => {
    const snapshot = createSubscriptionSnapshot("url", nodes);
    const updated = selectSubscriptionNode(snapshot, "node-00000001");
    expect(updated.selectedNodeId).toBe("node-00000001");
  });

  it("throws for a non-existent node", () => {
    const snapshot = createSubscriptionSnapshot("url", nodes);
    expect(() => selectSubscriptionNode(snapshot, "nonexistent")).toThrow(
      "Selected node no longer exists",
    );
  });
});

describe("loadSubscriptionSnapshot", () => {
  it("upgrades stored URI nodes to canonical Xray outbounds", () => {
    const uri = "vless://uuid@example.com:443?encryption=none#Stored VLESS";
    const parsed = parseSubscription(uri)[0];
    const legacyNode: ProxyNode = {
      ...parsed,
      outbound: {
        protocol: "vless",
        settings: {
          address: "example.com",
          encryption: "none",
          id: "uuid",
          port: 443,
        },
      },
    };
    const rawSnapshot = {
      sourceUrl: "https://example.com/sub",
      updatedAt: "2026-06-30T00:00:00.000Z",
      nodes: [legacyNode],
      selectedNodeId: legacyNode.id,
      subscriptions: [
        {
          id: "subscription-test",
          name: "Stored",
          sourceUrl: "https://example.com/sub",
          updatedAt: "2026-06-30T00:00:00.000Z",
          nodes: [legacyNode],
        },
      ],
      selectedSubscriptionId: "subscription-test",
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const store = new Map<string, string>([
      ["tachyon.prism.subscription.v1", JSON.stringify(rawSnapshot)],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    try {
      const loaded = loadSubscriptionSnapshot();
      expect(activeSubscription(loaded)?.name).toBe("Stored");
      expect(buildXrayOutboundDraft(loaded.nodes[0]).settings).toMatchObject({
        vnext: [
          {
            address: "example.com",
            port: 443,
            users: [{ id: "uuid", encryption: "none" }],
          },
        ],
      });
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, "localStorage", previous);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});

describe("buildXrayOutboundDraft", () => {
  it("returns the node's outbound object", () => {
    const node: ProxyNode = {
      id: "node-test",
      name: "Test",
      protocol: "vmess",
      address: "10.0.0.1",
      port: 443,
      rawUri: "vmess://test",
      outbound: {
        protocol: "vmess",
        settings: {
          vnext: [
            { address: "10.0.0.1", port: 443, users: [{ id: "uuid" }] },
          ],
        },
      },
    };
    const outbound = buildXrayOutboundDraft(node);
    expect(outbound.protocol).toBe("vmess");
  });

  it("throws when node has no outbound", () => {
    const node: ProxyNode = {
      id: "node-test",
      name: "Test",
      protocol: "vmess",
      address: "10.0.0.1",
      port: 443,
      rawUri: "vmess://test",
    };
    expect(() => buildXrayOutboundDraft(node)).toThrow();
  });
});

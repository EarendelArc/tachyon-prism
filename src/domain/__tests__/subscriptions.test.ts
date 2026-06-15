import { describe, expect, it } from "vitest";
import {
  activeSubscription,
  buildXrayOutboundDraft,
  createSubscriptionSnapshot,
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
  });

  it("parses Shadowsocks URIs with SIP002 format", () => {
    const uri = "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@10.0.0.1:8388#SS Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("shadowsocks");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(8388);
    expect(nodes[0].name).toBe("SS Node");
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

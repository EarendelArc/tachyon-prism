import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSubscription,
  buildXrayOutboundDraft,
  createSubscriptionSnapshot,
  fetchSubscriptionText,
  parseSubscription,
  parseSubscriptionWithReport,
  removeSubscription,
  selectSubscription,
  selectSubscriptionNode,
  subscriptionSnapshotForStorage,
  subscriptionSnapshotFromStored,
  totalSubscriptionNodes,
  xrayConfigTemplateForNode,
  xrayOutboundCompatibilityForNode,
  SubscriptionError,
} from "../subscriptions";
import type { ProxyNode } from "../subscriptions";
import {
  subscriptionCompatibilityFixtures,
  unsupportedSingBoxJsonFixture,
  unsupportedSubscriptionFixture,
  xrayFullConfigJsonFixture,
} from "./subscriptionFixtures";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.isTauri.mockReturnValue(false);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchSubscriptionText", () => {
  it("uses browser fetch only when Tauri is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "vless://uuid@example.com:443#Node",
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchSubscriptionText("https://example.com/sub")).resolves.toContain("vless://");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/sub",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: expect.stringContaining("text/plain"),
        }),
      }),
    );
  });

  it("preserves desktop fetch errors instead of masking them with CORS fallback", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockRejectedValue(new Error("request failed: 502"));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchSubscriptionText("https://example.com/sub")).rejects.toMatchObject({
      code: "fetch-failed",
      detail: "request failed: 502",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseSubscription", () => {
  it("parses a VMess URI", () => {
    const uri = "vmess://eyJ2IjoiMiIsInBzIjoiVGVzdCBTZXJ2ZXIiLCJhZGQiOiIxMC4wLjAuMSIsInBvcnQiOiI0NDMiLCJpZCI6InRlc3QtdXVpZCIsImFpZCI6IjAiLCJuZXQiOiJ3cyIsInR5cGUiOiJub25lIiwiaG9zdCI6ImV4YW1wbGUuY29tIiwicGF0aCI6Ii9wYXRoIiwidGxzIjoidGxzIn0=";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("vmess");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(443);
    expect(nodes[0].transport).toBe("websocket");
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      address: "10.0.0.1",
      port: 443,
      id: "test-uuid",
      alterId: 0,
      security: "auto",
    });
    expect(buildXrayOutboundDraft(nodes[0]).streamSettings).toMatchObject({
      network: "websocket",
      security: "tls",
      wsSettings: {
        path: "/path",
        headers: { Host: "example.com" },
      },
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
      address: "10.0.0.1",
      port: 443,
      id: "test-uuid",
      encryption: "none",
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

  it("maps current mKCP share parameters without deprecated header fields", () => {
    const uri = "vless://uuid@example.com:443?type=kcp&mtu=1200&tti=30&uplinkCapacity=10&downlinkCapacity=100&congestion=1&readBufferSize=4&writeBufferSize=8&headerType=wechat-video&seed=old#KCP";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].outbound?.streamSettings).toMatchObject({
      network: "mkcp",
      kcpSettings: {
        mtu: 1200,
        tti: 30,
        uplinkCapacity: 10,
        downlinkCapacity: 100,
        congestion: true,
        readBufferSize: 4,
        writeBufferSize: 8,
      },
    });
    const kcpSettings = nodes[0].outbound?.streamSettings?.kcpSettings as Record<string, unknown>;
    expect(kcpSettings.header).toBeUndefined();
    expect(kcpSettings.seed).toBeUndefined();
  });

  it("drops deprecated QUIC transport markers instead of generating invalid Xray network values", () => {
    const uri = "vless://uuid@example.com:443?type=quic&security=tls&sni=quic.example.com#Old QUIC";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].outbound?.streamSettings).toMatchObject({
      security: "tls",
      tlsSettings: {
        serverName: "quic.example.com",
      },
    });
    expect(nodes[0].outbound?.streamSettings?.network).toBeUndefined();
  });

  it("maps current Reality and TLS share parameters into Xray stream settings", () => {
    const realityUri = "vless://uuid@example.com:443?type=tcp&security=reality&sni=www.example.com&pbk=public-key&sid=0123&mldsa65Verify=pq-verify&spx=/probe&fp=chrome#Reality";
    const xhttpUri = "vless://uuid@example.com:443?type=splithttp&security=reality&sni=www.example.com&pbk=public-key&path=/xhttp&mode=auto#Reality XHTTP";
    const grpcUri = "vless://uuid@example.com:443?type=grpc&security=reality&sni=www.example.com&pbk=public-key&serviceName=tunnel#Reality gRPC";
    const tlsUri = "trojan://password@tls.example.com:443?security=tls&sni=edge.example.com&echConfigList=ech-list&pinnedPeerCertSha256=sha256-pin&alpn=h2,http/1.1#TLS";
    const [reality, xhttp, grpc, tls] = parseSubscription([realityUri, xhttpUri, grpcUri, tlsUri].join("\n"));

    expect(reality.outbound?.streamSettings).toMatchObject({
      network: "raw",
      security: "reality",
      realitySettings: {
        serverName: "www.example.com",
        password: "public-key",
        shortId: "0123",
        mldsa65Verify: "pq-verify",
        spiderX: "/probe",
      },
    });
    expect(xhttp.outbound?.streamSettings).toMatchObject({
      network: "xhttp",
      security: "reality",
      xhttpSettings: {
        path: "/xhttp",
        mode: "auto",
      },
    });
    expect(grpc.outbound?.streamSettings).toMatchObject({
      network: "grpc",
      security: "reality",
      grpcSettings: {
        serviceName: "tunnel",
      },
    });
    expect(tls.outbound?.streamSettings).toMatchObject({
      security: "tls",
      tlsSettings: {
        serverName: "edge.example.com",
        echConfigList: "ech-list",
        pinnedPeerCertSha256: "sha256-pin",
        alpn: ["h2", "http/1.1"],
      },
    });
  });

  it("rejects Reality on websocket and Hysteria without TLS when building Xray outbounds", () => {
    const wsRealityUri = "vless://uuid@example.com:443?type=ws&security=reality&sni=www.example.com&pbk=public-key#Reality WS";
    const hysteriaNoTlsUri = "hysteria2://secret@example.com:443?sni=game.example.com#Hysteria No TLS";
    const [wsReality, hysteriaNoTls] = parseSubscription([wsRealityUri, hysteriaNoTlsUri].join("\n"));

    expect(xrayOutboundCompatibilityForNode(wsReality)).toMatchObject({
      status: "unsupported-by-xray",
      reason: expect.stringContaining("REALITY"),
    });
    expect(() => buildXrayOutboundDraft(wsReality)).toThrow(/REALITY only works/);

    expect(xrayOutboundCompatibilityForNode(hysteriaNoTls)).toMatchObject({
      status: "unsupported-by-xray",
      reason: expect.stringContaining("Hysteria"),
    });
    expect(() => buildXrayOutboundDraft(hysteriaNoTls)).toThrow(/Hysteria outbounds require TLS/);
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
      address: "example.com",
      port: 8443,
      password: "password",
    });
  });

  it("parses Trojan-Go compatible URIs as Xray Trojan outbounds", () => {
    const uri = "trojan-go://password@example.com:443?sni=edge.example.com&type=ws&path=/trojan#Trojan-Go Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: "Trojan-Go Node",
      protocol: "trojan",
      address: "example.com",
      port: 443,
      transport: "websocket",
    });
    expect(buildXrayOutboundDraft(nodes[0]).streamSettings).toMatchObject({
      network: "websocket",
      wsSettings: { path: "/trojan" },
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
      address: "10.0.0.1",
      port: 8388,
      method: "aes-256-gcm",
      password: "password",
    });
  });

  it("maps Shadowsocks v2ray-plugin options to equivalent Xray stream settings", () => {
    const plugin = encodeURIComponent("v2ray-plugin;mode=websocket;tls;host=cdn.example.com;path=/ss");
    const uri = `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@10.0.0.1:8388?plugin=${plugin}#SS WS`;
    const nodes = parseSubscription(uri);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].transport).toBe("websocket");
    expect(nodes[0].outbound?.streamSettings).toMatchObject({
      network: "websocket",
      security: "tls",
      wsSettings: {
        path: "/ss",
        headers: { Host: "cdn.example.com" },
      },
    });
  });

  it("parses Hysteria URIs", () => {
    const uri = "hy2://secret@example.com:443?security=tls&sni=game.example.com&up=25&down=100&udpIdleTimeout=30s#Hysteria Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("hysteria");
    expect(nodes[0].address).toBe("example.com");
    expect(nodes[0].port).toBe(443);
    expect(nodes[0].name).toBe("Hysteria Node");
    expect(nodes[0].credential).toBe("secret");
    expect(buildXrayOutboundDraft(nodes[0]).streamSettings).toMatchObject({
      network: "hysteria",
      security: "tls",
      tlsSettings: {
        serverName: "game.example.com",
      },
      hysteriaSettings: {
        auth: "secret",
        udpIdleTimeout: 30,
      },
    });
    expect(nodes[0].parameters).toMatchObject({
      up: "25",
      down: "100",
    });
  });

  it("parses TUIC URIs into selectable nodes", () => {
    const uri = "tuic://uuid:secret@tuic.example.com:443?sni=edge.example.com&alpn=h3&congestion=bbr&udpRelayMode=native&zeroRttHandshake=true#TUIC Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: "TUIC Node",
      protocol: "tuic",
      address: "tuic.example.com",
      port: 443,
      credential: "uuid:***",
      security: "tls",
      sni: "edge.example.com",
    });
    expect(nodes[0].outbound).toMatchObject({
      protocol: "tuic",
      settings: {
        address: "tuic.example.com",
        port: 443,
        uuid: "uuid",
        password: "secret",
        congestion: "bbr",
        udpRelayMode: "native",
        zeroRttHandshake: true,
      },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
          alpn: ["h3"],
        },
      },
    });
    expect(xrayOutboundCompatibilityForNode(nodes[0])).toMatchObject({
      status: "unsupported-by-xray",
      reason: expect.stringContaining("TUIC"),
    });
    expect(() => buildXrayOutboundDraft(nodes[0])).toThrow(/unsupported-by-xray/);
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
      address: "10.0.0.1",
      port: 1080,
      user: "user",
      pass: "pass",
    });
  });

  it("parses HTTP outbound URIs into current Xray settings", () => {
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
      address: "proxy.example.com",
      port: 8080,
      user: "user",
      pass: "pass",
    });
  });

  it("parses WireGuard URIs", () => {
    const uri = "wireguard://cHVibGljLWtleQ==@10.0.0.1:51820?secretKey=c2VjcmV0LWtleQ==&address=10.1.0.2/24,fd00::2/128&reserved=1,2,3&mtu=1420&workers=2&noKernelTun=true&domainStrategy=ForceIP&preSharedKey=psk&keepAlive=25&allowedIPs=0.0.0.0/0,::/0#WG Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("wireguard");
    expect(nodes[0].address).toBe("10.0.0.1");
    expect(nodes[0].port).toBe(51820);
    expect(buildXrayOutboundDraft(nodes[0]).settings).toMatchObject({
      secretKey: "c2VjcmV0LWtleQ==",
      address: ["10.1.0.2/24", "fd00::2/128"],
      reserved: [1, 2, 3],
      mtu: 1420,
      workers: 2,
      noKernelTun: true,
      domainStrategy: "ForceIP",
      peers: [
        {
          endpoint: "10.0.0.1:51820",
          publicKey: "cHVibGljLWtleQ==",
          preSharedKey: "psk",
          keepAlive: 25,
          allowedIPs: ["0.0.0.0/0", "::/0"],
        },
      ],
    });
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
      security: "reality",
      sni: "www.microsoft.com",
    });
    expect(nodes[1]).toMatchObject({
      name: "Legacy VMess",
      protocol: "vmess",
      address: "vmess.example.com",
      port: 8443,
    });
    expect(nodes.every((node) => !("credential" in node))).toBe(true);
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
    });
    expect(nodes[1]).toMatchObject({
      name: "Legacy Shadowsocks",
      protocol: "shadowsocks",
      address: "ss.example.com",
      port: 8388,
    });
    expect(nodes[2]).toMatchObject({
      name: "Legacy HTTP",
      protocol: "http",
      address: "http.example.com",
      port: 8080,
    });
    expect(nodes.every((node) => !("credential" in node))).toBe(true);
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

  it("attaches only normalized outbounds from a complete remote Xray config", () => {
    const nodes = parseSubscription(xrayFullConfigJsonFixture);
    const source = JSON.parse(xrayFullConfigJsonFixture) as Record<string, unknown>;
    const sourceOutbounds = source.outbounds as unknown[];

    expect(nodes).toHaveLength(2);
    expect(nodes[0].xrayConfigId).toBe(nodes[1].xrayConfigId);
    expect(nodes.map((node) => node.xrayOutboundIndex)).toEqual([0, 1]);
    expect(nodes[0]).not.toHaveProperty("xrayConfig");
    expect(nodes[1]).not.toHaveProperty("xrayConfig");
    expect(nodes[0]).not.toHaveProperty("outbound");
    expect(nodes[1]).not.toHaveProperty("outbound");
    const template = xrayConfigTemplateForNode(nodes[0]);
    expect(Object.keys(template ?? {})).toEqual(["outbounds"]);
    expect((template?.outbounds as unknown[] | undefined)?.length).toBe(sourceOutbounds.length);
    const secondTemplate = xrayConfigTemplateForNode(nodes[1]);
    expect(Object.keys(secondTemplate ?? {})).toEqual(["outbounds"]);
    expect((secondTemplate?.outbounds as unknown[] | undefined)?.length).toBe(
      sourceOutbounds.length,
    );
    expect(buildXrayOutboundDraft(nodes[0])).toMatchObject({
      tag: "Xray Full Trojan TLS",
      userOutboundField: { retained: true },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
          fingerprint: "chrome",
        },
        sockopt: {
          tcpKeepAliveIdle: 60,
          tcpKeepAliveInterval: 30,
        },
      },
    });
    expect(buildXrayOutboundDraft(nodes[1])).toMatchObject({
      tag: "tachyon-proxy",
      streamSettings: {
        network: "xhttp",
        xhttpSettings: {
          path: "/xhttp",
          mode: "auto",
          extra: { xPaddingBytes: "100-1000" },
        },
      },
    });
  });

  it("rejects unknown remote outbound protocols instead of promoting them to runtime", () => {
    const payload = JSON.stringify({
      outbounds: [
        {
          tag: "Future protocol",
          protocol: "future-xray-protocol",
          settings: { credential: "future-secret", futureOption: { enabled: true } },
          futureOutboundField: ["kept"],
        },
      ],
      futureTopLevelField: { kept: true },
    });
    const nodes = parseSubscription(payload);

    expect(nodes).toHaveLength(0);
  });

  it("keeps multiple full Xray templates once each at the subscription profile boundary", () => {
    const secondConfig = JSON.stringify({
      outbounds: [
        {
          tag: "Second VLESS",
          protocol: "vless",
          settings: {
            address: "second.example.com",
            port: 443,
            id: "second-vless-uuid",
            encryption: "none",
          },
        },
      ],
      secondUnknownTopLevel: { retained: true },
    });
    const nodes = parseSubscription(`${xrayFullConfigJsonFixture}\n${secondConfig}`);
    const snapshot = createSubscriptionSnapshot("https://example.com/multi-config", nodes);
    const profile = activeSubscription(snapshot);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].xrayConfigId).toBe(nodes[1].xrayConfigId);
    expect(nodes[2].xrayConfigId).not.toBe(nodes[0].xrayConfigId);
    expect(Object.keys(profile?.xrayConfigTemplates ?? {})).toHaveLength(2);
    expect(Object.keys(xrayConfigTemplateForNode(snapshot.nodes[2]) ?? {})).toEqual([
      "outbounds",
    ]);
    expect(snapshot.nodes.every((node) => !("xrayConfig" in node))).toBe(true);
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
    skip-cert-verify: true
    alpn: [h2, http/1.1]
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
  - name: Clash Trojan TLS
    type: trojan
    server: trojan.example.com
    port: 443
    password: trojan-secret
    tls: true
    skip-cert-verify: true
    alpn: [h2, http/1.1]
    sni: tls.example.com
  - { name: Clash Hy2, type: hysteria2, server: hy2.example.com, port: 443, password: hy-secret, up: 50, down: 200, udp-idle-timeout: 20s }
  - { name: Clash WG, type: wireguard, server: wg.example.com, port: 51820, private-key: private-key, public-key: public-key, ip: [10.0.0.2/32, fd00::2/128], reserved: [1, 2, 3], mtu: 1280, workers: 2, no-kernel-tun: true, pre-shared-key: psk, keepalive: 25, allowed-ips: [0.0.0.0/0, ::/0] }
proxy-groups:
  - name: Selector
    type: select
    proxies:
      - Clash VLESS Reality
      - Clash SS
`;

    const nodes = parseSubscription(payload);

    expect(nodes).toHaveLength(5);
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
    expect(nodes[0].outbound?.settings).toMatchObject({
      address: "vless.example.com",
      port: 443,
      id: "vless-uuid",
      encryption: "none",
      flow: "xtls-rprx-vision",
    });
    expect(nodes[1]).toMatchObject({
      name: "Clash SS",
      protocol: "shadowsocks",
      address: "ss.example.com",
      port: 8388,
      credential: "2022-blake3-aes-128-gcm:ss-secret",
    });
    expect(nodes[1].outbound?.settings).toMatchObject({
      address: "ss.example.com",
      port: 8388,
      method: "2022-blake3-aes-128-gcm",
      password: "ss-secret",
    });
    expect(nodes[2]).toMatchObject({
      name: "Clash Trojan TLS",
      protocol: "trojan",
      address: "trojan.example.com",
      port: 443,
      credential: "trojan-secret",
      security: "tls",
      sni: "tls.example.com",
    });
    expect(nodes[2].outbound?.streamSettings).toMatchObject({
      security: "tls",
      tlsSettings: {
        serverName: "tls.example.com",
        allowInsecure: true,
        alpn: ["h2", "http/1.1"],
      },
    });
    expect(nodes[3]).toMatchObject({
      name: "Clash Hy2",
      protocol: "hysteria",
      address: "hy2.example.com",
      port: 443,
      credential: "hy-secret",
      transport: "hysteria",
    });
    expect(nodes[3].outbound?.streamSettings).toMatchObject({
      network: "hysteria",
      hysteriaSettings: {
        auth: "hy-secret",
        udpIdleTimeout: 20,
      },
    });
    expect(nodes[4]).toMatchObject({
      name: "Clash WG",
      protocol: "wireguard",
      address: "wg.example.com",
      port: 51820,
      credential: "private-key",
    });
    expect(nodes[4].outbound?.settings).toMatchObject({
      secretKey: "private-key",
      address: ["10.0.0.2/32", "fd00::2/128"],
      reserved: [1, 2, 3],
      mtu: 1280,
      workers: 2,
      noKernelTun: true,
      peers: [
        {
          endpoint: "wg.example.com:51820",
          publicKey: "public-key",
          preSharedKey: "psk",
          keepAlive: 25,
          allowedIPs: ["0.0.0.0/0", "::/0"],
        },
      ],
    });
  });

  it.each(subscriptionCompatibilityFixtures)(
    "parses compatibility fixture: $id",
    ({ payload, expected, outboundMatch, xrayCompatibilityStatus = "supported" }) => {
      const nodes = parseSubscription(payload);

      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject(expected);
      expect(nodes[0].name).toBeTruthy();
      expect(nodes[0].protocol).toBe(expected.protocol);
      expect(nodes[0].address).toBe(expected.address);
      expect(nodes[0].port).toBe(expected.port);
      expect(xrayOutboundCompatibilityForNode(nodes[0]).status).toBe(xrayCompatibilityStatus);
      if (xrayCompatibilityStatus === "supported") {
        expect(buildXrayOutboundDraft(nodes[0])).toMatchObject(outboundMatch);
      } else {
        expect(nodes[0].outbound).toMatchObject(outboundMatch);
        expect(() => buildXrayOutboundDraft(nodes[0])).toThrow(/unsupported-by-xray/);
      }
    },
  );

  it("reports unsupported protocols from URI and sing-box JSON inputs", () => {
    expect(parseSubscriptionWithReport(unsupportedSubscriptionFixture)).toMatchObject({
      nodes: [expect.objectContaining({ name: "OK", protocol: "vless" })],
      totalEntries: 3,
      skippedEntries: 2,
      invalidEntries: 1,
      unsupportedProtocols: { ssr: 1 },
    });
    expect(parseSubscriptionWithReport(unsupportedSingBoxJsonFixture)).toMatchObject({
      nodes: [],
      totalEntries: 1,
      skippedEntries: 1,
      invalidEntries: 0,
      unsupportedProtocols: { selector: 1 },
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

  it("reports unsupported, invalid, and duplicate subscription entries", () => {
    const payload = [
      "vless://uuid@example.com:443?encryption=none#Node",
      "vless://uuid@example.com:443?encryption=none#Node",
      "ssr://legacy",
      "not-a-node",
    ].join("\n");

    const report = parseSubscriptionWithReport(payload);

    expect(report.nodes).toHaveLength(1);
    expect(report.totalEntries).toBe(4);
    expect(report.skippedEntries).toBe(2);
    expect(report.invalidEntries).toBe(1);
    expect(report.duplicateNodes).toBe(1);
    expect(report.unsupportedProtocols).toEqual({
      ssr: 1,
    });
  });

  it("parses Clash/Mihomo TUIC proxies and reports other unsupported protocols", () => {
    const payload = `
proxies:
  - { name: OK, type: vless, server: ok.example.com, port: 443, uuid: uuid }
  - { name: TUIC, type: tuic, server: tuic.example.com, port: 443, uuid: tuic-uuid, password: secret, sni: edge.example.com, alpn: [h3], congestion-controller: bbr, udp-relay-mode: native }
  - { name: SSR, type: ssr, server: ssr.example.com, port: 443 }
`;

    const report = parseSubscriptionWithReport(payload);

    expect(report.nodes).toHaveLength(2);
    expect(report.nodes[1]).toMatchObject({
      name: "TUIC",
      protocol: "tuic",
      address: "tuic.example.com",
      port: 443,
      credential: "secret",
      security: "tls",
      sni: "edge.example.com",
    });
    expect(report.nodes[1].outbound?.settings).toMatchObject({
      uuid: "tuic-uuid",
      password: "secret",
      congestion: "bbr",
      udpRelayMode: "native",
    });
    expect(xrayOutboundCompatibilityForNode(report.nodes[1])).toMatchObject({
      status: "unsupported-by-xray",
    });
    expect(report.totalEntries).toBe(3);
    expect(report.skippedEntries).toBe(1);
    expect(report.unsupportedProtocols).toEqual({ ssr: 1 });
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

  it("uses stable codes for missing subscription selections", () => {
    const snapshot = createSubscriptionSnapshot("https://example.com/a", nodes, undefined, "Alpha");
    try {
      selectSubscription(snapshot, "missing");
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect(error).toMatchObject({ code: "subscription-missing" });
    }
  });

  it("uses name and URL as the profile identity and updates that exact pair", () => {
    const first = createSubscriptionSnapshot(
      "https://example.com/shared",
      nodes,
      undefined,
      "Alpha",
    );
    const second = createSubscriptionSnapshot(
      "https://example.com/shared",
      [nodes[1]],
      first,
      "Beta",
    );
    const alphaUpdate = createSubscriptionSnapshot(
      "https://example.com/shared",
      [nodes[1]],
      second,
      "Alpha",
    );

    expect(alphaUpdate.subscriptions).toHaveLength(2);
    expect(alphaUpdate.subscriptions.map((item) => item.name)).toEqual(["Alpha", "Beta"]);
    expect(activeSubscription(alphaUpdate)).toMatchObject({
      name: "Alpha",
      sourceUrl: "https://example.com/shared",
      nodes: [expect.objectContaining({ id: "node-bbbbbbbb" })],
    });
    expect(alphaUpdate.selectedNodeId).toBe("node-bbbbbbbb");
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
    try {
      selectSubscriptionNode(snapshot, "nonexistent");
      throw new Error("expected node selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect(error).toMatchObject({ code: "node-missing" });
    }
  });

  it("keeps the active subscription when node IDs exist in multiple profiles", () => {
    const first = createSubscriptionSnapshot(
      "https://example.com/alpha",
      nodes,
      undefined,
      "Alpha",
    );
    const second = createSubscriptionSnapshot(
      "https://example.com/beta",
      nodes,
      first,
      "Beta",
    );

    const selected = selectSubscriptionNode(second, nodes[0].id);

    expect(activeSubscription(selected)?.name).toBe("Beta");
    expect(selected.selectedNodeId).toBe(nodes[0].id);
  });
});

describe("subscription vault serialization", () => {
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
    const loaded = subscriptionSnapshotFromStored(rawSnapshot);
    expect(activeSubscription(loaded)?.name).toBe("Stored");
    expect(buildXrayOutboundDraft(loaded.nodes[0]).settings).toMatchObject({
      address: "example.com",
      port: 443,
      id: "uuid",
      encryption: "none",
    });
  });

  it("persists only normalized remote outbounds through snapshot storage", () => {
    const nodes = parseSubscription(xrayFullConfigJsonFixture);
    const snapshot = createSubscriptionSnapshot("https://example.com/full-xray", nodes);
    const source = JSON.parse(xrayFullConfigJsonFixture) as Record<string, unknown>;
    const persisted = subscriptionSnapshotForStorage(snapshot) as unknown as Record<string, unknown>;
      const persistedProfiles = persisted.subscriptions as Array<Record<string, unknown>>;
      const persistedProfile = persistedProfiles[0];
      const persistedNodes = persistedProfile.nodes as Array<Record<string, unknown>>;
      const persistedTemplates = persistedProfile.xrayConfigTemplates as Record<
        string,
        unknown
      >;

      expect(persisted.nodes).toEqual([]);
      expect(persistedNodes).toHaveLength(2);
      expect(persistedNodes.every((item) => !("xrayConfig" in item))).toBe(true);
      expect(persistedNodes.every((item) => !("outbound" in item))).toBe(true);
      expect(persistedNodes.map((item) => item.xrayOutboundIndex)).toEqual([0, 1]);
      expect(new Set(persistedNodes.map((item) => item.xrayConfigId))).toHaveProperty(
        "size",
        1,
      );
      expect(Object.values(persistedTemplates)).toHaveLength(1);
      expect(
        Object.values(persistedTemplates).every(
          (template) => Object.keys(template as Record<string, unknown>).join(",") === "outbounds",
        ),
      ).toBe(true);
      expect((JSON.stringify(persisted).match(/xray-trojan-secret/g) ?? [])).toHaveLength(1);

      const loaded = subscriptionSnapshotFromStored(persisted);
      const loadedTemplate = xrayConfigTemplateForNode(loaded.nodes[1]);
      expect(loaded.nodes[0].xrayConfigId).toBe(loaded.nodes[1].xrayConfigId);
      expect(loaded.nodes[0]).not.toHaveProperty("xrayConfig");
      expect(activeSubscription(loaded)?.xrayConfigTemplates).toEqual(persistedTemplates);
      expect(Object.keys(loadedTemplate ?? {})).toEqual(["outbounds"]);
      expect((loadedTemplate?.outbounds as unknown[] | undefined)?.length).toBe(
        (source.outbounds as unknown[]).length,
      );
  });

  it("migrates node-level imported config copies into one profile template", () => {
    const nodes = parseSubscription(xrayFullConfigJsonFixture);
    const source = JSON.parse(xrayFullConfigJsonFixture) as Record<string, unknown>;
    const rawSnapshot = {
      selectedNodeId: nodes[1].id,
      selectedSubscriptionId: "legacy-full-xray",
      subscriptions: [
        {
          id: "legacy-full-xray",
          name: "Legacy full Xray",
          sourceUrl: "https://example.com/legacy-full-xray",
          updatedAt: "2026-07-11T00:00:00.000Z",
          nodes: nodes.map((node) => ({
            ...node,
            xrayConfigId: undefined,
            xrayConfig: source,
          })),
        },
      ],
    };
    const loaded = subscriptionSnapshotFromStored(rawSnapshot);
      const profile = activeSubscription(loaded);

      expect(Object.keys(profile?.xrayConfigTemplates ?? {})).toHaveLength(1);
      expect(loaded.nodes.every((node) => !("xrayConfig" in node))).toBe(true);
      expect(loaded.nodes.every((node) => !("outbound" in node))).toBe(true);
      expect(loaded.nodes[0].xrayConfigId).toBe(loaded.nodes[1].xrayConfigId);
      expect(loaded.nodes.map((node) => node.xrayOutboundIndex)).toEqual([0, 1]);
      expect(Object.keys(xrayConfigTemplateForNode(loaded.nodes[1]) ?? {})).toEqual([
        "outbounds",
      ]);
  });

  it("strips privileged and unknown controls from malicious remote Xray JSON", () => {
    const payload = JSON.stringify({
      inbounds: [{ tag: "hostile", listen: "0.0.0.0", port: 1080, protocol: "socks" }],
      api: { tag: "hostile-api", services: ["HandlerService"] },
      reverse: { bridges: [{ tag: "hostile-bridge", domain: "secret.invalid" }] },
      log: { access: "C:\\hostile-access.log", error: "/tmp/hostile-error.log" },
      stats: {},
      policy: { system: { statsUserUplink: true } },
      transport: { tcpSettings: { acceptProxyProtocol: true } },
      observatory: { subjectSelector: ["hostile"] },
      unknownTopLevel: { execute: true },
      outbounds: [
        {
          tag: "safe-node",
          protocol: "vless",
          settings: {
            vnext: [
              {
                address: "edge.example.com",
                port: 443,
                users: [{ id: "fixture-sensitive-uuid", encryption: "none" }],
              },
            ],
          },
        },
      ],
    });
    const nodes = parseSubscription(payload);
    const template = xrayConfigTemplateForNode(nodes[0]);

    expect(nodes).toHaveLength(1);
    expect(Object.keys(template ?? {})).toEqual(["outbounds"]);
    for (const forbidden of [
      "inbounds",
      "api",
      "reverse",
      "log",
      "stats",
      "policy",
      "transport",
      "observatory",
      "unknownTopLevel",
    ]) {
      expect(template).not.toHaveProperty(forbidden);
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
          address: "10.0.0.1",
          port: 443,
          id: "uuid",
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

  it("throws when a retained node is not supported by Xray outbound protocols", () => {
    const [node] = parseSubscription(
      "tuic://uuid:secret@tuic.example.com:443?sni=edge.example.com#TUIC",
    );

    expect(node.outbound).toMatchObject({ protocol: "tuic" });
    expect(() => buildXrayOutboundDraft(node)).toThrow(
      /Official Xray outbound protocols do not include TUIC/,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSubscription,
  buildXrayOutboundDraft,
  createSubscriptionSnapshot,
  fetchSubscriptionText,
  loadSubscriptionSnapshot,
  parseSubscription,
  parseSubscriptionWithReport,
  removeSubscription,
  selectSubscription,
  selectSubscriptionNode,
  totalSubscriptionNodes,
} from "../subscriptions";
import type { ProxyNode } from "../subscriptions";

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

    await expect(fetchSubscriptionText("https://example.com/sub")).rejects.toThrow(
      "request failed: 502",
    );
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
    const tlsUri = "trojan://password@tls.example.com:443?security=tls&sni=edge.example.com&echConfigList=ech-list&pinnedPeerCertSha256=sha256-pin&alpn=h2,http/1.1#TLS";
    const [reality, tls] = parseSubscription([realityUri, tlsUri].join("\n"));

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
    const uri = "hy2://secret@example.com:443?insecure=1&up=25&down=100&udpIdleTimeout=30s#Hysteria Node";
    const nodes = parseSubscription(uri);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].protocol).toBe("hysteria");
    expect(nodes[0].address).toBe("example.com");
    expect(nodes[0].port).toBe(443);
    expect(nodes[0].name).toBe("Hysteria Node");
    expect(nodes[0].credential).toBe("secret");
    expect(buildXrayOutboundDraft(nodes[0]).streamSettings).toMatchObject({
      network: "hysteria",
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
      "tuic://token@example.com:443#Unsupported",
      "ssr://legacy",
      "not-a-node",
    ].join("\n");

    const report = parseSubscriptionWithReport(payload);

    expect(report.nodes).toHaveLength(1);
    expect(report.totalEntries).toBe(5);
    expect(report.skippedEntries).toBe(3);
    expect(report.invalidEntries).toBe(1);
    expect(report.duplicateNodes).toBe(1);
    expect(report.unsupportedProtocols).toEqual({
      ssr: 1,
      tuic: 1,
    });
  });

  it("reports unsupported Clash/Mihomo proxy protocols", () => {
    const payload = `
proxies:
  - { name: OK, type: vless, server: ok.example.com, port: 443, uuid: uuid }
  - { name: TUIC, type: tuic, server: tuic.example.com, port: 443, password: secret }
`;

    const report = parseSubscriptionWithReport(payload);

    expect(report.nodes).toHaveLength(1);
    expect(report.totalEntries).toBe(2);
    expect(report.skippedEntries).toBe(1);
    expect(report.unsupportedProtocols).toEqual({ tuic: 1 });
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
        address: "example.com",
        port: 443,
        id: "uuid",
        encryption: "none",
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
});

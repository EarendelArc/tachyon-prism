import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  stringifyDraft,
} from "../configDrafts";
import type { GameProfile, LauncherSettings } from "../gameProfiles";
import { parseSubscription } from "../subscriptions";
import type { ProxyNode } from "../subscriptions";

const mockVMessNode: ProxyNode = {
  id: "node-00000001",
  name: "Test Node",
  protocol: "vmess",
  address: "10.0.0.1",
  port: 443,
  credential: "test-uuid",
  rawUri: "vmess://test",
  outbound: {
    protocol: "vmess",
    settings: {
      address: "10.0.0.1",
      port: 443,
      id: "test-uuid",
      security: "auto",
    },
  },
};

const mockTrojanNode: ProxyNode = {
  id: "node-00000002",
  name: "Trojan Node",
  protocol: "trojan",
  address: "trojan.example.com",
  port: 8443,
  credential: "password123",
  rawUri: "trojan://password123@trojan.example.com:8443",
  outbound: {
    protocol: "trojan",
    settings: {
      address: "trojan.example.com",
      port: 8443,
      password: "password123",
    },
    streamSettings: {
      network: "tcp",
      security: "tls",
      tlsSettings: { serverName: "trojan.example.com" },
    },
  },
};

const mockProfiles: GameProfile[] = [
  {
    id: "cs2",
    displayName: "Counter-Strike 2",
    enabled: true,
    manual: true,
    priority: 100,
    match: {
      processNames: ["cs2.exe"],
      paths: [],
      pathPrefixes: [],
      sha256: [],
      steamAppIds: [730],
    },
    udpPolicy: "tgp",
    tcpPolicy: "auto",
  },
  {
    id: "valorant",
    displayName: "Valorant",
    enabled: true,
    manual: false,
    priority: 90,
    match: {
      processNames: ["VALORANT-Win64-Shipping.exe"],
      paths: [],
      pathPrefixes: ["C:\\Riot Games\\VALORANT"],
      sha256: [],
      steamAppIds: [],
    },
    udpPolicy: "direct",
    tcpPolicy: "direct",
  },
];

const mockCoreOptions = {
  serverAddr: "game.example.com:443",
};

describe("buildXrayClientConfigDraft", () => {
  it("generates a config with socks inbound and proxy outbound", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode);
    const inbounds = config.inbounds as Array<Record<string, unknown>>;
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    expect(inbounds).toHaveLength(2);
    expect(inbounds[0].protocol).toBe("socks");
    expect(inbounds[0].port).toBe(10808);
    expect(inbounds[1]).toMatchObject({
      tag: "tachyon-http",
      protocol: "http",
      port: 10809,
    });
    expect(outbounds).toHaveLength(3);
    const tags = outbounds.map((o) => o.tag);
    expect(tags).toContain("tachyon-proxy");
    expect(tags).toContain("tachyon-direct");
    expect(tags).toContain("tachyon-block");
  });

  it("adds the tachyon-proxy tag to the node outbound", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    const proxy = outbounds.find(
      (o) => o.tag === "tachyon-proxy",
    ) as Record<string, unknown>;
    expect(proxy).toBeDefined();
    expect(proxy.protocol).toBe("vmess");
  });

  it("respects custom socks listen and port", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode, {
      httpListen: "127.0.0.3",
      httpPort: 18080,
      socksListen: "0.0.0.0",
      socksPort: 9999,
    });
    const inbounds = config.inbounds as Array<Record<string, unknown>>;
    expect(inbounds[0].listen).toBe("0.0.0.0");
    expect(inbounds[0].port).toBe(9999);
    expect(inbounds[1].listen).toBe("127.0.0.3");
    expect(inbounds[1].port).toBe(18080);
  });

  it("can enable the Xray StatsService API inbound", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode, {
      enableStats: true,
      statsListen: "127.0.0.2",
      statsPort: 10086,
    });
    const inbounds = config.inbounds as Array<Record<string, unknown>>;
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    const apiInbound = inbounds.find((inbound) => inbound.tag === "tachyon-xray-api-in");
    const api = config.api as Record<string, unknown>;
    const policy = config.policy as Record<string, unknown>;
    const routing = config.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;

    expect(apiInbound).toMatchObject({
      listen: "127.0.0.2",
      port: 10086,
      protocol: "tunnel",
    });
    expect((apiInbound?.settings as Record<string, unknown>).rewriteAddress).toBe("127.0.0.1");
    expect(outbounds.some((outbound) => outbound.tag === "tachyon-xray-api")).toBe(false);
    expect(api.services).toEqual(["StatsService"]);
    expect(config.stats).toEqual({});
    expect(policy).toBeDefined();
    expect(rules[0]).toMatchObject({
      inboundTag: ["tachyon-xray-api-in"],
      outboundTag: "tachyon-xray-api",
    });
  });

  it("uses 127.0.0.1:10808 as default socks inbound", () => {
    const config = buildXrayClientConfigDraft(mockTrojanNode);
    const inbounds = config.inbounds as Array<Record<string, unknown>>;
    expect(inbounds[0].listen).toBe("127.0.0.1");
    expect(inbounds[0].port).toBe(10808);
    const settings = inbounds[0].settings as Record<string, unknown>;
    expect(settings.udp).toBe(true);
    expect(inbounds[1].listen).toBe("127.0.0.1");
    expect(inbounds[1].port).toBe(10809);
  });

  it("uses rule routing by default", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode);
    const routing = config.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;

    expect(routing.domainStrategy).toBe("IPIfNonMatch");
    expect(rules.some((rule) => rule.outboundTag === "tachyon-direct")).toBe(true);
    expect(rules.some((rule) => rule.outboundTag === "tachyon-block")).toBe(true);
  });

  it("can force all Xray traffic through proxy or direct mode", () => {
    const globalConfig = buildXrayClientConfigDraft(mockVMessNode, {
      routingMode: "global",
    });
    const directConfig = buildXrayClientConfigDraft(mockVMessNode, {
      routingMode: "direct",
    });
    const globalRule = ((globalConfig.routing as Record<string, unknown>).rules as Array<
      Record<string, unknown>
    >)[0];
    const directRule = ((directConfig.routing as Record<string, unknown>).rules as Array<
      Record<string, unknown>
    >)[0];

    expect(globalRule.outboundTag).toBe("tachyon-proxy");
    expect(directRule.outboundTag).toBe("tachyon-direct");
    expect(globalRule.inboundTag).toEqual(["tachyon-socks", "tachyon-http"]);
    expect(directRule.inboundTag).toEqual(["tachyon-socks", "tachyon-http"]);
  });

  it("preserves parsed subscription outbound details in generated Xray configs", () => {
    const nodes = parseSubscription(
      [
        "vmess://eyJ2IjoiMiIsInBzIjoiV01lc3MgV1MiLCJhZGQiOiJ2bWVzcy5leGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6InZtZXNzLXV1aWQiLCJhaWQiOiIwIiwibmV0Ijoid3MiLCJ0eXBlIjoibm9uZSIsImhvc3QiOiJjZG4uZXhhbXBsZS5jb20iLCJwYXRoIjoiL3dzIiwidGxzIjoidGxzIn0=",
        "trojan-go://secret@trojan.example.com:443?type=ws&path=/trojan&sni=edge.example.com#TrojanGo",
        "hy2://auth@example.com:443?up=25&down=100#Hy2",
      ].join("\n"),
    );

    const [vmessConfig, trojanConfig, hysteriaConfig] = nodes.map((node) =>
      buildXrayClientConfigDraft(node),
    );
    const vmessProxy = ((vmessConfig.outbounds as Array<Record<string, unknown>>).find(
      (outbound) => outbound.tag === "tachyon-proxy",
    ) ?? {}) as Record<string, unknown>;
    const trojanProxy = ((trojanConfig.outbounds as Array<Record<string, unknown>>).find(
      (outbound) => outbound.tag === "tachyon-proxy",
    ) ?? {}) as Record<string, unknown>;
    const hysteriaProxy = ((hysteriaConfig.outbounds as Array<Record<string, unknown>>).find(
      (outbound) => outbound.tag === "tachyon-proxy",
    ) ?? {}) as Record<string, unknown>;

    expect(vmessProxy).toMatchObject({
      protocol: "vmess",
      streamSettings: {
        network: "websocket",
        security: "tls",
        wsSettings: {
          path: "/ws",
          headers: { Host: "cdn.example.com" },
        },
      },
    });
    expect(trojanProxy).toMatchObject({
      protocol: "trojan",
      streamSettings: {
        network: "websocket",
        wsSettings: { path: "/trojan" },
      },
    });
    expect(hysteriaProxy).toMatchObject({
      protocol: "hysteria",
      streamSettings: {
        network: "hysteria",
        hysteriaSettings: {
          auth: "auth",
        },
      },
    });
  });
});

describe("buildCoreClientConfigDraft", () => {
  it("generates a client-mode config with tun and routing", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      gameProfiles: mockProfiles,
    });
    expect(config.mode).toBe("client");
    const client = config.client as Record<string, unknown>;
    expect(client).toBeDefined();
    const tun = client.tun as Record<string, unknown>;
    expect(tun.address).toBe("198.18.0.1/16");
    expect(tun.mtu).toBe(9000);
    expect(tun.auto_route).toBe(false);
    expect(tun.dns_hijack).toBe(false);
  });

  it("includes game profiles in routing", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      gameProfiles: mockProfiles,
    });
    const client = config.client as Record<string, unknown>;
    const routing = client.routing as Record<string, unknown>;
    const profiles = routing.game_profiles as GameProfile[];
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).toBe("cs2");
    expect(profiles[1].id).toBe("valorant");
  });

  it("throws when Tachyon server address is missing", () => {
    expect(() =>
      buildCoreClientConfigDraft(),
    ).toThrow();
  });

  it("throws when multipath is enabled without two local bind addresses", () => {
    expect(() =>
      buildCoreClientConfigDraft({
        serverAddr: "relay.example.com:443",
        localAddrs: ["127.0.0.1:0"],
        multipath: true,
      }),
    ).toThrow(/multipath/);
  });

  it("throws when multipath is enabled without connection migration", () => {
    expect(() =>
      buildCoreClientConfigDraft({
        serverAddr: "relay.example.com:443",
        localAddrs: ["127.0.0.1:0", "127.0.0.2:0"],
        connectionMigration: false,
        multipath: true,
      }),
    ).toThrow(/connection migration/);
  });

  it("sets proxy endpoint from Tachyon server settings", () => {
    const config = buildCoreClientConfigDraft({
      serverAddr: "relay.example.com:443",
      tgpServerAddr: "game-relay.example.com:443",
      localAddrs: [" 127.0.0.1:0 ", "", "127.0.0.2:0"],
      multipath: true,
    });
    const client = config.client as Record<string, unknown>;
    const proxy = client.proxy as Record<string, unknown>;
    const tgp = config.tgp as Record<string, unknown>;
    expect(proxy.server_addr).toBe("relay.example.com:443");
    expect(proxy.tgp_server_addr).toBe("game-relay.example.com:443");
    expect(proxy.local_addrs).toEqual(["127.0.0.1:0", "127.0.0.2:0"]);
    expect(tgp.multipath).toBe(true);
  });

  it("includes LAN direct rules with default routing rules", () => {
    const config = buildCoreClientConfigDraft(mockCoreOptions);
    const client = config.client as Record<string, unknown>;
    const routing = client.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;
    expect(rules.length).toBeGreaterThanOrEqual(2);
    const cidrRule = rules.find((r) => r.cidr === "192.168.0.0/16");
    expect(cidrRule).toBeDefined();
    expect(cidrRule?.action).toBe("direct");
  });

  it("includes TGP settings", () => {
    const config = buildCoreClientConfigDraft(mockCoreOptions);
    const tgp = config.tgp as Record<string, unknown>;
    expect(tgp.fec).toMatchObject({
      data_shards: 4,
      parity_shards: 2,
      group_timeout: "20ms",
      dynamic: true,
      adapt_window: 32,
    });
    expect(tgp.pacing).toBeDefined();
    expect(tgp.connection_migration).toBe(true);
  });

  it("can disable TGP connection migration without multipath", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      connectionMigration: false,
    });
    const tgp = config.tgp as Record<string, unknown>;
    expect(tgp.connection_migration).toBe(false);
    expect(tgp.multipath).toBe(false);
  });

  it("includes IPC settings", () => {
    const config = buildCoreClientConfigDraft(mockCoreOptions);
    const ipc = config.ipc as Record<string, unknown>;
    expect(ipc.websocket_addr).toBe("127.0.0.1:55123");
    expect(ipc.grpc_addr).toBe("127.0.0.1:50051");
  });

  it("respects runtime networking options", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      grpcListen: "127.0.0.5",
      grpcPort: 50052,
      ipcListen: "127.0.0.6",
      ipcPort: 55124,
      fecAdaptWindow: 48,
      fecDataShards: 6,
      fecDynamic: false,
      fecGroupTimeoutMs: 35,
      fecParityShards: 3,
      telemetryIntervalMs: 250,
      tunAddress: "198.19.0.1/16",
      tunAutoRoute: true,
      tunDnsHijack: true,
      tunMtu: 8500,
    });
    const client = config.client as Record<string, unknown>;
    const tun = client.tun as Record<string, unknown>;
    const ipc = config.ipc as Record<string, unknown>;
    const tgp = config.tgp as Record<string, unknown>;
    const fec = tgp.fec as Record<string, unknown>;

    expect(tun.address).toBe("198.19.0.1/16");
    expect(tun.auto_route).toBe(true);
    expect(tun.dns_hijack).toBe(true);
    expect(tun.mtu).toBe(8500);
    expect(ipc.websocket_addr).toBe("127.0.0.6:55124");
    expect(ipc.grpc_addr).toBe("127.0.0.5:50052");
    expect(ipc.telemetry_interval_ms).toBe(250);
    expect(fec).toMatchObject({
      data_shards: 6,
      parity_shards: 3,
      group_timeout: "35ms",
      dynamic: false,
      adapt_window: 48,
    });
  });

  it("uses default launcher settings when not provided", () => {
    const config = buildCoreClientConfigDraft(mockCoreOptions);
    const client = config.client as Record<string, unknown>;
    const routing = client.routing as Record<string, unknown>;
    const launchers = routing.launchers as LauncherSettings;
    expect(launchers.steam.enabled).toBe(true);
    expect(launchers.steam.trackChildProcesses).toBe(true);
  });

  const coreBinaryPath = process.env.TACHYON_CORE_BINARY_PATH?.trim();
  const itWithCore = coreBinaryPath ? it : it.skip;

  itWithCore("generates config accepted by the Tachyon Core binary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-core-contract-"));
    const configPath = join(tempDir, "client.json");
    try {
      writeFileSync(
        configPath,
        stringifyDraft(
          buildCoreClientConfigDraft({
            ...mockCoreOptions,
            gameProfiles: mockProfiles,
          }),
        ),
        "utf8",
      );
      const output = execFileSync(coreBinaryPath ?? "", ["validate", "--config", configPath], {
        encoding: "utf8",
        timeout: 8000,
      });
      expect(output).toContain("is valid");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("stringifyDraft", () => {
  it("produces indented JSON", () => {
    const result = stringifyDraft({ a: 1, b: "test" });
    expect(result).toBe('{\n  "a": 1,\n  "b": "test"\n}');
  });

  it("handles arrays and nested objects", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode);
    const json = stringifyDraft(config);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.inbounds).toBeDefined();
    expect(parsed.outbounds).toBeDefined();
  });
});

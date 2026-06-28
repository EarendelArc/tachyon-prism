import { describe, expect, it } from "vitest";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  stringifyDraft,
} from "../configDrafts";
import type { GameProfile, LauncherSettings } from "../gameProfiles";
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
      vnext: [
        {
          address: "10.0.0.1",
          port: 443,
          users: [{ id: "test-uuid", security: "auto" }],
        },
      ],
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
      servers: [
        {
          address: "trojan.example.com",
          port: 8443,
          password: "password123",
        },
      ],
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

describe("buildXrayClientConfigDraft", () => {
  it("generates a config with socks inbound and proxy outbound", () => {
    const config = buildXrayClientConfigDraft(mockVMessNode);
    const inbounds = config.inbounds as Array<Record<string, unknown>>;
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].protocol).toBe("socks");
    expect(inbounds[0].port).toBe(10808);
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
      socksListen: "0.0.0.0",
      socksPort: 9999,
    });
    const inbounds = config.inbounds as Array<Record<string, unknown>>;
    expect(inbounds[0].listen).toBe("0.0.0.0");
    expect(inbounds[0].port).toBe(9999);
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
    const apiOutbound = outbounds.find((outbound) => outbound.tag === "tachyon-xray-api");
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
    expect(apiOutbound).toMatchObject({ protocol: "freedom" });
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
  });
});

describe("buildCoreClientConfigDraft", () => {
  it("generates a client-mode config with tun and routing", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode, {
      gameProfiles: mockProfiles,
    });
    expect(config.mode).toBe("client");
    const client = config.client as Record<string, unknown>;
    expect(client).toBeDefined();
    const tun = client.tun as Record<string, unknown>;
    expect(tun.address).toBe("198.18.0.1/16");
    expect(tun.mtu).toBe(9000);
  });

  it("includes game profiles in routing", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode, {
      gameProfiles: mockProfiles,
    });
    const client = config.client as Record<string, unknown>;
    const routing = client.routing as Record<string, unknown>;
    const profiles = routing.game_profiles as GameProfile[];
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).toBe("cs2");
    expect(profiles[1].id).toBe("valorant");
  });

  it("throws when node has no port", () => {
    expect(() =>
      buildCoreClientConfigDraft({
        ...mockVMessNode,
        port: 0,
      }),
    ).toThrow();
  });

  it("sets proxy endpoint from node address:port", () => {
    const config = buildCoreClientConfigDraft(mockTrojanNode);
    const client = config.client as Record<string, unknown>;
    const proxy = client.proxy as Record<string, unknown>;
    expect(proxy.server_addr).toBe("trojan.example.com:8443");
  });

  it("includes LAN direct rules with default routing rules", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode);
    const client = config.client as Record<string, unknown>;
    const routing = client.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;
    expect(rules.length).toBeGreaterThanOrEqual(2);
    const cidrRule = rules.find((r) => r.cidr === "192.168.0.0/16");
    expect(cidrRule).toBeDefined();
    expect(cidrRule?.action).toBe("direct");
  });

  it("includes TGP settings", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode);
    const tgp = config.tgp as Record<string, unknown>;
    expect(tgp.fec).toBeDefined();
    expect(tgp.pacing).toBeDefined();
    expect(tgp.connection_migration).toBe(true);
  });

  it("includes IPC settings", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode);
    const ipc = config.ipc as Record<string, unknown>;
    expect(ipc.websocket_addr).toBe("127.0.0.1:55123");
    expect(ipc.grpc_addr).toBe("127.0.0.1:50051");
  });

  it("respects runtime networking options", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode, {
      grpcListen: "127.0.0.5",
      grpcPort: 50052,
      ipcListen: "127.0.0.6",
      ipcPort: 55124,
      telemetryIntervalMs: 250,
      tunAddress: "198.19.0.1/16",
      tunMtu: 8500,
    });
    const client = config.client as Record<string, unknown>;
    const tun = client.tun as Record<string, unknown>;
    const ipc = config.ipc as Record<string, unknown>;

    expect(tun.address).toBe("198.19.0.1/16");
    expect(tun.mtu).toBe(8500);
    expect(ipc.websocket_addr).toBe("127.0.0.6:55124");
    expect(ipc.grpc_addr).toBe("127.0.0.5:50052");
    expect(ipc.telemetry_interval_ms).toBe(250);
  });

  it("uses default launcher settings when not provided", () => {
    const config = buildCoreClientConfigDraft(mockVMessNode);
    const client = config.client as Record<string, unknown>;
    const routing = client.routing as Record<string, unknown>;
    const launchers = routing.launchers as LauncherSettings;
    expect(launchers.steam.enabled).toBe(true);
    expect(launchers.steam.trackChildProcesses).toBe(true);
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

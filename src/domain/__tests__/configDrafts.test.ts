import { describe, expect, it } from "vitest";
import { assertSensitiveContains, assertSensitiveEqual } from "./sensitiveAssertions";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  CoreClientConfigError,
  initializeAdvancedXrayDraftText,
  managedTagMatches,
  parseXrayConfigText,
  stringifyDraft,
} from "../configDrafts";
import type { GameProfile, LauncherSettings } from "../gameProfiles";
import {
  buildXrayOutboundDraft,
  createSubscriptionSnapshot,
  parseSubscription,
  selectSubscriptionNode,
} from "../subscriptions";
import type { ProxyNode } from "../subscriptions";
import {
  singBoxTuicJsonFixture,
  subscriptionCompatibilityFixtures,
  xrayAdvancedRoundTripJsonFixture,
  xrayFullConfigJsonFixture,
  xrayManagedReferenceGraphJsonFixture,
  xrayReversePortalJsonFixture,
} from "./subscriptionFixtures";

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

  it("uses only remote outbounds while regenerating every managed control", () => {
    const nodes = parseSubscription(xrayFullConfigJsonFixture);
    const snapshot = createSubscriptionSnapshot("https://example.com/full-xray", nodes);
    const selected = selectSubscriptionNode(snapshot, nodes[1].id);
    const node = selected.nodes.find((item) => item.id === selected.selectedNodeId)!;
    const config = buildXrayClientConfigDraft(node, { routingMode: "global" });
    const generatedInbounds = config.inbounds as Array<Record<string, unknown>>;
    const generatedOutbounds = config.outbounds as Array<Record<string, unknown>>;

    expect(nodes).toHaveLength(2);
    expect(node.xrayConfigId).toMatch(/^xray-config-/);
    expect(node).not.toHaveProperty("xrayConfig");
    expect(Object.keys(config).sort()).toEqual(["inbounds", "log", "outbounds", "routing"]);
    expect(config.log).toEqual({ loglevel: "warning" });
    expect(generatedInbounds).toHaveLength(2);
    expect(generatedInbounds.map((inbound) => inbound.protocol)).toEqual(["socks", "http"]);
    expect(config.outbounds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "tachyon-proxy",
          protocol: "vmess",
          streamSettings: expect.objectContaining({
            network: "xhttp",
            xhttpSettings: {
              path: "/xhttp",
              mode: "auto",
              extra: { xPaddingBytes: "100-1000" },
            },
          }),
        }),
        expect.objectContaining({
          tag: "Xray Full Trojan TLS",
          userOutboundField: { retained: true },
        }),
        expect.objectContaining({
          tag: "tachyon-proxy",
        }),
      ]),
    );
    const generatedRouting = config.routing as Record<string, unknown>;
    const rules = generatedRouting.rules as Array<Record<string, unknown>>;
    expect(Object.keys(generatedRouting).sort()).toEqual(["domainStrategy", "rules"]);
    expect(rules[0]).toEqual({
      type: "field",
      network: "tcp,udp",
      outboundTag: "tachyon-proxy",
    });
    const inboundTags = new Set(generatedInbounds.map((item) => item.tag));
    const outboundTags = new Set(generatedOutbounds.map((item) => item.tag));
    for (const rule of rules) {
      for (const inboundTag of (rule.inboundTag as string[] | undefined) ?? []) {
        expect(inboundTags.has(inboundTag)).toBe(true);
      }
      if (typeof rule.outboundTag === "string") {
        expect(outboundTags.has(rule.outboundTag)).toBe(true);
      }
    }
  });

  it("generates Prism-owned stats wiring without importing remote controls", () => {
    const [node] = parseSubscription(xrayFullConfigJsonFixture);
    const config = buildXrayClientConfigDraft(node, { enableStats: true });
    const api = config.api as Record<string, unknown>;
    const policy = config.policy as Record<string, unknown>;
    const system = policy.system as Record<string, unknown>;
    const routing = config.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;

    expect(api).toEqual({
      tag: "tachyon-xray-api",
      services: ["StatsService"],
    });
    expect(Object.keys(policy)).toEqual(["system"]);
    expect(system).toEqual({
      statsInboundDownlink: true,
      statsInboundUplink: true,
      statsOutboundDownlink: true,
      statsOutboundUplink: true,
    });
    expect(config.stats).toEqual({});
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inboundTag: ["tachyon-xray-api-in"],
          outboundTag: "tachyon-xray-api",
        }),
      ]),
    );
    expect(
      (config.outbounds as Array<Record<string, unknown>>).some(
        (outbound) => outbound.tag === "tachyon-xray-api",
      ),
    ).toBe(false);
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
    expect(globalRule.network).toBe("tcp,udp");
    expect(directRule.network).toBe("tcp,udp");
    expect(globalRule).not.toHaveProperty("inboundTag");
    expect(directRule).not.toHaveProperty("inboundTag");
  });

  it("routes unmatched managed traffic to the selected B node regardless of outbound order", () => {
    const sourceOutbounds = [
      {
        tag: "node-a",
        protocol: "vmess",
        settings: { address: "a.example.com", port: 443, id: "node-a-id" },
      },
      {
        tag: "node-b",
        protocol: "vmess",
        settings: { address: "b.example.com", port: 443, id: "node-b-id" },
      },
    ];
    const build = (outbounds: Array<Record<string, unknown>>) => {
      const nodes = parseSubscription(JSON.stringify({ outbounds }));
      const nodeB = nodes.find((node) => node.name === "node-b")!;
      const config = buildXrayClientConfigDraft(nodeB, { routingMode: "rule" });
      const rules = (config.routing as Record<string, unknown>).rules as Array<
        Record<string, unknown>
      >;
      const fallbackTag = rules[rules.length - 1]?.outboundTag;
      const fallback = (config.outbounds as Array<Record<string, unknown>>).find(
        (outbound) => outbound.tag === fallbackTag,
      )!;
      return { fallback, fallbackTag, rules };
    };

    const ordered = build(sourceOutbounds);
    const reversed = build([...sourceOutbounds].reverse());

    expect(ordered.fallbackTag).toBe("node-b");
    expect(reversed.fallbackTag).toBe("node-b");
    expect(ordered.fallback.settings).toMatchObject({ address: "b.example.com" });
    expect(reversed.fallback.settings).toMatchObject({ address: "b.example.com" });
    expect(ordered.rules[ordered.rules.length - 1]).toEqual({
      type: "field",
      network: "tcp,udp",
      outboundTag: "node-b",
    });
  });

  it.each([
    ["global", "vmess"],
    ["rule", "vmess"],
    ["direct", "freedom"],
  ] as const)("uses an explicit final target in %s mode", (routingMode, protocol) => {
    const config = buildXrayClientConfigDraft(mockVMessNode, { routingMode });
    const rules = (config.routing as Record<string, unknown>).rules as Array<
      Record<string, unknown>
    >;
    const targetTag =
      routingMode === "rule"
        ? rules[rules.length - 1]?.outboundTag
        : rules[0].outboundTag;
    const target = (config.outbounds as Array<Record<string, unknown>>).find(
      (outbound) => outbound.tag === targetTag,
    );

    expect(typeof targetTag).toBe("string");
    expect(target?.protocol).toBe(protocol);
  });

  it("isolates managed proxy, direct, and block tags from imported tag conflicts", () => {
    const nodes = parseSubscription(
      JSON.stringify({
        outbounds: [
          {
            tag: "tachyon-proxy",
            protocol: "vmess",
            settings: { address: "a.example.com", port: 443, id: "a" },
          },
          {
            tag: "tachyon-direct",
            protocol: "vmess",
            settings: { address: "b.example.com", port: 443, id: "b" },
          },
          { tag: "tachyon-block", protocol: "blackhole" },
        ],
      }),
    );
    const selected = nodes.find((node) => node.name === "tachyon-direct")!;
    const config = buildXrayClientConfigDraft(selected, { routingMode: "rule" });
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    const tags = outbounds.map((outbound) => outbound.tag);
    const rules = (config.routing as Record<string, unknown>).rules as Array<
      Record<string, unknown>
    >;
    const fallbackTag = rules[rules.length - 1]?.outboundTag;
    const fallback = outbounds.find((outbound) => outbound.tag === fallbackTag)!;

    expect(new Set(tags).size).toBe(tags.length);
    expect(fallbackTag).toBe("tachyon-proxy-2");
    expect(fallback.settings).toMatchObject({ address: "b.example.com" });
    expect(rules.some((rule) => rule.outboundTag === "tachyon-direct")).toBe(true);
    expect(rules.some((rule) => rule.outboundTag === "tachyon-block-2")).toBe(true);
  });

  it("preserves a non-conflicting imported outbound tag as the managed fallback", () => {
    const [selected] = parseSubscription(xrayFullConfigJsonFixture);
    const config = buildXrayClientConfigDraft(selected, { routingMode: "rule" });
    const rules = (config.routing as Record<string, unknown>).rules as Array<
      Record<string, unknown>
    >;
    const fallbackTag = rules[rules.length - 1].outboundTag;

    expect(fallbackTag).toBe("Xray Full Trojan TLS");
    expect(config.outbounds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "Xray Full Trojan TLS",
          userOutboundField: { retained: true },
        }),
      ]),
    );
  });

  it("rewrites only outbound-local managed references without importing control graphs", () => {
    const [selected] = parseSubscription(xrayManagedReferenceGraphJsonFixture);
    const config = buildXrayClientConfigDraft(selected, { routingMode: "rule" });
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    const routing = config.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;
    const selectedOutbound = outbounds.find((outbound) => outbound.tag === "tachyon-proxy");
    const chainOutbound = outbounds.find((outbound) => outbound.tag === "chain-hop")!;
    const dialOutbound = outbounds.find((outbound) => outbound.tag === "dial-hop")!;

    expect(selectedOutbound).toMatchObject({
      protocol: "vmess",
      userSelectedField: { retained: true },
    });
    expect(Object.keys(routing).sort()).toEqual(["domainStrategy", "rules"]);
    expect(
      rules.some(
        (rule) =>
          Array.isArray(rule.domain) &&
          rule.domain.includes("full:managed-reference.example"),
      ),
    ).toBe(false);
    expect(config).not.toHaveProperty("observatory");
    expect(config).not.toHaveProperty("burstObservatory");
    expect(chainOutbound.proxySettings).toMatchObject({ tag: "tachyon-proxy" });
    expect(
      ((dialOutbound.streamSettings as Record<string, unknown>).sockopt as Record<
        string,
        unknown
      >).dialerProxy,
    ).toBe("tachyon-proxy");
    expect(outbounds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "tachyon-direct", protocol: "freedom" }),
      ]),
    );
  });

  it("preserves reverse locally in Raw mode but excludes it from remote Managed mode", () => {
    const source = JSON.parse(xrayReversePortalJsonFixture) as Record<string, unknown>;
    const raw = parseXrayConfigText(xrayReversePortalJsonFixture);
    const rawDraft = buildXrayClientConfigDraft(undefined, {
      configMode: "raw",
      rawConfig: raw,
    });
    const [selected] = parseSubscription(xrayReversePortalJsonFixture);
    const managed = buildXrayClientConfigDraft(selected, { routingMode: "rule" });
    const managedRules = (managed.routing as Record<string, unknown>).rules as Array<
      Record<string, unknown>
    >;
    const importedTargets = managedRules
      .filter(
        (rule) =>
          Array.isArray(rule.domain) &&
          rule.domain.some(
            (domain) =>
              domain === "full:reverse.example.test" ||
              domain === "full:dynamic.example.test",
          ),
      )
      .map((rule) => rule.outboundTag);

    expect(rawDraft).not.toBe(source);
    expect(rawDraft).toHaveProperty("reverse");
    expect(rawDraft).toHaveProperty("routing");
    expect(managed).not.toHaveProperty("reverse");
    expect(importedTargets).toHaveLength(0);
    expect(managed.outbounds).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "reverse-portal" }),
        expect.objectContaining({ tag: "runtime-registered-handler" }),
      ]),
    );
    expect(managedRules[managedRules.length - 1].outboundTag).toBe(
      "selected-static-proxy",
    );
  });

  it("ignores remote selector controls while preserving supported outbounds", () => {
    const [selected] = parseSubscription(
      JSON.stringify({
        outbounds: [
          {
            tag: "tachyon-direct",
            protocol: "vmess",
            settings: { address: "selected.example.com", port: 443, id: "selected" },
          },
          {
            tag: "tachyon-direct-backup",
            protocol: "freedom",
          },
        ],
        routing: {
          balancers: [
            {
              tag: "broad-prefix",
              selector: ["tachyon-direct"],
            },
          ],
        },
      }),
    );

    const config = buildXrayClientConfigDraft(selected);
    const routing = config.routing as Record<string, unknown>;

    expect(config).not.toHaveProperty("observatory");
    expect(routing).not.toHaveProperty("balancers");
    expect((config.outbounds as unknown[])).toHaveLength(4);
  });

  it("preserves a raw complete config without applying node or routing selections", () => {
    const raw = parseXrayConfigText(
      JSON.stringify({
        log: { loglevel: "debug" },
        outbounds: [
          {
            tag: "tachyon-proxy",
            protocol: "freedom",
            settings: { domainStrategy: "UseIPv6" },
          },
          { tag: "tachyon-direct", protocol: "blackhole" },
        ],
        routing: {
          domainStrategy: "AsIs",
          rules: [
            {
              type: "field",
              domain: ["example.test"],
              outboundTag: "tachyon-direct",
              balancerTag: "raw-balancer",
            },
          ],
          balancers: [
            {
              tag: "raw-balancer",
              selector: ["tachyon-"],
            },
          ],
        },
        observatory: { subjectSelector: ["tachyon-"] },
      }),
    );

    const config = buildXrayClientConfigDraft(undefined, {
      configMode: "raw",
      rawConfig: raw,
      routingMode: "global",
    });

    assertSensitiveEqual(config, raw);
    expect(config).not.toBe(raw);
    expect(config).toHaveProperty("outbounds.0.tag", "tachyon-proxy");
    expect(config).toHaveProperty("outbounds.1.tag", "tachyon-direct");
  });

  it("preserves parsed subscription outbound details in generated Xray configs", () => {
    const nodes = parseSubscription(
      [
        "vmess://eyJ2IjoiMiIsInBzIjoiV01lc3MgV1MiLCJhZGQiOiJ2bWVzcy5leGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6InZtZXNzLXV1aWQiLCJhaWQiOiIwIiwibmV0Ijoid3MiLCJ0eXBlIjoibm9uZSIsImhvc3QiOiJjZG4uZXhhbXBsZS5jb20iLCJwYXRoIjoiL3dzIiwidGxzIjoidGxzIn0=",
        "trojan-go://secret@trojan.example.com:443?type=ws&path=/trojan&sni=edge.example.com#TrojanGo",
        "hy2://auth@example.com:443?security=tls&sni=hy2.example.com&up=25&down=100#Hy2",
        "tuic://uuid:secret@tuic.example.com:443?sni=edge.example.com&congestion=bbr#Tuic",
      ].join("\n"),
    );

    const [vmessConfig, trojanConfig, hysteriaConfig] = nodes.slice(0, 3).map((node) =>
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
    const tuicNode = nodes[3];

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
    assertSensitiveContains(hysteriaProxy, {
      protocol: "hysteria",
      streamSettings: {
        network: "hysteria",
        hysteriaSettings: {
          auth: "auth",
        },
      },
    });
    assertSensitiveContains(tuicNode.outbound, {
      protocol: "tuic",
      settings: {
        address: "tuic.example.com",
        port: 443,
        uuid: "uuid",
        password: "secret",
        congestion: "bbr",
      },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
        },
      },
    });
    expect(() => buildXrayClientConfigDraft(tuicNode)).toThrow(/unsupported-by-xray/);
  });

  it.each(subscriptionCompatibilityFixtures)(
    "generates an Xray client draft for compatibility fixture: $id",
    ({ id, payload, outboundMatch, xrayCompatibilityStatus = "supported" }) => {
      const [node] = parseSubscription(payload);
      if (xrayCompatibilityStatus !== "supported") {
        expect(() => buildXrayClientConfigDraft(node)).toThrow(/unsupported-by-xray/);
        return;
      }

      const nodeBeforeBuild = structuredClone(node);
      const outboundBeforeBuild = buildXrayOutboundDraft(node);
      const config = buildXrayClientConfigDraft(node);
      const outbounds = config.outbounds as Array<Record<string, unknown>>;
      const rules = (config.routing as Record<string, unknown>).rules as Array<
        Record<string, unknown>
      >;
      const selectedTag = rules[rules.length - 1]?.outboundTag;
      const proxy = outbounds.find(
        (outbound) => outbound.tag === selectedTag,
      ) as Record<string, unknown> | undefined;
      const { tag: originalTag, ...originalSemantics } = outboundBeforeBuild;
      const { tag: managedTag, ...managedSemantics } = proxy ?? {};
      const persisted = createSubscriptionSnapshot(
        `https://example.com/compatibility/${id}`,
        [node],
      );
      const restored = selectSubscriptionNode(persisted, node.id);

      if (typeof originalTag === "string" && originalTag) {
        expect(selectedTag).toBe(originalTag);
      } else {
        expect(selectedTag).toMatch(/^tachyon-proxy(?:-[2-9]|-[1-9]\d+)?$/);
      }
      assertSensitiveContains(proxy, {
        ...outboundMatch,
        tag: selectedTag,
      });
      expect(managedTag).toBe(selectedTag);
      assertSensitiveEqual(managedSemantics, originalSemantics);
      assertSensitiveEqual(node, nodeBeforeBuild);
      assertSensitiveEqual(buildXrayOutboundDraft(node), {
        ...outboundBeforeBuild,
        ...(originalTag ? { tag: originalTag } : {}),
      });
      expect(restored.selectedNodeId).toBe(node.id);
      assertSensitiveContains(restored.nodes[0], {
        id: nodeBeforeBuild.id,
        rawUri: nodeBeforeBuild.rawUri,
        xrayConfigId: nodeBeforeBuild.xrayConfigId,
        xrayOutboundIndex: nodeBeforeBuild.xrayOutboundIndex,
      });
      expect(outbounds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tag: "tachyon-direct", protocol: "freedom" }),
          expect.objectContaining({ tag: "tachyon-block", protocol: "blackhole" }),
        ]),
      );
    },
  );

  it("does not generate an active Xray outbound for unsupported retained nodes", () => {
    const [node] = parseSubscription(
      "tuic://uuid:secret@tuic.example.com:443?sni=edge.example.com#TUIC",
    );

    expect(node.outbound?.protocol).toBe("tuic");
    expect(() => buildXrayClientConfigDraft(node)).toThrow(
      /Official Xray outbound protocols do not include TUIC/,
    );
  });

  it("blocks sing-box TUIC nodes before generating an active Xray outbound", () => {
    const [node] = parseSubscription(singBoxTuicJsonFixture);
    let generatedOutbounds: Array<Record<string, unknown>> | undefined;

    expect(node).toMatchObject({
      name: "sing-box TUIC",
      protocol: "tuic",
      address: "sing-tuic.example.com",
      port: 443,
      xrayCompatibility: {
        status: "unsupported-by-xray",
      },
    });
    expect(node.outbound).toMatchObject({ protocol: "tuic" });
    expect(() => {
      const draft = buildXrayClientConfigDraft(node);
      generatedOutbounds = draft.outbounds as Array<Record<string, unknown>>;
    }).toThrow(/unsupported-by-xray/);
    expect(generatedOutbounds).toBeUndefined();
  });

  it("follows Xray Reality and Hysteria stream compatibility rules", () => {
    const [rawReality, xhttpReality, grpcReality, wsReality, hysteriaNoTls] = parseSubscription(
      [
        "vless://uuid@example.com:443?type=tcp&security=reality&sni=www.example.com&pbk=public-key#Reality Raw",
        "vless://uuid@example.com:443?type=splithttp&security=reality&sni=www.example.com&pbk=public-key&path=/xhttp&mode=auto#Reality XHTTP",
        "vless://uuid@example.com:443?type=grpc&security=reality&sni=www.example.com&pbk=public-key&serviceName=tunnel#Reality gRPC",
        "vless://uuid@example.com:443?type=ws&security=reality&sni=www.example.com&pbk=public-key#Reality WS",
        "hysteria2://secret@example.com:443?sni=game.example.com#Hysteria No TLS",
      ].join("\n"),
    );

    expect(buildXrayClientConfigDraft(rawReality)).toMatchObject({
      outbounds: expect.arrayContaining([
        expect.objectContaining({
          tag: "tachyon-proxy",
          protocol: "vless",
          streamSettings: expect.objectContaining({
            network: "raw",
            security: "reality",
          }),
        }),
      ]),
    });
    expect(buildXrayClientConfigDraft(xhttpReality)).toMatchObject({
      outbounds: expect.arrayContaining([
        expect.objectContaining({
          tag: "tachyon-proxy",
          streamSettings: expect.objectContaining({
            network: "xhttp",
            security: "reality",
          }),
        }),
      ]),
    });
    expect(buildXrayClientConfigDraft(grpcReality)).toMatchObject({
      outbounds: expect.arrayContaining([
        expect.objectContaining({
          tag: "tachyon-proxy",
          streamSettings: expect.objectContaining({
            network: "grpc",
            security: "reality",
          }),
        }),
      ]),
    });
    expect(() => buildXrayClientConfigDraft(wsReality)).toThrow(/REALITY only works/);
    expect(() => buildXrayClientConfigDraft(hysteriaNoTls)).toThrow(/Hysteria outbounds require TLS/);
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
    expect(tun.mtu).toBe(1280);
    expect(tun.auto_route).toBe(false);
    expect(tun.dns_hijack).toBe(false);
    expect(tun.tgp_only).toBe(true);
    expect(tun.game_routes).toEqual([]);
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
    expect(rules).toHaveLength(1);
    const cidrRule = rules.find((r) => r.cidr === "192.168.0.0/16");
    expect(cidrRule).toBeDefined();
    expect(cidrRule?.action).toBe("direct");
    expect(rules.some((rule) => "domain" in rule || "geoip" in rule)).toBe(false);
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
    expect(tgp.max_datagram_size).toBe(1352);
  });

  it("includes TGP PSK authentication when configured", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      tgpAuthPsk: " 0123456789abcdef ",
    });
    const tgp = config.tgp as Record<string, unknown>;
    assertSensitiveEqual(tgp.auth, { psk: "0123456789abcdef" });
  });

  it("omits TGP PSK authentication when the value is empty", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      tgpAuthPsk: "   ",
    });
    const tgp = config.tgp as Record<string, unknown>;
    expect(tgp.auth).toBeUndefined();
  });

  it("rejects short TGP PSK values", () => {
    expect(() =>
      buildCoreClientConfigDraft({
        ...mockCoreOptions,
        tgpAuthPsk: "too-short",
      }),
    ).toThrow(/PSK/);
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

  it("respects runtime networking options while forcing TUN route and DNS hijack off", () => {
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
      tunMtu: 1200,
    });
    const client = config.client as Record<string, unknown>;
    const tun = client.tun as Record<string, unknown>;
    const ipc = config.ipc as Record<string, unknown>;
    const tgp = config.tgp as Record<string, unknown>;
    const fec = tgp.fec as Record<string, unknown>;

    expect(tun.address).toBe("198.19.0.1/16");
    // Alpha builds must not enable OS-affecting TUN routing, even if a caller passes true.
    expect(tun.auto_route).toBe(false);
    expect(tun.dns_hijack).toBe(false);
    expect(tun.mtu).toBe(1200);
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

  it("includes validated game server routes in the TUN allow-list", () => {
    const config = buildCoreClientConfigDraft({
      ...mockCoreOptions,
      gameRoutes: [" 203.0.113.0/24 ", "2001:DB8::/48"],
    });
    const client = config.client as Record<string, unknown>;
    const tun = client.tun as Record<string, unknown>;
    expect(tun.game_routes).toEqual(["203.0.113.0/24", "2001:db8::/48"]);
  });

  it("rejects a TUN MTU that exceeds the fixed datagram budget", () => {
    try {
      buildCoreClientConfigDraft({ ...mockCoreOptions, tunMtu: 1285 });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreClientConfigError);
      expect(error).toMatchObject({ code: "tun-mtu-unsafe", mtu: 1285 });
    }
  });

  it("uses default launcher settings when not provided", () => {
    const config = buildCoreClientConfigDraft(mockCoreOptions);
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

describe("complete Xray JSON editing", () => {
  describe("canonical Xray draft initialization", () => {
    it("preserves an enabled empty persisted draft while canonical loading fails", () => {
      expect(
        initializeAdvancedXrayDraftText({
          canonicalText: "",
          enabled: true,
          generatedText: '{"outbounds":[{"tag":"subscription-node"}]}',
          loadState: "error",
          persistedText: "",
        }),
      ).toBe("");
    });

    it("initializes from generated JSON only after canonical absence is confirmed", () => {
      const generatedText = '{"outbounds":[{"tag":"subscription-node"}]}';
      const input = {
        canonicalText: "",
        enabled: true,
        generatedText,
        persistedText: "",
      } as const;

      expect(initializeAdvancedXrayDraftText({ ...input, loadState: "loading" })).toBe("");
      expect(initializeAdvancedXrayDraftText({ ...input, loadState: "loaded" })).toBe(
        generatedText,
      );
    });

    it("initializes from an existing canonical config before generated JSON", () => {
      const canonicalText = '{"outbounds":[{"tag":"last-valid"}]}';

      expect(
        initializeAdvancedXrayDraftText({
          canonicalText,
          enabled: true,
          generatedText: '{"outbounds":[{"tag":"subscription-node"}]}',
          loadState: "loaded",
          persistedText: "",
        }),
      ).toBe(canonicalText);
    });

    it("does not replace a persisted advanced draft when subscriptions refresh", () => {
      const persistedText = '{"outbounds":[{"tag":"manual-advanced"}]}';
      const beforeRefresh = initializeAdvancedXrayDraftText({
        canonicalText: '{"outbounds":[{"tag":"last-valid"}]}',
        enabled: true,
        generatedText: '{"outbounds":[{"tag":"subscription-a"}]}',
        loadState: "loaded",
        persistedText,
      });
      const afterRefresh = initializeAdvancedXrayDraftText({
        canonicalText: '{"outbounds":[{"tag":"last-valid"}]}',
        enabled: true,
        generatedText: '{"outbounds":[{"tag":"subscription-b"}]}',
        loadState: "loaded",
        persistedText: beforeRefresh,
      });

      expect(afterRefresh).toBe(persistedText);
    });
  });

  it("round-trips the complete fixture without dropping known or future fields", () => {
    const parsed = parseXrayConfigText(xrayAdvancedRoundTripJsonFixture);

    assertSensitiveEqual(parsed, JSON.parse(xrayAdvancedRoundTripJsonFixture));
    expect((parsed.inbounds as unknown[])).toHaveLength(2);
    expect((parsed.outbounds as unknown[])).toHaveLength(2);
    expect(parsed).toMatchObject({
      api: expect.any(Object),
      burstObservatory: expect.any(Object),
      dns: expect.any(Object),
      fakedns: expect.any(Array),
      futureXrayField: {
        enabled: true,
        nested: [{ untouched: "round-trip" }],
      },
      metrics: expect.any(Object),
      observatory: expect.any(Object),
      policy: expect.any(Object),
      reverse: expect.any(Object),
      routing: expect.any(Object),
      stats: expect.any(Object),
    });
  });

  it("reports invalid JSON and object structure in English and Chinese", () => {
    expect(() => parseXrayConfigText('{"inbounds": [}', "en")).toThrow(
      /Xray JSON syntax error/,
    );
    expect(() => parseXrayConfigText("[]", "zh-CN")).toThrow(
      "Xray JSON 顶层必须是对象",
    );
    expect(() => parseXrayConfigText('{"outbounds": {}}', "en")).toThrow(
      "Xray JSON field must be an array: outbounds",
    );
  });

  it("does not reserve Prism-like tags while parsing a raw complete config", () => {
    const raw = {
      inbounds: [{ tag: "tachyon-proxy", protocol: "future-inbound" }],
      outbounds: [
        { tag: "tachyon-direct", protocol: "future-outbound" },
        { tag: "tachyon-block-10", protocol: "blackhole" },
      ],
    };

    assertSensitiveEqual(parseXrayConfigText(JSON.stringify(raw), "en"), raw);
    assertSensitiveEqual(parseXrayConfigText(JSON.stringify(raw), "zh-CN"), raw);
  });

  it("defers imported handler and balancer existence checks to Xray run -test", () => {
    const config = {
      outbounds: [
        {
          tag: "existing",
          protocol: "freedom",
          proxySettings: { tag: "runtime-chain-handler" },
          streamSettings: { sockopt: { dialerProxy: "runtime-dialer-handler" } },
        },
      ],
      routing: {
        balancers: [
          {
            tag: "known-balancer",
            selector: ["runtime-"],
            fallbackTag: "runtime-fallback-handler",
          },
        ],
        rules: [
          { type: "field", outboundTag: "runtime-rule-handler" },
          { type: "field", balancerTag: "runtime-balancer" },
        ],
      },
    };

    assertSensitiveEqual(parseXrayConfigText(JSON.stringify(config)), config);
  });

  it("accepts declared balancer references and Xray's outboundTag precedence", () => {
    const valid = {
      outbounds: [{ tag: "existing", protocol: "freedom" }],
      routing: {
        balancers: [{ tag: "available-balancer", selector: ["existing"] }],
        rules: [{ type: "field", balancerTag: "available-balancer" }],
      },
    };

    assertSensitiveEqual(parseXrayConfigText(JSON.stringify(valid)), valid);
    const dualTarget = {
      ...valid,
      routing: {
        ...valid.routing,
        rules: [
          {
            type: "field",
            outboundTag: "existing",
            balancerTag: "available-balancer",
          },
        ],
      },
    };
    assertSensitiveEqual(parseXrayConfigText(JSON.stringify(dualTarget)), dualTarget);
  });

  it("matches only exact managed tags or canonical numeric suffixes", () => {
    expect(managedTagMatches("tachyon-proxy", "tachyon-proxy")).toBe(true);
    expect(managedTagMatches("tachyon-proxy-2", "tachyon-proxy")).toBe(true);
    expect(managedTagMatches("tachyon-proxy-10", "tachyon-proxy")).toBe(true);
    expect(managedTagMatches("tachyon-proxy-100", "tachyon-proxy")).toBe(true);
    expect(managedTagMatches("tachyon-proxy-1", "tachyon-proxy")).toBe(false);
    expect(managedTagMatches("tachyon-proxy-02", "tachyon-proxy")).toBe(false);
    expect(managedTagMatches("unrelated-tag-10", "tachyon-proxy")).toBe(false);
    expect(managedTagMatches("same-length--10", "tachyon-proxy")).toBe(false);
  });

  it("preserves a Prism-like suffixed tag in raw mode", () => {
    const raw = {
      inbounds: [{ tag: "tachyon-proxy-10", protocol: "socks" }],
      outbounds: [],
    };

    assertSensitiveEqual(parseXrayConfigText(JSON.stringify(raw), "en"), raw);
  });
});

import { defaultLauncherSettings } from "./gameProfiles";
import type { GameProfile, LauncherSettings } from "./gameProfiles";
import {
  buildXrayOutboundDraft,
  xrayConfigTemplateForNode,
} from "./subscriptions";
import type { ProxyNode, XrayOutboundObject } from "./subscriptions";

export interface XrayClientDraftOptions {
  enableStats?: boolean;
  httpListen?: string;
  httpPort?: number;
  routingMode?: XrayRoutingMode;
  socksListen?: string;
  socksPort?: number;
  statsListen?: string;
  statsPort?: number;
}

export type XrayRoutingMode = "direct" | "global" | "rule";

export interface CoreClientDraftOptions {
  fecAdaptWindow?: number;
  fecDataShards?: number;
  fecDynamic?: boolean;
  fecGroupTimeoutMs?: number;
  fecParityShards?: number;
  gameProfiles?: GameProfile[];
  launchers?: LauncherSettings;
  connectionMigration?: boolean;
  localAddrs?: string[];
  grpcListen?: string;
  grpcPort?: number;
  ipcListen?: string;
  ipcPort?: number;
  multipath?: boolean;
  serverAddr?: string;
  telemetryIntervalMs?: number;
  tgpAuthPsk?: string;
  tgpServerAddr?: string;
  tunAddress?: string;
  tunAutoRoute?: boolean;
  tunDnsHijack?: boolean;
  tunMtu?: number;
}

export function buildXrayClientConfigDraft(
  node: ProxyNode,
  options: XrayClientDraftOptions = {},
): Record<string, unknown> {
  const xrayOutbound = buildXrayOutboundDraft(node);
  const importedConfig = xrayConfigTemplateForNode(node) ?? {};
  const importedInbounds = recordArray(importedConfig.inbounds);
  const importedOutbounds = recordArray(importedConfig.outbounds);
  const importedApi = asRecord(importedConfig.api);
  const importedApiTag = stringValue(importedApi.tag);
  const usedTags = new Set(
    [...importedInbounds, ...importedOutbounds]
      .map((item) => stringValue(item.tag))
      .filter(Boolean),
  );
  if (importedApiTag) {
    usedTags.add(importedApiTag);
  }
  const importedOutboundIndex = node.xrayOutboundIndex;
  const importedSelectedOutbound = Number.isInteger(importedOutboundIndex)
    ? importedOutbounds[importedOutboundIndex!]
    : undefined;
  const importedProxyTag = stringValue(importedSelectedOutbound?.tag);
  const proxyTag = importedProxyTag || uniqueManagedTag("tachyon-proxy", usedTags);
  const directTag = uniqueManagedTag("tachyon-direct", usedTags);
  const blockTag = uniqueManagedTag("tachyon-block", usedTags);
  const socksTag = uniqueManagedTag("tachyon-socks", usedTags);
  const httpTag = uniqueManagedTag("tachyon-http", usedTags);
  const statsEnabled = Boolean(options.enableStats);
  const apiTag = statsEnabled
    ? importedApiTag || uniqueManagedTag("tachyon-xray-api", usedTags)
    : "";
  const apiInboundTag = statsEnabled
    ? uniqueManagedTag("tachyon-xray-api-in", usedTags)
    : "";
  if (importedSelectedOutbound && !importedProxyTag) {
    importedSelectedOutbound.tag = proxyTag;
  }
  const outbound = withTag(xrayOutbound, proxyTag);
  const config: Record<string, unknown> = {
    ...importedConfig,
    log: importedConfig.log ?? {
      loglevel: "warning",
    },
  };
  const inbounds: Array<Record<string, unknown>> = [
    ...importedInbounds,
    {
      tag: socksTag,
      listen: options.socksListen ?? "127.0.0.1",
      port: options.socksPort ?? 10808,
      protocol: "socks",
      settings: {
        auth: "noauth",
        udp: true,
      },
    },
  ];
  inbounds.push({
    tag: httpTag,
    listen: options.httpListen ?? "127.0.0.1",
    port: options.httpPort ?? 10809,
    protocol: "http",
    settings: {
      allowTransparent: false,
    },
  });
  const outbounds = [
    ...(importedSelectedOutbound ? [] : [outbound]),
    {
      tag: directTag,
      protocol: "freedom",
    },
    {
      tag: blockTag,
      protocol: "blackhole",
    },
    ...importedOutbounds,
  ];
  config.inbounds = inbounds;
  config.outbounds = outbounds;
  config.routing = mergeXrayRouting(
    importedConfig.routing,
    xrayRouting(options.routingMode ?? "rule", statsEnabled, {
      apiInboundTag,
      apiTag,
      blockTag,
      directTag,
      httpTag,
      proxyTag,
      socksTag,
    }),
  );
  if (statsEnabled) {
    inbounds.push({
      tag: apiInboundTag,
      listen: options.statsListen ?? "127.0.0.1",
      port: options.statsPort ?? 10085,
      protocol: "tunnel",
      settings: {
        rewriteAddress: "127.0.0.1",
      },
    });
    config.api = {
      ...importedApi,
      tag: apiTag,
      services: mergeStringList(importedApi.services, "StatsService"),
    };
    const importedPolicy = asRecord(importedConfig.policy);
    const importedSystemPolicy = asRecord(importedPolicy.system);
    config.policy = {
      ...importedPolicy,
      system: {
        ...importedSystemPolicy,
        statsInboundDownlink: true,
        statsInboundUplink: true,
        statsOutboundDownlink: true,
        statsOutboundUplink: true,
      },
    };
    config.stats = isRecord(importedConfig.stats)
      ? cloneRecord(importedConfig.stats)
      : {};
  }
  return config;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(isRecord).map((item) => cloneRecord(item))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function uniqueManagedTag(preferred: string, usedTags: Set<string>): string {
  let tag = preferred;
  let suffix = 2;
  while (usedTags.has(tag)) {
    tag = `${preferred}-${suffix}`;
    suffix += 1;
  }
  usedTags.add(tag);
  return tag;
}

function mergeStringList(value: unknown, required: string): string[] {
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return items.includes(required) ? items : [...items, required];
}

function mergeXrayRouting(
  imported: unknown,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const importedRouting = asRecord(imported);
  return {
    ...managed,
    ...cloneRecord(importedRouting),
    rules: [
      ...recordArray(managed.rules),
      ...recordArray(importedRouting.rules),
    ],
  };
}

export function buildCoreClientConfigDraft(
  options: CoreClientDraftOptions = {},
): Record<string, unknown> {
  const remoteEndpoint = normalizeEndpoint(options.serverAddr);
  const tgpEndpoint = normalizeEndpoint(options.tgpServerAddr) || remoteEndpoint;
  const localAddrs = normalizeList(options.localAddrs);
  if (!remoteEndpoint) {
    throw new Error("Tachyon server address is required");
  }
  const connectionMigration = options.connectionMigration ?? true;
  if (options.multipath && localAddrs.length < 2) {
    throw new Error("Tachyon multipath requires at least two local bind addresses");
  }
  if (options.multipath && !connectionMigration) {
    throw new Error("Tachyon multipath requires connection migration");
  }
  const gameProfiles = options.gameProfiles ?? [];
  const launchers = options.launchers ?? defaultLauncherSettings;
  const tgpAuthPsk = options.tgpAuthPsk?.trim() ?? "";
  if (tgpAuthPsk && tgpAuthPsk.length < 16) {
    throw new Error("Tachyon TGP PSK must be at least 16 characters");
  }

  return {
    mode: "client",
    client: {
      tun: {
        name: "",
        address: options.tunAddress ?? "198.18.0.1/16",
        mtu: options.tunMtu ?? 9000,
        auto_route: false,
        dns_hijack: false,
      },
      routing: {
        default_action: "direct",
        game_profiles: gameProfiles,
        launchers,
        rules: [
          {
            cidr: "192.168.0.0/16",
            action: "direct",
            priority: 50,
          },
          {
            geoip: "CN",
            action: "direct",
            priority: 10,
          },
        ],
      },
      proxy: {
        server_addr: remoteEndpoint,
        tgp_server_addr: tgpEndpoint,
        local_addrs: localAddrs,
      },
    },
    tgp: {
      ...(tgpAuthPsk ? { auth: { psk: tgpAuthPsk } } : {}),
      fec: {
        data_shards: options.fecDataShards ?? 4,
        parity_shards: options.fecParityShards ?? 2,
        group_timeout: `${options.fecGroupTimeoutMs ?? 20}ms`,
        dynamic: options.fecDynamic ?? true,
        adapt_window: options.fecAdaptWindow ?? 32,
      },
      pacing: {
        initial_rate_pps: 128,
        max_rate_pps: 1000,
      },
      connection_migration: connectionMigration,
      multipath: options.multipath ?? false,
      handshake_timeout: "5s",
      session_idle_timeout: "60s",
    },
    ipc: {
      websocket_addr: endpoint(options.ipcListen ?? "127.0.0.1", options.ipcPort ?? 55123),
      grpc_addr: endpoint(options.grpcListen ?? "127.0.0.1", options.grpcPort ?? 50051),
      telemetry_interval_ms: options.telemetryIntervalMs ?? 500,
    },
    observability: {
      log_level: "info",
      log_file: "",
      metrics_addr: "",
    },
  };
}

export function stringifyDraft(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function withTag(outbound: XrayOutboundObject, tag: string): XrayOutboundObject {
  return {
    ...outbound,
    tag,
  };
}

interface XrayManagedTags {
  apiInboundTag: string;
  apiTag: string;
  blockTag: string;
  directTag: string;
  httpTag: string;
  proxyTag: string;
  socksTag: string;
}

function xrayRouting(
  mode: XrayRoutingMode,
  enableStats: boolean,
  tags: XrayManagedTags,
): Record<string, unknown> {
  const localInboundTags = [tags.socksTag, tags.httpTag];
  const apiRule = enableStats
    ? [
        {
          type: "field",
          inboundTag: [tags.apiInboundTag],
          outboundTag: tags.apiTag,
        },
      ]
    : [];
  if (mode === "direct" || mode === "global") {
    return {
      domainStrategy: "AsIs",
      rules: [
        ...apiRule,
        {
          type: "field",
          inboundTag: localInboundTags,
          outboundTag: mode === "direct" ? tags.directTag : tags.proxyTag,
        },
      ],
    };
  }

  return {
    domainStrategy: "IPIfNonMatch",
    rules: [
      ...apiRule,
      {
        type: "field",
        inboundTag: localInboundTags,
        ip: ["geoip:private"],
        outboundTag: tags.directTag,
      },
      {
        type: "field",
        inboundTag: localInboundTags,
        domain: ["geosite:private"],
        outboundTag: tags.directTag,
      },
      {
        type: "field",
        inboundTag: localInboundTags,
        protocol: ["bittorrent"],
        outboundTag: tags.blockTag,
      },
    ],
  };
}

function endpoint(listen: string, port: number): string {
  return `${listen}:${port}`;
}

function normalizeEndpoint(value = ""): string {
  return value.trim().replace(/^tachyon:\/\//i, "").replace(/^tgp:\/\//i, "");
}

function normalizeList(values: string[] = []): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

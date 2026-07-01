import { defaultLauncherSettings } from "./gameProfiles";
import type { GameProfile, LauncherSettings } from "./gameProfiles";
import { buildXrayOutboundDraft } from "./subscriptions";
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
  const outbound = withTag(buildXrayOutboundDraft(node), "tachyon-proxy");
  const inbounds: Array<Record<string, unknown>> = [
    {
      tag: "tachyon-socks",
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
    tag: "tachyon-http",
    listen: options.httpListen ?? "127.0.0.1",
    port: options.httpPort ?? 10809,
    protocol: "http",
    settings: {
      allowTransparent: false,
    },
  });
  const outbounds = [
    outbound,
    {
      tag: "tachyon-direct",
      protocol: "freedom",
    },
    {
      tag: "tachyon-block",
      protocol: "blackhole",
    },
  ];
  const config: Record<string, unknown> = {
    log: {
      loglevel: "warning",
    },
    inbounds,
    routing: xrayRouting(options.routingMode ?? "rule", Boolean(options.enableStats)),
    outbounds,
  };
  if (options.enableStats) {
    inbounds.push({
      tag: "tachyon-xray-api-in",
      listen: options.statsListen ?? "127.0.0.1",
      port: options.statsPort ?? 10085,
      protocol: "tunnel",
      settings: {
        rewriteAddress: "127.0.0.1",
      },
    });
    config.api = {
      tag: "tachyon-xray-api",
      services: ["StatsService"],
    };
    config.policy = {
      system: {
        statsInboundDownlink: true,
        statsInboundUplink: true,
        statsOutboundDownlink: true,
        statsOutboundUplink: true,
      },
    };
    config.stats = {};
  }
  return config;
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

  return {
    mode: "client",
    client: {
      tun: {
        name: "",
        address: options.tunAddress ?? "198.18.0.1/16",
        mtu: options.tunMtu ?? 9000,
        auto_route: options.tunAutoRoute ?? false,
        dns_hijack: options.tunDnsHijack ?? false,
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

function xrayRouting(mode: XrayRoutingMode, enableStats = false): Record<string, unknown> {
  const apiRule = enableStats
    ? [
        {
          type: "field",
          inboundTag: ["tachyon-xray-api-in"],
          outboundTag: "tachyon-xray-api",
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
          inboundTag: ["tachyon-socks", "tachyon-http"],
          outboundTag: mode === "direct" ? "tachyon-direct" : "tachyon-proxy",
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
        inboundTag: ["tachyon-socks", "tachyon-http"],
        ip: ["geoip:private"],
        outboundTag: "tachyon-direct",
      },
      {
        type: "field",
        inboundTag: ["tachyon-socks", "tachyon-http"],
        domain: ["geosite:private"],
        outboundTag: "tachyon-direct",
      },
      {
        type: "field",
        inboundTag: ["tachyon-socks", "tachyon-http"],
        protocol: ["bittorrent"],
        outboundTag: "tachyon-block",
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

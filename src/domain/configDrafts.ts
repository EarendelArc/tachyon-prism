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
  gameProfiles?: GameProfile[];
  launchers?: LauncherSettings;
  grpcListen?: string;
  grpcPort?: number;
  ipcListen?: string;
  ipcPort?: number;
  telemetryIntervalMs?: number;
  tunAddress?: string;
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
    outbounds.push({
      tag: "tachyon-xray-api",
      protocol: "freedom",
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
  node: ProxyNode,
  options: CoreClientDraftOptions = {},
): Record<string, unknown> {
  const remoteEndpoint = nodeEndpoint(node);
  const gameProfiles = options.gameProfiles ?? [];
  const launchers = options.launchers ?? defaultLauncherSettings;

  return {
    mode: "client",
    client: {
      tun: {
        name: "",
        address: options.tunAddress ?? "198.18.0.1/16",
        mtu: options.tunMtu ?? 9000,
        auto_route: true,
        dns_hijack: true,
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
        tgp_server_addr: remoteEndpoint,
      },
    },
    tgp: {
      fec: {
        data_shards: 4,
        parity_shards: 2,
        group_timeout: "20ms",
      },
      pacing: {
        initial_rate_pps: 128,
        max_rate_pps: 1000,
      },
      connection_migration: true,
      multipath: false,
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

function nodeEndpoint(node: ProxyNode): string {
  if (node.port <= 0) {
    throw new Error("Selected node has no remote endpoint");
  }
  return `${node.address}:${node.port}`;
}

function endpoint(listen: string, port: number): string {
  return `${listen}:${port}`;
}

import type { GameProfile } from "./gameProfiles";
import { buildXrayOutboundDraft } from "./subscriptions";
import type { ProxyNode, XrayOutboundObject } from "./subscriptions";

export interface XrayClientDraftOptions {
  socksListen?: string;
  socksPort?: number;
}

export interface CoreClientDraftOptions {
  gameProfiles?: GameProfile[];
}

export function buildXrayClientConfigDraft(
  node: ProxyNode,
  options: XrayClientDraftOptions = {},
): Record<string, unknown> {
  const outbound = withTag(buildXrayOutboundDraft(node), "tachyon-proxy");
  return {
    log: {
      loglevel: "warning",
    },
    inbounds: [
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
    ],
    outbounds: [
      outbound,
      {
        tag: "tachyon-direct",
        protocol: "freedom",
      },
      {
        tag: "tachyon-block",
        protocol: "blackhole",
      },
    ],
  };
}

export function buildCoreClientConfigDraft(
  node: ProxyNode,
  options: CoreClientDraftOptions = {},
): Record<string, unknown> {
  const endpoint = nodeEndpoint(node);
  const gameProfiles = options.gameProfiles ?? [];

  return {
    mode: "client",
    client: {
      tun: {
        name: "",
        address: "198.18.0.1/16",
        mtu: 9000,
        auto_route: true,
        dns_hijack: true,
      },
      routing: {
        default_action: "direct",
        game_profiles: gameProfiles,
        launchers: {
          steam: {
            enabled: true,
            trackChildProcesses: true,
            accelerateGameUdp: true,
            accelerateSteamDownloads: false,
          },
        },
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
        server_addr: endpoint,
        tgp_server_addr: endpoint,
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
      websocket_addr: "127.0.0.1:55123",
      grpc_addr: "127.0.0.1:50051",
      telemetry_interval_ms: 500,
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

function nodeEndpoint(node: ProxyNode): string {
  if (node.port <= 0) {
    throw new Error("Selected node has no remote endpoint");
  }
  return `${node.address}:${node.port}`;
}

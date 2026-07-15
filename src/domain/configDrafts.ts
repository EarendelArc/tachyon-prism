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

export type XrayConfigLanguage = "en" | "zh-CN";
export type CanonicalXrayLoadState = "error" | "loaded" | "loading";

export function initializeAdvancedXrayDraftText(input: {
  canonicalText: string;
  enabled: boolean;
  generatedText: string;
  loadState: CanonicalXrayLoadState;
  persistedText: string;
}): string {
  if (!input.enabled || input.persistedText || input.loadState !== "loaded") {
    return input.persistedText;
  }
  return input.canonicalText || input.generatedText;
}

export type XrayConfigTextErrorCode =
  | "empty"
  | "syntax"
  | "top-level-object"
  | "field-object"
  | "field-array"
  | "array-entry-object"
  | "tag-string"
  | "managed-tag-conflict";

export class XrayConfigTextError extends Error {
  readonly code: XrayConfigTextErrorCode;

  constructor(code: XrayConfigTextErrorCode, message: string) {
    super(message);
    this.name = "XrayConfigTextError";
    this.code = code;
  }
}

const xrayObjectFields = [
  "api",
  "burstObservatory",
  "dns",
  "log",
  "metrics",
  "observatory",
  "policy",
  "reverse",
  "routing",
  "stats",
] as const;

const xrayArrayFields = ["fakedns", "inbounds", "outbounds"] as const;

const managedXrayTagOwners = [
  { owner: "inbounds", tag: "tachyon-xray-api-in" },
  { owner: "api", tag: "tachyon-xray-api" },
  { owner: "inbounds", tag: "tachyon-socks" },
  { owner: "inbounds", tag: "tachyon-http" },
  { owner: "outbounds", tag: "tachyon-proxy" },
  { owner: "outbounds", tag: "tachyon-direct" },
  { owner: "outbounds", tag: "tachyon-block" },
] as const;

/** Parses a complete Xray config without projecting it through a protocol model. */
export function parseXrayConfigText(
  text: string,
  language: XrayConfigLanguage = "en",
): Record<string, unknown> {
  if (!text.trim()) {
    throw xrayTextError("empty", language);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const position = jsonErrorPosition(error);
    throw xrayTextError("syntax", language, position === undefined ? undefined : String(position));
  }
  if (!isRecord(value)) {
    throw xrayTextError("top-level-object", language);
  }

  for (const field of xrayObjectFields) {
    if (field in value && !isRecord(value[field])) {
      throw xrayTextError("field-object", language, field);
    }
  }
  for (const field of xrayArrayFields) {
    const entries = value[field];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      throw xrayTextError("field-array", language, field);
    }
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) {
        throw xrayTextError("array-entry-object", language, `${field}[${index}]`);
      }
      if ("tag" in entry && typeof entry.tag !== "string") {
        throw xrayTextError("tag-string", language, `${field}[${index}].tag`);
      }
    }
  }

  validateManagedXrayTags(value, language);
  return value;
}

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

function validateManagedXrayTags(
  config: Record<string, unknown>,
  language: XrayConfigLanguage,
): void {
  const seen = new Map<string, string>();
  const taggedEntries: Array<{ owner: "api" | "inbounds" | "outbounds"; tag: string }> = [];
  for (const owner of ["inbounds", "outbounds"] as const) {
    for (const entry of (config[owner] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof entry.tag === "string") {
        taggedEntries.push({ owner, tag: entry.tag });
      }
    }
  }
  const api = isRecord(config.api) ? config.api : undefined;
  if (typeof api?.tag === "string") {
    taggedEntries.push({ owner: "api", tag: api.tag });
  }

  for (const entry of taggedEntries) {
    const managed = managedXrayTagOwners.find(({ tag }) => managedTagMatches(entry.tag, tag));
    if (!managed) {
      continue;
    }
    const previousOwner = seen.get(entry.tag);
    if (managed.owner !== entry.owner || previousOwner !== undefined) {
      const location = previousOwner ? `${previousOwner}, ${entry.owner}` : entry.owner;
      throw xrayTextError("managed-tag-conflict", language, `${entry.tag} (${location})`);
    }
    seen.set(entry.tag, entry.owner);
  }
}

export function managedTagMatches(value: string, managedTag: string): boolean {
  if (value === managedTag) {
    return true;
  }
  const prefix = `${managedTag}-`;
  if (!value.startsWith(prefix)) {
    return false;
  }
  const suffix = value.slice(prefix.length);
  return /^[0-9]+$/.test(suffix) && Number(suffix) >= 2 && !suffix.startsWith("0");
}

function jsonErrorPosition(error: unknown): number | undefined {
  const match = /position\s+(\d+)/i.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

function xrayTextError(
  code: XrayConfigTextErrorCode,
  language: XrayConfigLanguage,
  detail?: string,
): XrayConfigTextError {
  const suffix = detail ? `: ${detail}` : "";
  const messages: Record<XrayConfigTextErrorCode, { en: string; "zh-CN": string }> = {
    empty: {
      en: "Xray JSON cannot be empty",
      "zh-CN": "Xray JSON 不能为空",
    },
    syntax: {
      en: detail ? `Xray JSON syntax error at position ${detail}` : "Xray JSON syntax error",
      "zh-CN": detail ? `Xray JSON 语法错误（位置 ${detail}）` : "Xray JSON 语法错误",
    },
    "top-level-object": {
      en: "Xray JSON top level must be an object",
      "zh-CN": "Xray JSON 顶层必须是对象",
    },
    "field-object": {
      en: `Xray JSON field must be an object${suffix}`,
      "zh-CN": `Xray JSON 字段必须是对象${suffix}`,
    },
    "field-array": {
      en: `Xray JSON field must be an array${suffix}`,
      "zh-CN": `Xray JSON 字段必须是数组${suffix}`,
    },
    "array-entry-object": {
      en: `Xray JSON array entry must be an object${suffix}`,
      "zh-CN": `Xray JSON 数组项必须是对象${suffix}`,
    },
    "tag-string": {
      en: `Xray JSON tag must be a string${suffix}`,
      "zh-CN": `Xray JSON 标签必须是字符串${suffix}`,
    },
    "managed-tag-conflict": {
      en: `Prism managed tag conflict${suffix}`,
      "zh-CN": `Prism 管理标签冲突${suffix}`,
    },
  };
  return new XrayConfigTextError(code, messages[code][language]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

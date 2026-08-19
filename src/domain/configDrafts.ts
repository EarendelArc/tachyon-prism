import { defaultLauncherSettings } from "./gameProfiles";
import type { GameProfile, LauncherSettings } from "./gameProfiles";
import { normalizeGameRoutes } from "./gameRoutes";
import {
  buildXrayOutboundDraft,
  xrayConfigTemplateForNode,
} from "./subscriptions";
import type { ProxyNode, XrayOutboundObject } from "./subscriptions";

export interface XrayClientDraftOptions {
  configMode?: XrayConfigMode;
  enableStats?: boolean;
  httpListen?: string;
  httpPort?: number;
  routingMode?: XrayRoutingMode;
  socksListen?: string;
  socksPort?: number;
  statsListen?: string;
  statsPort?: number;
  rawConfig?: Record<string, unknown>;
}

export type XrayRoutingMode = "direct" | "global" | "rule";
export type XrayConfigMode = "managed" | "raw";

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
  | "managed-reference-rewrite"
  | "routing-reference"
  | "selector-array";

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

  validateXrayReferenceShapes(value, language);
  return value;
}

export interface CoreClientDraftOptions {
  fecAdaptWindow?: number;
  fecDataShards?: number;
  fecDynamic?: boolean;
  fecGroupTimeoutMs?: number;
  fecParityShards?: number;
  gameProfiles?: GameProfile[];
  gameRoutes?: string[];
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

export type CoreClientConfigErrorCode = "tun-mtu-too-small" | "tun-mtu-unsafe";

export class CoreClientConfigError extends Error {
  readonly code: CoreClientConfigErrorCode;
  readonly mtu: number;

  constructor(code: CoreClientConfigErrorCode, mtu: number) {
    super(code);
    this.name = "CoreClientConfigError";
    this.code = code;
    this.mtu = mtu;
  }
}

export const coreTgpMaxDatagramSize = 1352;
export const coreTgpWorstCaseTunOverhead = 68;
export const defaultCoreTunMtu = 1280;

export function buildXrayClientConfigDraft(
  node: ProxyNode | undefined,
  options: XrayClientDraftOptions = {},
): Record<string, unknown> {
  if (options.configMode === "raw") {
    if (!options.rawConfig) {
      throw new Error("Raw Xray config mode requires a complete config object");
    }
    const rawConfig = cloneRecord(options.rawConfig);
    validateXrayReferenceShapes(rawConfig, "en");
    return rawConfig;
  }
  if (!node) {
    throw new Error("Managed Xray config mode requires a selected node");
  }
  const xrayOutbound = buildXrayOutboundDraft(node);
  const importedTemplate = xrayConfigTemplateForNode(node);
  let importedConfig: Record<string, unknown> = importedTemplate
    ? { outbounds: recordArray(importedTemplate.outbounds) }
    : {};
  if (Object.keys(importedConfig).length > 0) {
    validateXrayReferenceShapes(importedConfig, "en");
  }
  const originalInbounds = recordArray(importedConfig.inbounds);
  const originalOutbounds = recordArray(importedConfig.outbounds);
  const importedApiTag = stringValue(asRecord(importedConfig.api).tag);
  const importedOutboundIndex = node.xrayOutboundIndex;
  const selectedOutboundIndex =
    Number.isInteger(importedOutboundIndex) && originalOutbounds[importedOutboundIndex!]
      ? importedOutboundIndex!
      : -1;
  const importedSelectedOutbound =
    selectedOutboundIndex >= 0 ? originalOutbounds[selectedOutboundIndex] : undefined;
  const importedProxyTag =
    stringValue(importedSelectedOutbound?.tag) || stringValue(xrayOutbound.tag);
  const usedTags = new Set(
    [
      ...originalInbounds,
      ...originalOutbounds.filter((_, index) => index !== selectedOutboundIndex),
    ]
      .map((item) => stringValue(item.tag))
      .filter(Boolean),
  );
  if (importedApiTag) {
    usedTags.add(importedApiTag);
  }
  const proxyTag =
    importedProxyTag && !managedProxyTagConflicts(importedProxyTag)
      ? importedProxyTag
      : uniqueManagedOutboundTag("tachyon-proxy", usedTags);
  usedTags.add(proxyTag);
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
  const finalOutboundTags = [
    ...originalOutbounds
      .map((outbound, index) =>
        index === selectedOutboundIndex ? proxyTag : stringValue(outbound.tag),
      )
      .filter(Boolean),
    directTag,
    blockTag,
    ...(apiTag ? [apiTag] : []),
  ];
  if (importedSelectedOutbound) {
    if (importedProxyTag && importedProxyTag !== proxyTag) {
      importedConfig = rewriteManagedOutboundTagReferences(
        importedConfig,
        selectedOutboundIndex,
        importedProxyTag,
        proxyTag,
        finalOutboundTags,
      );
    } else if (!importedProxyTag) {
      const outbounds = recordArray(importedConfig.outbounds);
      outbounds[selectedOutboundIndex].tag = proxyTag;
      importedConfig.outbounds = outbounds;
    }
  }
  const expectedImportedOutboundTags = [
    ...originalOutbounds
      .map((outbound, index) =>
        index === selectedOutboundIndex ? proxyTag : stringValue(outbound.tag),
      )
      .filter(Boolean),
    ...(importedApiTag ? [importedApiTag] : []),
  ];
  assertManagedSelectorsDoNotCaptureInjectedTags(
    importedConfig,
    expectedImportedOutboundTags,
    finalOutboundTags,
  );
  const importedInbounds = recordArray(importedConfig.inbounds);
  const importedOutbounds = recordArray(importedConfig.outbounds);
  const importedApi = asRecord(importedConfig.api);
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
  const managedRouting = xrayRouting(options.routingMode ?? "rule", statsEnabled, {
    apiInboundTag,
    apiTag,
    blockTag,
    directTag,
    httpTag,
    proxyTag,
    socksTag,
  });
  const managedOutboundTags = new Set(
    outbounds.map((managedOutbound) => stringValue(managedOutbound.tag)).filter(Boolean),
  );
  if (apiTag) {
    managedOutboundTags.add(apiTag);
  }
  validatePrismManagedRoutingTargets(managedRouting, managedOutboundTags);
  config.routing = mergeXrayRouting(
    importedConfig.routing,
    managedRouting,
    options.routingMode ?? "rule",
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
  validateXrayReferenceShapes(config, "en");
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

function validateXrayReferenceShapes(
  config: Record<string, unknown>,
  language: XrayConfigLanguage,
): void {
  const outboundEntries: Array<Record<string, unknown>> = [];
  const outbounds = config.outbounds;
  if (outbounds !== undefined && !Array.isArray(outbounds)) {
    throw xrayTextError("field-array", language, "outbounds");
  }
  for (const [index, outbound] of (outbounds ?? []).entries()) {
    if (!isRecord(outbound)) {
      throw xrayTextError("array-entry-object", language, `outbounds[${index}]`);
    }
    outboundEntries.push(outbound);
    const tag = outbound.tag;
    if (tag !== undefined && typeof tag !== "string") {
      throw xrayTextError("tag-string", language, `outbounds[${index}].tag`);
    }
  }
  const api = asRecord(config.api);
  if (api.tag !== undefined && typeof api.tag !== "string") {
    throw xrayTextError("tag-string", language, "api.tag");
  }

  const validateReference = (value: unknown, location: string): void => {
    if (value === undefined || value === "") {
      return;
    }
    if (typeof value !== "string") {
      throw xrayTextError("tag-string", language, location);
    }
  };
  const validateSelectors = (value: unknown, location: string): void => {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value) || value.some((selector) => typeof selector !== "string")) {
      throw xrayTextError("selector-array", language, location);
    }
  };

  for (const [index, outbound] of outboundEntries.entries()) {
    const proxySettings = outbound.proxySettings;
    if (proxySettings !== undefined && !isRecord(proxySettings)) {
      throw xrayTextError("field-object", language, `outbounds[${index}].proxySettings`);
    }
    validateReference(
      isRecord(proxySettings) ? proxySettings.tag : undefined,
      `outbounds[${index}].proxySettings.tag`,
    );
    const streamSettings = outbound.streamSettings;
    if (streamSettings !== undefined && !isRecord(streamSettings)) {
      throw xrayTextError("field-object", language, `outbounds[${index}].streamSettings`);
    }
    const sockopt = isRecord(streamSettings) ? streamSettings.sockopt : undefined;
    if (sockopt !== undefined && !isRecord(sockopt)) {
      throw xrayTextError("field-object", language, `outbounds[${index}].streamSettings.sockopt`);
    }
    validateReference(
      isRecord(sockopt) ? sockopt.dialerProxy : undefined,
      `outbounds[${index}].streamSettings.sockopt.dialerProxy`,
    );
  }

  const routing = asRecord(config.routing);
  const balancers = routing.balancers;
  if (balancers !== undefined && !Array.isArray(balancers)) {
    throw xrayTextError("field-array", language, "routing.balancers");
  }
  for (const [index, balancer] of (balancers ?? []).entries()) {
    if (!isRecord(balancer)) {
      throw xrayTextError("array-entry-object", language, `routing.balancers[${index}]`);
    }
    const tag = balancer.tag;
    if (tag !== undefined && typeof tag !== "string") {
      throw xrayTextError("tag-string", language, `routing.balancers[${index}].tag`);
    }
    validateSelectors(balancer.selector, `routing.balancers[${index}].selector`);
    validateReference(balancer.fallbackTag, `routing.balancers[${index}].fallbackTag`);
  }

  const rules = routing.rules;
  if (rules !== undefined && !Array.isArray(rules)) {
    throw xrayTextError("field-array", language, "routing.rules");
  }
  for (const [index, rule] of (rules ?? []).entries()) {
    if (!isRecord(rule)) {
      throw xrayTextError("array-entry-object", language, `routing.rules[${index}]`);
    }
    const outboundTag = rule.outboundTag;
    const balancerTag = rule.balancerTag;
    if (outboundTag !== undefined && typeof outboundTag !== "string") {
      throw xrayTextError("tag-string", language, `routing.rules[${index}].outboundTag`);
    }
    if (balancerTag !== undefined && typeof balancerTag !== "string") {
      throw xrayTextError("tag-string", language, `routing.rules[${index}].balancerTag`);
    }
    validateReference(outboundTag, `routing.rules[${index}].outboundTag`);
    validateReference(balancerTag, `routing.rules[${index}].balancerTag`);
  }
  validateSelectors(
    asRecord(config.observatory).subjectSelector,
    "observatory.subjectSelector",
  );
  validateSelectors(
    asRecord(config.burstObservatory).subjectSelector,
    "burstObservatory.subjectSelector",
  );
}

function validatePrismManagedRoutingTargets(
  managedRouting: Record<string, unknown>,
  managedOutboundTags: Set<string>,
): void {
  for (const [index, rule] of recordArray(managedRouting.rules).entries()) {
    const outboundTag = stringValue(rule.outboundTag);
    if (outboundTag && !managedOutboundTags.has(outboundTag)) {
      throw xrayTextError(
        "routing-reference",
        "en",
        `Prism routing.rules[${index}].outboundTag -> ${outboundTag}`,
      );
    }
  }
}

function managedProxyTagConflicts(tag: string): boolean {
  const managed = managedXrayTagOwners.find(({ tag: managedTag }) =>
    managedTagMatches(tag, managedTag),
  );
  return Boolean(managed && managed.tag !== "tachyon-proxy");
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
    "managed-reference-rewrite": {
      en: `Prism cannot safely rewrite managed Xray outbound references; use Raw config mode${suffix}`,
      "zh-CN": `Prism 无法安全重写托管 Xray 出站引用；请改用原始配置模式${suffix}`,
    },
    "routing-reference": {
      en: `Xray routing target does not exist${suffix}`,
      "zh-CN": `Xray 路由目标不存在${suffix}`,
    },
    "selector-array": {
      en: `Xray outbound selector must be an array of strings${suffix}`,
      "zh-CN": `Xray 出站选择器必须是字符串数组${suffix}`,
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

function uniqueManagedOutboundTag(preferred: string, usedTags: Set<string>): string {
  let tag = preferred;
  let suffix = 2;
  while (usedTags.has(tag) || [...usedTags].some((usedTag) => usedTag.startsWith(tag))) {
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
  mode: XrayRoutingMode,
): Record<string, unknown> {
  const importedRouting = asRecord(imported);
  const managedRules = recordArray(managed.rules);
  const importedRules = recordArray(importedRouting.rules);
  const rules =
    mode === "rule" && managedRules.length > 0
      ? [
          ...managedRules.slice(0, -1),
          ...importedRules,
          managedRules[managedRules.length - 1],
        ]
      : [...managedRules, ...importedRules];
  return {
    ...managed,
    ...cloneRecord(importedRouting),
    rules,
  };
}

function rewriteManagedOutboundTagReferences(
  config: Record<string, unknown>,
  selectedOutboundIndex: number,
  previousTag: string,
  managedTag: string,
  finalOutboundTags: string[],
): Record<string, unknown> {
  if (!finalOutboundTags.includes(managedTag)) {
    throw managedReferenceRewriteError(`managed target does not exist: ${managedTag}`);
  }
  const rewritten = cloneRecord(config);
  const originalOutboundTags = recordArray(config.outbounds)
    .map((outbound) => stringValue(outbound.tag))
    .filter(Boolean);
  const outbounds = recordArray(rewritten.outbounds);
  const selectedOutbound = outbounds[selectedOutboundIndex];
  if (!selectedOutbound || selectedOutbound.tag !== previousTag) {
    throw managedReferenceRewriteError("selected outbound identity changed");
  }
  selectedOutbound.tag = managedTag;

  const rewriteExact = (owner: Record<string, unknown>, key: string): void => {
    if (owner[key] === previousTag) {
      owner[key] = managedTag;
    }
  };
  for (const outbound of outbounds) {
    const proxySettings = asRecord(outbound.proxySettings);
    rewriteExact(proxySettings, "tag");
    const streamSettings = asRecord(outbound.streamSettings);
    const sockopt = asRecord(streamSettings.sockopt);
    rewriteExact(sockopt, "dialerProxy");
  }
  rewritten.outbounds = outbounds;

  const routing = asRecord(rewritten.routing);
  if (routing.rules !== undefined) {
    const rules = recordArray(routing.rules);
    for (const rule of rules) {
      rewriteExact(rule, "outboundTag");
    }
    routing.rules = rules;
  }
  if (routing.balancers !== undefined) {
    const balancers = recordArray(routing.balancers);
    for (const [index, balancer] of balancers.entries()) {
      rewriteExact(balancer, "fallbackTag");
      if (balancer.selector !== undefined) {
        balancer.selector = rewritePrefixSelectors(
          balancer.selector,
          previousTag,
          managedTag,
          originalOutboundTags,
          finalOutboundTags,
          `routing.balancers[${index}].selector`,
        );
      }
    }
    routing.balancers = balancers;
  }
  if (rewritten.routing !== undefined) {
    rewritten.routing = routing;
  }

  for (const field of ["observatory", "burstObservatory"] as const) {
    const observer = asRecord(rewritten[field]);
    if (observer.subjectSelector !== undefined) {
      observer.subjectSelector = rewritePrefixSelectors(
        observer.subjectSelector,
        previousTag,
        managedTag,
        originalOutboundTags,
        finalOutboundTags,
        `${field}.subjectSelector`,
      );
      rewritten[field] = observer;
    }
  }

  validateXrayReferenceShapes(rewritten, "en");
  return rewritten;
}

function rewritePrefixSelectors(
  value: unknown,
  previousTag: string,
  managedTag: string,
  originalOutboundTags: string[],
  finalOutboundTags: string[],
  location: string,
): string[] {
  if (!Array.isArray(value) || value.some((selector) => typeof selector !== "string")) {
    throw managedReferenceRewriteError(`${location} is not a string array`);
  }
  return value.map((selector) => {
    if (previousTag.startsWith(selector)) {
      const originalMatches = originalOutboundTags.filter((tag) => tag.startsWith(selector));
      const managedMatches = finalOutboundTags.filter((tag) => tag.startsWith(managedTag));
      if (
        selector !== previousTag ||
        originalMatches.length !== 1 ||
        originalMatches[0] !== previousTag ||
        managedMatches.length !== 1 ||
        managedMatches[0] !== managedTag
      ) {
        throw managedReferenceRewriteError(`${location}: ${selector}`);
      }
      return managedTag;
    }
    if (managedTag.startsWith(selector)) {
      throw managedReferenceRewriteError(`${location}: ${selector}`);
    }
    return selector;
  });
}

function assertManagedSelectorsDoNotCaptureInjectedTags(
  config: Record<string, unknown>,
  expectedImportedOutboundTags: string[],
  finalOutboundTags: string[],
): void {
  const expected = new Set(expectedImportedOutboundTags);
  const injected = finalOutboundTags.filter((tag) => !expected.has(tag));
  const selectorFields: Array<{ location: string; value: unknown }> = [];
  const routing = asRecord(config.routing);
  for (const [index, balancer] of recordArray(routing.balancers).entries()) {
    selectorFields.push({
      location: `routing.balancers[${index}].selector`,
      value: balancer.selector,
    });
  }
  for (const field of ["observatory", "burstObservatory"] as const) {
    selectorFields.push({
      location: `${field}.subjectSelector`,
      value: asRecord(config[field]).subjectSelector,
    });
  }
  for (const { location, value } of selectorFields) {
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.some((selector) => typeof selector !== "string")) {
      throw managedReferenceRewriteError(`${location} is not a string array`);
    }
    const captured = injected.filter((tag) =>
      value.some((selector) => tag.startsWith(selector as string)),
    );
    if (captured.length > 0) {
      throw managedReferenceRewriteError(`${location} captures ${captured.join(", ")}`);
    }
  }
}

function managedReferenceRewriteError(detail: string): XrayConfigTextError {
  return xrayTextError("managed-reference-rewrite", "en", detail);
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
  const gameRoutes = normalizeGameRoutes(options.gameRoutes ?? []);
  const launchers = options.launchers ?? defaultLauncherSettings;
  const tgpAuthPsk = options.tgpAuthPsk?.trim() ?? "";
  if (tgpAuthPsk && tgpAuthPsk.length < 16) {
    throw new Error("Tachyon TGP PSK must be at least 16 characters");
  }
  const tunMtu = options.tunMtu ?? defaultCoreTunMtu;
  if (tunMtu < 576) {
    throw new CoreClientConfigError("tun-mtu-too-small", tunMtu);
  }
  if (tunMtu + coreTgpWorstCaseTunOverhead > coreTgpMaxDatagramSize) {
    throw new CoreClientConfigError("tun-mtu-unsafe", tunMtu);
  }

  return {
    mode: "client",
    client: {
      tun: {
        name: "",
        address: options.tunAddress ?? "198.18.0.1/16",
        mtu: tunMtu,
        auto_route: false,
        dns_hijack: false,
        tgp_only: true,
        game_routes: gameRoutes,
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
      max_datagram_size: coreTgpMaxDatagramSize,
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
          network: "tcp,udp",
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
      {
        type: "field",
        network: "tcp,udp",
        outboundTag: tags.proxyTag,
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

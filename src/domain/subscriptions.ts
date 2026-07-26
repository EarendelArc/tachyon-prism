import { invokeDesktop, isTauriRuntime } from "./tauri";

export type SubscriptionErrorCode =
  | "fetch-failed"
  | "name-required"
  | "no-supported-nodes"
  | "no-remote-subscriptions"
  | "node-missing"
  | "outbound-missing"
  | "subscription-missing"
  | "update-failed"
  | "unsupported-outbound"
  | "url-required";

export class SubscriptionError extends Error {
  constructor(
    public readonly code: SubscriptionErrorCode,
    public readonly detail = "",
    message = subscriptionErrorDefaultMessage(code),
  ) {
    super(message);
    this.name = "SubscriptionError";
  }
}

function subscriptionErrorDefaultMessage(code: SubscriptionErrorCode): string {
  return {
    "fetch-failed": "Subscription fetch failed",
    "name-required": "Subscription name is required",
    "no-supported-nodes": "No supported nodes found",
    "no-remote-subscriptions": "No remote subscriptions to update",
    "node-missing": "Selected node no longer exists",
    "outbound-missing": "Node does not contain an Xray outbound draft",
    "subscription-missing": "Subscription no longer exists",
    "update-failed": "Subscription update failed",
    "unsupported-outbound": "unsupported-by-xray",
    "url-required": "Subscription URL is required",
  }[code];
}

export type XrayOutboundProtocol =
  | "blackhole"
  | "dns"
  | "freedom"
  | "http"
  | "loopback"
  | "shadowsocks"
  | "socks"
  | "trojan"
  | "vless"
  | "vmess"
  | "hysteria"
  | "wireguard"
  | "unknown";

export type ProxyProtocol = XrayOutboundProtocol | "tuic";
export type XrayOutboundCompatibilityStatus = "supported" | "unsupported-by-xray";

export interface XrayOutboundCompatibility {
  status: XrayOutboundCompatibilityStatus;
  reason: string | null;
}

export interface XrayOutboundObject {
  protocol: XrayOutboundProtocol | string;
  settings?: Record<string, unknown>;
  tag?: string;
  streamSettings?: Record<string, unknown>;
  proxySettings?: Record<string, unknown>;
  mux?: Record<string, unknown>;
  targetStrategy?: string;
  sendThrough?: string;
  [key: string]: unknown;
}

export interface ProxyNode {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  address: string;
  port: number;
  credential?: string;
  security?: string;
  transport?: string;
  sni?: string;
  parameters?: Record<string, string>;
  outbound?: XrayOutboundObject;
  xrayConfigId?: string;
  xrayOutboundIndex?: number;
  xrayCompatibility?: XrayOutboundCompatibility;
  rawUri: string;
}

export interface XrayImportedConfig {
  [key: string]: unknown;
  api?: Record<string, unknown>;
  burstObservatory?: Record<string, unknown>;
  dns?: Record<string, unknown>;
  fakedns?: unknown;
  observatory?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  routing?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

export interface SubscriptionParseReport {
  nodes: ProxyNode[];
  totalEntries: number;
  skippedEntries: number;
  invalidEntries: number;
  duplicateNodes: number;
  unsupportedProtocols: Record<string, number>;
}

export interface SubscriptionProfile {
  id: string;
  name: string;
  sourceUrl: string;
  updatedAt: string;
  nodes: ProxyNode[];
  xrayConfigTemplates?: Record<string, XrayImportedConfig>;
}

export interface SubscriptionSnapshot {
  sourceUrl: string;
  updatedAt: string;
  nodes: ProxyNode[];
  selectedNodeId: string;
  subscriptions: SubscriptionProfile[];
  selectedSubscriptionId: string;
}

const xrayConfigTemplateByNode = new WeakMap<ProxyNode, XrayImportedConfig>();

const xraySupportedOutboundProtocols = new Set<XrayOutboundProtocol>([
  "blackhole",
  "dns",
  "freedom",
  "http",
  "loopback",
  "shadowsocks",
  "socks",
  "trojan",
  "vless",
  "vmess",
  "hysteria",
  "wireguard",
]);

const xrayRealityCompatibleNetworks = new Set(["raw", "xhttp", "grpc"]);

const retainedProxyProtocols = new Set<ProxyProtocol>([
  ...xraySupportedOutboundProtocols,
  "tuic",
]);

const xrayUnsupportedReasons: Partial<Record<ProxyProtocol, string>> = {
  tuic: "Official Xray outbound protocols do not include TUIC; Prism retains this node but cannot start it with Xray Core.",
};

export const emptySubscriptionSnapshot: SubscriptionSnapshot = {
  sourceUrl: "",
  updatedAt: "",
  nodes: [],
  selectedNodeId: "",
  subscriptions: [],
  selectedSubscriptionId: "",
};

export async function fetchSubscriptionNodes(sourceUrl: string): Promise<ProxyNode[]> {
  const url = sourceUrl.trim();
  if (!url) {
    throw new SubscriptionError("url-required");
  }

  return parseSubscription(await fetchSubscriptionText(url));
}

export async function fetchSubscriptionText(sourceUrl: string): Promise<string> {
  const url = sourceUrl.trim();
  if (!url) {
    throw new SubscriptionError("url-required");
  }

  try {
    return await invokeDesktop<string>("fetch_subscription_text", { sourceUrl: url });
  } catch (error) {
    if (isTauriRuntime()) {
      throw new SubscriptionError(
        "fetch-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const response = await fetch(url, {
      headers: {
        accept: "text/plain, application/json, application/octet-stream, */*",
      },
    });
    if (!response.ok) {
      throw new SubscriptionError("fetch-failed", String(response.status));
    }
    return response.text();
  }
}

export function parseSubscription(input: string): ProxyNode[] {
  return parseSubscriptionWithReport(input).nodes;
}

export function parseSubscriptionWithReport(input: string): SubscriptionParseReport {
  const seen = new Set<string>();
  const nodes: ProxyNode[] = [];
  let parsedNodes = 0;
  let bestDiagnostics = emptySubscriptionDiagnostics();

  for (const payload of subscriptionPayloadCandidates(input)) {
    const payloadNodes = parsePayload(payload);
    const diagnostics = diagnosePayload(payload);
    if (
      payloadNodes.length > bestDiagnostics.parsedEntries ||
      (payloadNodes.length === bestDiagnostics.parsedEntries &&
        diagnostics.totalEntries > bestDiagnostics.totalEntries)
    ) {
      bestDiagnostics = {
        ...diagnostics,
        parsedEntries: payloadNodes.length,
      };
    }

    for (const node of payloadNodes) {
      parsedNodes += 1;
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      nodes.push(node);
    }
  }

  return {
    nodes,
    totalEntries: bestDiagnostics.totalEntries,
    skippedEntries: bestDiagnostics.skippedEntries,
    invalidEntries: bestDiagnostics.invalidEntries,
    duplicateNodes: Math.max(0, parsedNodes - nodes.length),
    unsupportedProtocols: bestDiagnostics.unsupportedProtocols,
  };
}

export function createSubscriptionSnapshot(
  sourceUrl: string,
  nodes: ProxyNode[],
  previous: SubscriptionSnapshot = emptySubscriptionSnapshot,
  name = "",
): SubscriptionSnapshot {
  if (nodes.length === 0) {
    throw new SubscriptionError("no-supported-nodes");
  }

  const normalizedSource = sourceUrl.trim();
  const profileName = normalizeSubscriptionName(name, normalizedSource);
  const profileId = subscriptionProfileId(profileName, normalizedSource);
  const selectedNodeId = nodes.some((node) => node.id === previous.selectedNodeId)
    ? previous.selectedNodeId
    : nodes[0]?.id ?? "";
  const existing = normalizeSubscriptionProfiles(previous.subscriptions);
  const nextProfile: SubscriptionProfile = {
    id: profileId,
    name: profileName,
    sourceUrl: normalizedSource,
    updatedAt: new Date().toISOString(),
    nodes,
    ...profileXrayConfigTemplates(nodes),
  };
  const nextProfiles = [
    ...existing.filter((profile) => profile.id !== profileId),
    nextProfile,
  ].sort((left, right) => left.name.localeCompare(right.name));

  return snapshotFromProfiles(nextProfiles, profileId, selectedNodeId);
}

export function activeSubscription(
  snapshot: SubscriptionSnapshot,
): SubscriptionProfile | undefined {
  return snapshot.subscriptions.find(
    (subscription) => subscription.id === snapshot.selectedSubscriptionId,
  );
}

export function totalSubscriptionNodes(snapshot: SubscriptionSnapshot): number {
  return snapshot.subscriptions.reduce(
    (total, subscription) => total + subscription.nodes.length,
    0,
  );
}

export function selectSubscription(
  snapshot: SubscriptionSnapshot,
  subscriptionId: string,
): SubscriptionSnapshot {
  const subscription = snapshot.subscriptions.find((item) => item.id === subscriptionId);
  if (!subscription) {
    throw new SubscriptionError("subscription-missing");
  }
  const selectedNodeId = subscription.nodes.some((node) => node.id === snapshot.selectedNodeId)
    ? snapshot.selectedNodeId
    : subscription.nodes[0]?.id ?? "";
  return snapshotFromProfiles(snapshot.subscriptions, subscription.id, selectedNodeId);
}

export function removeSubscription(
  snapshot: SubscriptionSnapshot,
  subscriptionId: string,
): SubscriptionSnapshot {
  const subscriptions = snapshot.subscriptions.filter(
    (subscription) => subscription.id !== subscriptionId,
  );
  return snapshotFromProfiles(subscriptions, subscriptions[0]?.id ?? "", "");
}

export function selectSubscriptionNode(
  snapshot: SubscriptionSnapshot,
  nodeId: string,
): SubscriptionSnapshot {
  const active = snapshot.subscriptions.find(
    (item) => item.id === snapshot.selectedSubscriptionId,
  );
  const subscription = active?.nodes.some((node) => node.id === nodeId)
    ? active
    : snapshot.subscriptions.find((item) =>
        item.nodes.some((node) => node.id === nodeId),
      );
  if (!subscription) {
    throw new SubscriptionError("node-missing");
  }
  return snapshotFromProfiles(snapshot.subscriptions, subscription.id, nodeId);
}

export function xrayOutboundCompatibilityForProtocol(
  protocol: string,
): XrayOutboundCompatibility {
  const normalized = normalizeProtocol(protocol);
  if (xraySupportedOutboundProtocols.has(normalized as XrayOutboundProtocol)) {
    return { status: "supported", reason: null };
  }
  return {
    status: "unsupported-by-xray",
    reason:
      xrayUnsupportedReasons[normalized] ??
      `Xray Core does not list ${normalized || "unknown"} as a supported outbound protocol.`,
  };
}

export function xrayOutboundCompatibilityForNode(
  node: ProxyNode,
): XrayOutboundCompatibility {
  const importedOutbound = xrayOutboundTemplateForNode(node);
  if (importedOutbound) {
    return xrayOutboundCompatibilityForOutbound(importedOutbound);
  }
  const protocolCompatibility = xrayOutboundCompatibilityForProtocol(node.protocol);
  if (protocolCompatibility.status !== "supported") {
    return protocolCompatibility;
  }

  if (!node.outbound) {
    return protocolCompatibility;
  }

  return xrayOutboundCompatibilityForOutbound(node.outbound);
}

export function assertXrayOutboundSupported(node: ProxyNode): void {
  const compatibility = xrayOutboundCompatibilityForNode(node);
  if (compatibility.status !== "supported") {
    throw new SubscriptionError(
      "unsupported-outbound",
      node.name,
      `${node.name} is ${compatibility.status}: ${compatibility.reason ?? "cannot be used as an active Xray outbound"}`,
    );
  }
}

export function buildXrayOutboundDraft(node: ProxyNode): XrayOutboundObject {
  assertXrayOutboundSupported(node);
  const importedOutbound = xrayOutboundTemplateForNode(node);
  if (importedOutbound) {
    return importedOutbound;
  }
  if (node.outbound) {
    return cloneRecord(node.outbound) as XrayOutboundObject;
  }
  throw new SubscriptionError("outbound-missing", node.name);
}

export function xrayConfigTemplateForNode(
  node: ProxyNode,
): XrayImportedConfig | undefined {
  const template = xrayConfigTemplateByNode.get(node);
  return template
    ? (cloneRecord(template) as XrayImportedConfig)
    : undefined;
}

export function subscriptionSnapshotFromStored(value: unknown): SubscriptionSnapshot {
  try {
    if (!isRecord(value)) {
      return emptySubscriptionSnapshot;
    }
    const snapshot = value as Partial<SubscriptionSnapshot>;
    const subscriptions = normalizeSubscriptionProfiles(snapshot.subscriptions);
    if (subscriptions.length > 0) {
      return snapshotFromProfiles(
        subscriptions,
        typeof snapshot.selectedSubscriptionId === "string"
          ? snapshot.selectedSubscriptionId
          : "",
        typeof snapshot.selectedNodeId === "string" ? snapshot.selectedNodeId : "",
      );
    }

    const legacyXrayConfigTemplates: Record<string, XrayImportedConfig> = {};
    const nodes = Array.isArray(snapshot.nodes)
      ? snapshot.nodes
          .map((node) => normalizeStoredNode(node, legacyXrayConfigTemplates))
          .filter((node): node is ProxyNode => node !== null)
      : [];
    if (nodes.length === 0) {
      return emptySubscriptionSnapshot;
    }

    return createSubscriptionSnapshot(
      typeof snapshot.sourceUrl === "string" ? snapshot.sourceUrl : "manual",
      nodes,
      emptySubscriptionSnapshot,
      normalizeSubscriptionName("", typeof snapshot.sourceUrl === "string" ? snapshot.sourceUrl : ""),
    );
  } catch {
    return emptySubscriptionSnapshot;
  }
}

export function subscriptionSnapshotForStorage(
  snapshot: SubscriptionSnapshot,
): SubscriptionSnapshot {
  const canonical = snapshotFromProfiles(
    snapshot.subscriptions,
    snapshot.selectedSubscriptionId,
    snapshot.selectedNodeId,
  );
  return { ...canonical, nodes: [] };
}

function subscriptionPayloadCandidates(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  const values = [trimmed];
  const decoded = decodeBase64(trimmed);
  if (decoded && decoded.trim() !== trimmed) {
    values.push(decoded.trim());
  }
  return values;
}

function parsePayload(payload: string): ProxyNode[] {
  const jsonNodes = parseJSONPayload(payload);
  if (jsonNodes.length > 0) {
    return jsonNodes;
  }

  const clashNodes = parseClashPayload(payload);
  if (clashNodes.length > 0) {
    return clashNodes;
  }

  const nodes: ProxyNode[] = [];
  for (const line of payload.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) {
      continue;
    }

    const lineJSONNodes = parseJSONPayload(value);
    if (lineJSONNodes.length > 0) {
      nodes.push(...lineJSONNodes);
      continue;
    }

    const node = parseProxyUri(value);
    if (node) {
      nodes.push(node);
    }
  }
  return nodes;
}

interface SubscriptionDiagnostics {
  totalEntries: number;
  skippedEntries: number;
  invalidEntries: number;
  parsedEntries: number;
  unsupportedProtocols: Record<string, number>;
}

function emptySubscriptionDiagnostics(): SubscriptionDiagnostics {
  return {
    totalEntries: 0,
    skippedEntries: 0,
    invalidEntries: 0,
    parsedEntries: 0,
    unsupportedProtocols: {},
  };
}

function diagnosePayload(payload: string): SubscriptionDiagnostics {
  const jsonValue = parseJSON(payload);
  if (jsonValue !== null) {
    return diagnoseJSONPayload(jsonValue);
  }

  if (/^\s*proxies\s*:/m.test(payload)) {
    return diagnoseClashPayload(payload);
  }

  return diagnoseLinePayload(payload);
}

function diagnoseJSONPayload(value: unknown): SubscriptionDiagnostics {
  const diagnostics = emptySubscriptionDiagnostics();
  const records = jsonOutboundRecords(value);
  if (records.length === 0) {
    diagnostics.totalEntries = 1;
    diagnostics.invalidEntries = 1;
    diagnostics.skippedEntries = 1;
    return diagnostics;
  }

  diagnostics.totalEntries = records.length;
  for (const record of records) {
    const rawProtocol = outboundProtocolName(record);
    const protocol = normalizeProtocol(rawProtocol);
    if (protocol === "unknown" && rawProtocol !== "unknown") {
      incrementProtocol(diagnostics.unsupportedProtocols, rawProtocol || "unknown");
      diagnostics.skippedEntries += 1;
      continue;
    }
    if (!nodeFromJSONOutbound(record, JSON.stringify(record))) {
      diagnostics.invalidEntries += 1;
      diagnostics.skippedEntries += 1;
    }
  }
  return diagnostics;
}

function diagnoseClashPayload(payload: string): SubscriptionDiagnostics {
  const diagnostics = emptySubscriptionDiagnostics();
  const records = parseClashProxyRecords(payload);
  diagnostics.totalEntries = records.length;

  for (const record of records) {
    const rawProtocol = clashValue(record, ["type"]);
    const protocol = normalizeProtocol(rawProtocol);
    if (protocol === "unknown") {
      incrementProtocol(diagnostics.unsupportedProtocols, rawProtocol || "unknown");
      diagnostics.skippedEntries += 1;
      continue;
    }
    if (!nodeFromClashProxy(record)) {
      diagnostics.invalidEntries += 1;
      diagnostics.skippedEntries += 1;
    }
  }

  return diagnostics;
}

function diagnoseLinePayload(payload: string): SubscriptionDiagnostics {
  const diagnostics = emptySubscriptionDiagnostics();
  for (const line of payload.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) {
      continue;
    }
    diagnostics.totalEntries += 1;

    if (parseJSONPayload(value).length > 0 || parseProxyUri(value)) {
      continue;
    }

    const scheme = uriScheme(value);
    if (scheme && normalizeProtocol(scheme) === "unknown") {
      incrementProtocol(diagnostics.unsupportedProtocols, scheme);
    } else {
      diagnostics.invalidEntries += 1;
    }
    diagnostics.skippedEntries += 1;
  }
  return diagnostics;
}

function jsonOutboundRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(jsonOutboundRecords);
  }
  if (!isRecord(value)) {
    return [];
  }
  if (Array.isArray(value.outbounds)) {
    return value.outbounds.filter(isRecord);
  }
  if (isRecord(value.outbound)) {
    return [value.outbound];
  }
  if (typeof value.protocol === "string" || typeof value.type === "string") {
    return [value];
  }
  return [];
}

function uriScheme(value: string): string {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase() ?? "";
}

function incrementProtocol(protocols: Record<string, number>, protocol: string): void {
  const key = protocol.trim().toLowerCase() || "unknown";
  protocols[key] = (protocols[key] ?? 0) + 1;
}

function parseJSONPayload(payload: string): ProxyNode[] {
  const value = parseJSON(payload);
  if (value === null) {
    return [];
  }
  return nodesFromJSON(value, payload);
}

function parseClashPayload(payload: string): ProxyNode[] {
  if (!/^\s*proxies\s*:/m.test(payload)) {
    return [];
  }

  return parseClashProxyRecords(payload)
    .map(nodeFromClashProxy)
    .filter((node): node is ProxyNode => node !== null);
}

function parseClashProxyRecords(payload: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  const lines = payload.replace(/\t/g, "  ").split(/\r?\n/);
  let inProxies = false;
  let proxiesIndent = 0;
  let current: Record<string, string> | null = null;
  let stack: Array<{ indent: number; path: string }> = [];

  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine);
    if (!line.trim()) {
      continue;
    }

    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    const topLevel = parseYamlKeyValue(trimmed);
    if (!inProxies && topLevel?.key === "proxies") {
      inProxies = true;
      proxiesIndent = indent;
      continue;
    }

    if (!inProxies) {
      continue;
    }
    if (indent <= proxiesIndent && !trimmed.startsWith("- ")) {
      break;
    }

    if (trimmed.startsWith("- ")) {
      if (indent <= proxiesIndent) {
        break;
      }
      if (current && Object.keys(current).length > 0) {
        records.push(current);
      }
      current = {};
      stack = [];
      assignYamlEntry(current, "", trimmed.slice(2).trim());
      continue;
    }

    if (!current) {
      continue;
    }

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const entry = parseYamlKeyValue(trimmed);
    if (!entry) {
      continue;
    }
    const parentPath = stack.map((item) => item.path).join(".");
    const keyPath = parentPath ? `${parentPath}.${entry.key}` : entry.key;
    if (entry.value === "") {
      stack.push({ indent, path: entry.key });
      continue;
    }
    assignYamlValue(current, keyPath, entry.value);
  }

  if (current && Object.keys(current).length > 0) {
    records.push(current);
  }
  return records;
}

function nodeFromClashProxy(record: Record<string, string>): ProxyNode | null {
  const protocol = normalizeProtocol(clashValue(record, ["type"]));
  if (protocol === "unknown") {
    return null;
  }

  const address = clashValue(record, ["server", "address"]);
  const port = parsePort(clashValue(record, ["port"]));
  if (!address || port === 0) {
    return null;
  }

  const name = clashValue(record, ["name"]) || `${protocol.toUpperCase()} ${address}`;
  const settings = clashOutboundSettings(protocol, record, address, port);
  const outbound = compactOutbound({
    tag: name,
    protocol,
    settings,
    streamSettings: clashStreamSettings(record, protocol),
  });

  return nodeFromOutbound(outbound, `clash://${stableNodeId(JSON.stringify(record))}`);
}

function clashOutboundSettings(
  protocol: ProxyProtocol,
  record: Record<string, string>,
  address: string,
  port: number,
): Record<string, unknown> {
  switch (protocol) {
    case "vless":
      return compactRecord({
        address,
        port,
        id: clashValue(record, ["uuid", "id"]),
        encryption: clashValue(record, ["encryption"]) || "none",
        flow: clashValue(record, ["flow"]),
      });
    case "vmess":
      return compactRecord({
        address,
        port,
        id: clashValue(record, ["uuid", "id"]),
        security: clashValue(record, ["cipher", "security"]) || "auto",
      });
    case "trojan":
      return compactRecord({
        address,
        port,
        password: clashValue(record, ["password"]),
      });
    case "tuic":
      return compactRecord({
        address,
        port,
        uuid: clashValue(record, ["uuid"]),
        password: clashValue(record, ["password", "token"]),
        congestion: clashValue(record, ["congestion-controller", "congestion"]),
        udpRelayMode: clashValue(record, ["udp-relay-mode", "udpRelayMode"]),
        reduceRtt: clashBooleanOrUndefined(record, ["reduce-rtt", "reduceRtt"]),
        zeroRttHandshake: clashBooleanOrUndefined(record, [
          "zero-rtt-handshake",
          "zeroRttHandshake",
        ]),
        heartbeat: clashValue(record, ["heartbeat-interval", "heartbeat"]),
        disableSNI: clashBooleanOrUndefined(record, ["disable-sni", "disableSNI"]),
      });
    case "shadowsocks":
      return compactRecord({
        address,
        port,
        method: clashValue(record, ["cipher", "method"]),
        password: clashValue(record, ["password"]),
      });
    case "hysteria":
      return compactRecord({
        version: clashValue(record, ["type"]).toLowerCase() === "hysteria" ? 1 : 2,
        address,
        port,
      });
    case "socks":
    case "http": {
      const user = clashValue(record, ["username", "user"]);
      const pass = clashValue(record, ["password", "pass"]);
      const server: Record<string, unknown> = { address, port };
      if (user) {
        server.user = user;
        server.pass = pass;
      }
      return compactRecord(server);
    }
    case "wireguard":
      return compactRecord({
        secretKey: clashValue(record, ["private-key", "secret-key", "secretKey"]),
        address: clashList(record, ["ip", "ipv6", "interface-address", "local-address"]),
        noKernelTun: clashBooleanOrUndefined(record, ["no-kernel-tun", "noKernelTun"]),
        mtu: clashInteger(record, ["mtu"]),
        reserved: clashIntegerList(record, ["reserved"]),
        workers: clashInteger(record, ["workers"]),
        domainStrategy: clashValue(record, ["domain-strategy", "domainStrategy"]),
        peers: [
          compactRecord({
            endpoint: `${address}:${port}`,
            publicKey: clashValue(record, ["public-key", "publicKey"]),
            preSharedKey: clashValue(record, [
              "pre-shared-key",
              "preshared-key",
              "preSharedKey",
            ]),
            keepAlive: clashInteger(record, ["keepalive", "keep-alive", "keepAlive"]),
            allowedIPs: clashList(record, ["allowed-ips", "allowedIPs", "allowed_ips"]),
          }),
        ],
      });
    default:
      return compactRecord({ address, port });
  }
}

function clashStreamSettings(
  record: Record<string, string>,
  protocol: ProxyProtocol = "unknown",
): Record<string, unknown> {
  const params = new URLSearchParams();
  const network = clashValue(record, ["network", "net"]) || (protocol === "hysteria" ? "hysteria" : "");
  if (network) {
    params.set("type", network);
  }

  const hasReality =
    clashValue(record, ["reality-opts.public-key", "reality-opts.publicKey", "pbk"]) !== "";
  if (hasReality) {
    params.set("security", "reality");
  } else if (
    protocol === "tuic" ||
    clashBoolean(record, ["tls"]) ||
    clashValue(record, ["security"]) === "tls"
  ) {
    params.set("security", "tls");
  }

  setParamIfPresent(params, "sni", clashValue(record, ["sni", "servername", "serverName"]));
  setParamIfPresent(params, "fp", clashValue(record, ["client-fingerprint", "fingerprint", "fp"]));
  setParamIfPresent(params, "alpn", clashValue(record, ["alpn"]));
  setParamIfPresent(
    params,
    "allowInsecure",
    clashValue(record, ["skip-cert-verify", "allow-insecure", "allowInsecure", "insecure"]),
  );
  setParamIfPresent(params, "pbk", clashValue(record, ["reality-opts.public-key", "reality-opts.publicKey", "pbk"]));
  setParamIfPresent(params, "sid", clashValue(record, ["reality-opts.short-id", "reality-opts.shortId", "sid"]));
  setParamIfPresent(params, "spx", clashValue(record, ["reality-opts.spider-x", "reality-opts.spiderX", "spx"]));
  setParamIfPresent(params, "path", clashValue(record, ["ws-opts.path", "http-opts.path", "h2-opts.path", "path"]));
  setParamIfPresent(
    params,
    "host",
    clashValue(record, ["ws-opts.headers.Host", "ws-opts.headers.host", "ws-opts.host", "host"]),
  );
  setParamIfPresent(
    params,
    "serviceName",
    clashValue(record, ["grpc-opts.grpc-service-name", "grpc-opts.serviceName", "serviceName"]),
  );
  if (protocol === "hysteria") {
    setParamIfPresent(params, "auth", clashValue(record, ["auth", "auth-str", "password"]));
    setParamIfPresent(
      params,
      "udpIdleTimeout",
      clashValue(record, ["udp-idle-timeout", "udpIdleTimeout"]),
    );
  }
  return streamSettingsFromParams(params);
}

function assignYamlEntry(
  record: Record<string, string>,
  parentPath: string,
  value: string,
): void {
  if (!value) {
    return;
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    assignInlineYamlMap(record, parentPath, value);
    return;
  }
  const entry = parseYamlKeyValue(value);
  if (!entry) {
    return;
  }
  assignYamlValue(record, parentPath ? `${parentPath}.${entry.key}` : entry.key, entry.value);
}

function assignYamlValue(
  record: Record<string, string>,
  keyPath: string,
  rawValue: string,
): void {
  if (rawValue.startsWith("{") && rawValue.endsWith("}")) {
    assignInlineYamlMap(record, keyPath, rawValue);
    return;
  }
  record[keyPath] = yamlScalar(rawValue);
}

function assignInlineYamlMap(
  record: Record<string, string>,
  parentPath: string,
  rawValue: string,
): void {
  const body = rawValue.trim().slice(1, -1).trim();
  for (const item of splitInlineYamlItems(body)) {
    const entry = parseYamlKeyValue(item);
    if (!entry) {
      continue;
    }
    const keyPath = parentPath ? `${parentPath}.${entry.key}` : entry.key;
    assignYamlValue(record, keyPath, entry.value);
  }
}

function parseYamlKeyValue(value: string): { key: string; value: string } | null {
  const splitAt = value.indexOf(":");
  if (splitAt <= 0) {
    return null;
  }
  return {
    key: value.slice(0, splitAt).trim().replace(/^["']|["']$/g, ""),
    value: value.slice(splitAt + 1).trim(),
  };
}

function stripYamlComment(value: string): string {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function splitInlineYamlItems(value: string): string[] {
  const items: string[] = [];
  let quote = "";
  let depth = 0;
  let squareDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    } else if (!quote && char === "{") {
      depth += 1;
    } else if (!quote && char === "}") {
      depth -= 1;
    } else if (!quote && char === "[") {
      squareDepth += 1;
    } else if (!quote && char === "]") {
      squareDepth -= 1;
    } else if (!quote && depth === 0 && squareDepth === 0 && char === ",") {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "null" || trimmed === "~") {
    return "";
  }
  return trimmed;
}

function clashValue(record: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

function clashBoolean(record: Record<string, string>, keys: string[]): boolean {
  const value = clashValue(record, keys).toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function clashBooleanOrUndefined(
  record: Record<string, string>,
  keys: string[],
): boolean | undefined {
  const value = clashValue(record, keys).toLowerCase();
  if (!value) {
    return undefined;
  }
  return value === "true" || value === "1" || value === "yes";
}

function clashInteger(record: Record<string, string>, keys: string[]): number | undefined {
  const value = Number.parseInt(clashValue(record, keys), 10);
  return Number.isInteger(value) ? value : undefined;
}

function clashList(record: Record<string, string>, keys: string[]): string[] | undefined {
  return splitList(clashValue(record, keys));
}

function clashIntegerList(record: Record<string, string>, keys: string[]): number[] | undefined {
  return integerList(clashValue(record, keys));
}

function setParamIfPresent(params: URLSearchParams, key: string, value: string): void {
  if (value) {
    params.set(key, value);
  }
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}

function nodesFromJSON(value: unknown, raw: string): ProxyNode[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => nodesFromJSON(item, raw));
  }

  if (!isRecord(value)) {
    return [];
  }

  const xrayConfig = xrayImportedConfigFromJSON(value);
  if (Array.isArray(value.outbounds)) {
    return value.outbounds.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const node = nodeFromJSONOutbound(
        item,
        `${raw}#outbound-${index}`,
        xrayConfig,
        index,
      );
      return node ? [node] : [];
    });
  }

  if (isRecord(value.outbound)) {
    const node = nodeFromJSONOutbound(value.outbound, raw, xrayConfig);
    return node ? [node] : [];
  }

  if (typeof value.protocol === "string" || typeof value.type === "string") {
    const node = nodeFromJSONOutbound(value, raw, xrayConfig);
    return node ? [node] : [];
  }

  const vmessNode = nodeFromVMessShare(value, raw);
  return vmessNode ? [vmessNode] : [];
}

function nodeFromJSONOutbound(
  value: Record<string, unknown>,
  raw: string,
  xrayConfig?: XrayImportedConfig,
  xrayOutboundIndex?: number,
): ProxyNode | null {
  const outbound = normalizedJSONOutbound(value);
  return outbound
    ? nodeFromOutbound(outbound, raw, xrayConfig, xrayOutboundIndex)
    : null;
}

function normalizedJSONOutbound(value: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof value.protocol === "string") {
    return value;
  }
  if (typeof value.type === "string") {
    return singBoxOutboundToXray(value);
  }
  return null;
}

function outboundProtocolName(value: Record<string, unknown>): string {
  return stringValue(value.protocol) || stringValue(value.type);
}

function singBoxOutboundToXray(value: Record<string, unknown>): XrayOutboundObject | null {
  const protocol = normalizeProtocol(stringValue(value.type));
  if (protocol === "unknown") {
    return null;
  }

  const address = stringValue(value.server) || stringValue(value.address);
  const port = numberValue(value.server_port) || numberValue(value.port);
  const settings = singBoxOutboundSettings(protocol, value, address, port);
  if (!settings) {
    return null;
  }

  return compactOutbound({
    tag: stringValue(value.tag),
    protocol,
    settings,
    streamSettings: singBoxStreamSettings(value, protocol),
  });
}

function singBoxOutboundSettings(
  protocol: ProxyProtocol,
  value: Record<string, unknown>,
  address: string,
  port: number,
): Record<string, unknown> | null {
  switch (protocol) {
    case "vless":
      return compactRecord({
        address,
        port,
        id: stringValue(value.uuid) || stringValue(value.id),
        encryption: stringValue(value.encryption) || "none",
        flow: stringValue(value.flow),
      });
    case "vmess":
      return compactRecord({
        address,
        port,
        id: stringValue(value.uuid) || stringValue(value.id),
        alterId: numberValue(value.alter_id),
        security: stringValue(value.security) || "auto",
      });
    case "trojan":
      return compactRecord({
        address,
        port,
        password: stringValue(value.password),
      });
    case "shadowsocks":
      return compactRecord({
        address,
        port,
        method: stringValue(value.method),
        password: stringValue(value.password),
      });
    case "socks":
    case "http":
      return compactRecord({
        address,
        port,
        user: stringValue(value.username) || stringValue(value.user),
        pass: stringValue(value.password) || stringValue(value.pass),
      });
    case "hysteria":
      return compactRecord({
        version: 2,
        address,
        port,
      });
    case "tuic":
      return compactRecord({
        address,
        port,
        uuid: stringValue(value.uuid),
        password: stringValue(value.password),
        congestion: stringValue(value.congestion_control) || stringValue(value.congestion),
        udpRelayMode: stringValue(value.udp_relay_mode) || stringValue(value.udpRelayMode),
        reduceRtt: booleanValue(value.reduce_rtt),
        zeroRttHandshake: booleanValue(value.zero_rtt_handshake),
        heartbeat: stringValue(value.heartbeat),
        disableSNI: booleanValue(value.disable_sni),
      });
    case "wireguard": {
      const peer = compactRecord({
        endpoint: address && port > 0 ? `${address}:${port}` : stringValue(value.endpoint),
        publicKey: stringValue(value.peer_public_key) || stringValue(value.public_key),
        preSharedKey: stringValue(value.pre_shared_key) || stringValue(value.preshared_key),
        keepAlive: numberValue(value.keepalive) || numberValue(value.keep_alive),
        allowedIPs: stringListValue(value.allowed_ips),
      });
      return compactRecord({
        secretKey: stringValue(value.private_key) || stringValue(value.secret_key),
        address: stringListValue(value.local_address) ?? stringListValue(value.address),
        noKernelTun: booleanValue(value.no_kernel_tun),
        mtu: numberValue(value.mtu),
        reserved: numberListValue(value.reserved),
        workers: numberValue(value.workers),
        domainStrategy: stringValue(value.domain_strategy),
        peers: [peer],
      });
    }
    default:
      return compactRecord({ address, port });
  }
}

function singBoxStreamSettings(
  value: Record<string, unknown>,
  protocol: ProxyProtocol,
): Record<string, unknown> {
  const params = new URLSearchParams();
  const transport = asRecord(value.transport);
  const transportType = stringValue(transport.type);
  if (transportType) {
    params.set("type", transportType);
  } else if (protocol === "hysteria") {
    params.set("type", "hysteria");
  }

  setParamIfPresent(params, "path", stringValue(transport.path));
  setParamIfPresent(params, "host", headerValue(asRecord(transport.headers), ["Host", "host"]));
  setParamIfPresent(
    params,
    "serviceName",
    stringValue(transport.service_name) || stringValue(transport.serviceName),
  );

  const tls = asRecord(value.tls);
  const reality = asRecord(tls.reality);
  const tlsEnabled = booleanValue(tls.enabled) === true || protocol === "tuic";
  const realityEnabled = booleanValue(reality.enabled) === true || stringValue(reality.public_key) !== "";
  if (realityEnabled) {
    params.set("security", "reality");
  } else if (tlsEnabled) {
    params.set("security", "tls");
  }

  setParamIfPresent(params, "sni", stringValue(tls.server_name) || stringValue(tls.serverName));
  setParamIfPresent(params, "fp", stringValue(asRecord(tls.utls).fingerprint) || stringValue(tls.fingerprint));
  setParamIfPresent(params, "alpn", stringListValue(tls.alpn)?.join(",") ?? "");
  if (booleanValue(tls.insecure) !== undefined) {
    params.set("allowInsecure", String(booleanValue(tls.insecure)));
  }
  setParamIfPresent(params, "pbk", stringValue(reality.public_key) || stringValue(reality.publicKey));
  setParamIfPresent(params, "sid", stringValue(reality.short_id) || stringValue(reality.shortId));

  if (protocol === "hysteria") {
    setParamIfPresent(
      params,
      "auth",
      stringValue(value.password) || stringValue(value.auth) || stringValue(value.auth_str),
    );
    setParamIfPresent(
      params,
      "udpIdleTimeout",
      stringValue(value.udp_idle_timeout) || stringValue(value.udpIdleTimeout),
    );
  }

  return streamSettingsFromParams(params);
}

function nodeFromOutbound(
  value: Record<string, unknown>,
  raw: string,
  xrayConfig?: XrayImportedConfig,
  xrayOutboundIndex?: number,
): ProxyNode | null {
  const protocol = normalizeProtocol(stringValue(value.protocol));
  if (
    protocol === "unknown" &&
    stringValue(value.protocol) !== "unknown" &&
    !xrayConfig
  ) {
    return null;
  }

  const outbound = cloneRecord(value) as XrayOutboundObject;
  outbound.protocol = protocol;
  const settings = asRecord(outbound.settings);
  const stream = asRecord(outbound.streamSettings);
  const endpoint = endpointFromSettings(protocol, settings);
  const tag = stringValue(outbound.tag);
  const name = tag || `${protocol.toUpperCase()} ${endpoint.address}`;
  const xrayConfigId = xrayConfig ? importedXrayConfigId(xrayConfig) : undefined;

  const node: ProxyNode = {
    id: stableNodeId(JSON.stringify(outbound)),
    name,
    protocol,
    address: endpoint.address,
    port: endpoint.port,
    ...(xrayConfig
      ? {}
      : {
          credential:
            credentialFromSettings(protocol, settings) ??
            credentialFromStream(protocol, stream),
        }),
    security: stringValue(stream.security) || stringValue(settings.security) || stringValue(settings.encryption),
    transport: stringValue(stream.network),
    sni: sniFromStream(stream),
    ...(xrayConfig ? {} : { outbound }),
    xrayConfigId,
    xrayOutboundIndex,
    rawUri:
      xrayConfig && xrayConfigId && xrayOutboundIndex !== undefined
        ? `${xrayConfigId}#outbound-${xrayOutboundIndex}`
        : raw,
  };
  if (xrayConfig) {
    xrayConfigTemplateByNode.set(node, xrayConfig);
  }
  node.xrayCompatibility = xrayOutboundCompatibilityForNode(node);
  return node;
}

function parseProxyUri(rawUri: string): ProxyNode | null {
  if (rawUri.startsWith("vmess://")) {
    return parseVMessUri(rawUri);
  }
  if (rawUri.startsWith("ss://")) {
    return parseShadowsocksUri(rawUri);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    return null;
  }

  const protocol = normalizeProtocol(parsed.protocol);
  switch (protocol) {
    case "vless":
    case "trojan":
      return parseVLESSOrTrojanUri(rawUri, parsed, protocol);
    case "socks":
      return parseSocksOrHTTPUri(rawUri, parsed, "socks");
    case "http":
      return parseSocksOrHTTPUri(rawUri, parsed, "http");
    case "hysteria":
      return parseHysteriaUri(rawUri, parsed);
    case "tuic":
      return parseTuicUri(rawUri, parsed);
    case "wireguard":
      return parseWireGuardUri(rawUri, parsed);
    default:
      return null;
  }
}

function parseVLESSOrTrojanUri(
  rawUri: string,
  parsed: URL,
  protocol: "vless" | "trojan",
): ProxyNode | null {
  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0) {
    return null;
  }

  const params = paramsToObject(parsed.searchParams);
  const credential = stringOrUndefined(decodeURIComponent(parsed.username));
  const streamSettings = streamSettingsFromParams(parsed.searchParams);
  let settings: Record<string, unknown>;

  if (protocol === "vless") {
    const settingsDraft: Record<string, unknown> = {
      address: parsed.hostname,
      port,
      id: credential ?? "",
      encryption: parsed.searchParams.get("encryption") || "none",
    };
    copyParam(parsed.searchParams, settingsDraft, "flow", "flow");
    settings = compactRecord(settingsDraft);
  } else {
    settings = compactRecord({
      address: parsed.hostname,
      port,
      password: credential ?? "",
    });
  }

  const outbound = compactOutbound({
    protocol,
    settings,
    streamSettings,
  });

  return nodeFromUri(rawUri, parsed, protocol, outbound, {
    credential,
    parameters: params,
  });
}

function parseVMessUri(rawUri: string): ProxyNode | null {
  const encoded = rawUri.slice("vmess://".length);
  const decoded = decodeBase64(encoded);
  if (!decoded) {
    return null;
  }
  const value = parseJSON(decoded);
  return isRecord(value) ? nodeFromVMessShare(value, rawUri) : null;
}

function nodeFromVMessShare(value: Record<string, unknown>, rawUri: string): ProxyNode | null {
  const address = stringValue(value.add) || stringValue(value.address);
  const port = parsePort(String(value.port ?? ""));
  const id = stringValue(value.id);
  if (!address || port === 0 || !id) {
    return null;
  }

  const params = recordFromEntries({
    network: stringValue(value.net),
    type: stringValue(value.type),
    host: stringValue(value.host),
    path: stringValue(value.path),
    security: stringValue(value.tls),
    sni: stringValue(value.sni),
    alpn: stringValue(value.alpn),
    fp: stringValue(value.fp),
  });
  const streamParams = new URLSearchParams(
    recordFromEntries({
      type: stringValue(value.net),
      headerType: stringValue(value.type),
      host: stringValue(value.host),
      path: stringValue(value.path),
      security: stringValue(value.tls),
      sni: stringValue(value.sni),
      alpn: stringValue(value.alpn),
      fp: stringValue(value.fp),
    }),
  );
  const outbound = compactOutbound({
    protocol: "vmess",
    settings: {
      address,
      port,
      id,
      alterId: numberValue(value.aid),
      security: stringValue(value.scy) || stringValue(value.security) || "auto",
    },
    streamSettings: streamSettingsFromParams(streamParams),
  });

  const node: ProxyNode = {
    id: stableNodeId(rawUri),
    name: stringValue(value.ps) || `VMESS ${address}`,
    protocol: "vmess",
    address,
    port,
    credential: id,
    security: stringValue(value.tls) || stringValue(value.scy) || "auto",
    transport: normalizeNetwork(stringValue(value.net)),
    sni: stringValue(value.sni) || stringValue(value.host),
    parameters: params,
    outbound,
    rawUri,
  };
  node.xrayCompatibility = xrayOutboundCompatibilityForNode(node);
  return node;
}

function parseShadowsocksUri(rawUri: string): ProxyNode | null {
  const parsedParts = parseShadowsocksAuthority(rawUri);
  if (!parsedParts) {
    return null;
  }

  const { parsed, method, password } = parsedParts;
  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0 || !method || !password) {
    return null;
  }

  const params = paramsToObject(parsed.searchParams);
  const streamSettings = shadowsocksPluginStreamSettings(parsed.searchParams);
  const outbound = compactOutbound({
    protocol: "shadowsocks",
    settings: {
      address: parsed.hostname,
      port,
      method,
      password,
    },
    streamSettings,
  });

  return nodeFromUri(rawUri, parsed, "shadowsocks", outbound, {
    credential: `${method}:${password}`,
    parameters: params,
    transport: stringOrUndefined(
      stringValue(streamSettings.network) || parsed.searchParams.get("plugin"),
    ),
  });
}

function parseSocksOrHTTPUri(
  rawUri: string,
  parsed: URL,
  protocol: "socks" | "http",
): ProxyNode | null {
  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0) {
    return null;
  }

  const user = stringOrUndefined(decodeURIComponent(parsed.username));
  const pass = stringOrUndefined(decodeURIComponent(parsed.password));
  const settings: Record<string, unknown> = {
    address: parsed.hostname,
    port,
  };
  if (user) {
    settings.user = user;
    settings.pass = pass;
  }

  const streamSettings =
    parsed.protocol === "https:" ? { security: "tls", tlsSettings: { serverName: parsed.hostname } } : {};
  const outbound = compactOutbound({ protocol, settings, streamSettings });
  return nodeFromUri(rawUri, parsed, protocol, outbound, {
    credential: user ? `${user}${pass ? ":***" : ""}` : undefined,
    parameters: paramsToObject(parsed.searchParams),
  });
}

function parseHysteriaUri(rawUri: string, parsed: URL): ProxyNode | null {
  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0) {
    return null;
  }

  const auth =
    stringOrUndefined(decodeURIComponent(parsed.username)) ??
    stringOrUndefined(parsed.searchParams.get("auth")) ??
    stringOrUndefined(parsed.searchParams.get("password"));
  const params = paramsToObject(parsed.searchParams);
  const hysteriaSettings: Record<string, unknown> = { version: 2 };
  if (auth) {
    hysteriaSettings.auth = auth;
  }
  const udpIdleTimeout = hysteriaUDPIdleTimeoutFromParams(parsed.searchParams);
  if (udpIdleTimeout !== undefined) {
    hysteriaSettings.udpIdleTimeout = udpIdleTimeout;
  }
  const streamSettings = {
    ...streamSettingsFromParams(parsed.searchParams, "hysteria"),
    network: "hysteria",
    hysteriaSettings: compactRecord(hysteriaSettings),
  };
  const outbound = compactOutbound({
    protocol: "hysteria",
    settings: {
      version: 2,
      address: parsed.hostname,
      port,
    },
    streamSettings,
  });

  return nodeFromUri(rawUri, parsed, "hysteria", outbound, {
    credential: auth,
    parameters: params,
  });
}

function parseTuicUri(rawUri: string, parsed: URL): ProxyNode | null {
  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0) {
    return null;
  }

  const [uuidFromUser, inlinePassword = ""] = decodeURIComponent(parsed.username).split(":", 2);
  const passwordFromUser = decodeURIComponent(parsed.password) || inlinePassword;
  const uuid = stringOrUndefined(parsed.searchParams.get("uuid") ?? uuidFromUser);
  const password = stringOrUndefined(
    parsed.searchParams.get("password") ?? parsed.searchParams.get("token") ?? passwordFromUser,
  );
  if (!uuid && !password) {
    return null;
  }

  const settings: Record<string, unknown> = {
    address: parsed.hostname,
    port,
    uuid,
    password,
    congestion: stringOrUndefined(
      parsed.searchParams.get("congestion") ?? parsed.searchParams.get("congestion_control"),
    ),
    udpRelayMode: stringOrUndefined(
      parsed.searchParams.get("udpRelayMode") ?? parsed.searchParams.get("udp_relay_mode"),
    ),
    reduceRtt: booleanParam(parsed.searchParams.get("reduceRtt") ?? parsed.searchParams.get("reduce_rtt")),
    zeroRttHandshake: booleanParam(
      parsed.searchParams.get("zeroRttHandshake") ?? parsed.searchParams.get("zero_rtt_handshake"),
    ),
    heartbeat: stringOrUndefined(
      parsed.searchParams.get("heartbeat") ?? parsed.searchParams.get("heartbeat_interval"),
    ),
    disableSNI: booleanParam(parsed.searchParams.get("disableSNI") ?? parsed.searchParams.get("disable_sni")),
  };
  const streamSettings = compactRecord({
    security: "tls",
    tlsSettings: tlsSettingsFromParams(parsed.searchParams),
  });
  const outbound = compactOutbound({
    protocol: "tuic",
    settings: compactRecord(settings),
    streamSettings,
  });

  return nodeFromUri(rawUri, parsed, "tuic", outbound, {
    credential: uuid ? `${uuid}${password ? ":***" : ""}` : password,
    parameters: paramsToObject(parsed.searchParams),
  });
}

function parseWireGuardUri(rawUri: string, parsed: URL): ProxyNode | null {
  const port = parsePort(parsed.port);
  const publicKey = stringOrUndefined(decodeURIComponent(parsed.username));
  const secretKey = stringOrUndefined(
    parsed.searchParams.get("secretKey") ??
      parsed.searchParams.get("privateKey") ??
      parsed.searchParams.get("private-key"),
  );
  if (!parsed.hostname || port === 0 || !publicKey || !secretKey) {
    return null;
  }

  const address = stringListFromParams(parsed.searchParams, ["address", "ip"]);
  const reserved = integerListFromParams(parsed.searchParams, ["reserved"]);
  const peer = compactRecord({
    endpoint: `${parsed.hostname}:${port}`,
    publicKey,
    preSharedKey: stringOrUndefined(
      parsed.searchParams.get("preSharedKey") ??
        parsed.searchParams.get("preshared-key") ??
        parsed.searchParams.get("pre-shared-key"),
    ),
    keepAlive: integerParam(
      parsed.searchParams.get("keepAlive") ??
        parsed.searchParams.get("keepalive") ??
        parsed.searchParams.get("keep-alive"),
    ),
    allowedIPs: stringListFromParams(parsed.searchParams, ["allowedIPs", "allowed-ips"]),
  });
  const settings: Record<string, unknown> = {
    secretKey,
    address,
    peers: [peer],
    reserved,
  };
  copyNumericParam(parsed.searchParams, settings, "mtu", "mtu");
  copyNumericParam(parsed.searchParams, settings, "workers", "workers");
  const noKernelTun = booleanParam(
    parsed.searchParams.get("noKernelTun") ?? parsed.searchParams.get("no-kernel-tun"),
  );
  if (noKernelTun !== undefined) {
    settings.noKernelTun = noKernelTun;
  }
  copyParam(parsed.searchParams, settings, "domainStrategy", "domainStrategy");

  const outbound = compactOutbound({ protocol: "wireguard", settings });
  return nodeFromUri(rawUri, parsed, "wireguard", outbound, {
    credential: publicKey,
    parameters: paramsToObject(parsed.searchParams),
  });
}

function nodeFromUri(
  rawUri: string,
  parsed: URL,
  protocol: ProxyProtocol,
  outbound: XrayOutboundObject,
  overrides: Partial<ProxyNode> = {},
): ProxyNode {
  const transport = overrides.transport ?? stringValue(outbound.streamSettings?.network);
  const security =
    overrides.security ??
    stringValue(outbound.streamSettings?.security) ??
    stringValue(outbound.settings?.security) ??
    stringValue(outbound.settings?.encryption);

  const node: ProxyNode = {
    id: stableNodeId(rawUri),
    name: nodeName(parsed, protocol, parsed.hostname),
    protocol,
    address: parsed.hostname,
    port: parsePort(parsed.port),
    credential: overrides.credential,
    security,
    transport,
    sni: overrides.sni ?? sniFromStream(asRecord(outbound.streamSettings)),
    parameters: overrides.parameters,
    outbound,
    rawUri,
  };
  node.xrayCompatibility = xrayOutboundCompatibilityForNode(node);
  return node;
}

function parseShadowsocksAuthority(rawUri: string):
  | {
      parsed: URL;
      method: string;
      password: string;
    }
  | null {
  const withoutScheme = rawUri.slice("ss://".length);
  const [beforeHash, hash = ""] = withoutScheme.split("#", 2);
  const [main, query = ""] = beforeHash.split("?", 2);

  let authority = main;
  if (!authority.includes("@")) {
    const decoded = decodeBase64(authority);
    if (!decoded) {
      return null;
    }
    authority = decoded;
  } else {
    const at = authority.lastIndexOf("@");
    const userInfo = authority.slice(0, at);
    const hostInfo = authority.slice(at + 1);
    const decodedUserInfo = userInfo.includes(":") ? userInfo : decodeBase64(userInfo) ?? userInfo;
    authority = `${decodedUserInfo}@${hostInfo}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(`ss://${authority}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`);
  } catch {
    return null;
  }

  const userInfo = `${decodeURIComponent(parsed.username)}${
    parsed.password ? `:${decodeURIComponent(parsed.password)}` : ""
  }`;
  const splitAt = userInfo.indexOf(":");
  if (splitAt < 0) {
    return null;
  }

  return {
    parsed,
    method: userInfo.slice(0, splitAt),
    password: userInfo.slice(splitAt + 1),
  };
}

function streamSettingsFromParams(
  params: URLSearchParams,
  defaultNetwork = "",
): Record<string, unknown> {
  const network = normalizeNetwork(
    params.get("type") ?? params.get("network") ?? params.get("net") ?? defaultNetwork,
  );
  const security = normalizeSecurity(params.get("security") ?? params.get("tls"));
  const stream: Record<string, unknown> = {};

  if (network) {
    stream.network = network;
    const transportSettings = transportSettingsFromParams(network, params);
    if (transportSettings) {
      stream[transportSettings.key] = transportSettings.value;
    }
  }

  if (security === "tls") {
    stream.security = "tls";
    stream.tlsSettings = tlsSettingsFromParams(params);
  } else if (security === "reality") {
    stream.security = "reality";
    stream.realitySettings = realitySettingsFromParams(params);
  }

  return compactRecord(stream);
}

function transportSettingsFromParams(
  network: string,
  params: URLSearchParams,
): { key: string; value: Record<string, unknown> } | null {
  switch (network) {
    case "raw":
      return {
        key: "rawSettings",
        value: compactRecord({
          header: rawHeaderFromParams(params),
        }),
      };
    case "websocket":
      return {
        key: "wsSettings",
        value: compactRecord({
          path: stringOrUndefined(params.get("path")),
          headers: hostHeaders(params),
          acceptProxyProtocol: booleanParam(params.get("acceptProxyProtocol")),
        }),
      };
    case "grpc":
      return {
        key: "grpcSettings",
        value: compactRecord({
          serviceName: stringOrUndefined(params.get("serviceName") ?? params.get("service")),
          authority: stringOrUndefined(params.get("authority") ?? params.get("host")),
          multiMode: booleanParam(params.get("multiMode")),
          user_agent: stringOrUndefined(params.get("user_agent") ?? params.get("userAgent")),
          idle_timeout: integerParam(params.get("idle_timeout") ?? params.get("idleTimeout")),
          health_check_timeout: integerParam(
            params.get("health_check_timeout") ?? params.get("healthCheckTimeout"),
          ),
          permit_without_stream: booleanParam(
            params.get("permit_without_stream") ?? params.get("permitWithoutStream"),
          ),
          initial_windows_size: integerParam(
            params.get("initial_windows_size") ?? params.get("initialWindowsSize"),
          ),
        }),
      };
    case "httpupgrade":
      return {
        key: "httpupgradeSettings",
        value: compactRecord({
          path: stringOrUndefined(params.get("path")),
          host: stringOrUndefined(params.get("host")),
          headers: hostHeaders(params),
          acceptProxyProtocol: booleanParam(params.get("acceptProxyProtocol")),
        }),
      };
    case "xhttp":
      return {
        key: "xhttpSettings",
        value: compactRecord({
          path: stringOrUndefined(params.get("path")),
          host: stringOrUndefined(params.get("host")),
          mode: stringOrUndefined(params.get("mode")),
          extra: jsonParam(params.get("extra")),
        }),
      };
    case "mkcp":
      return {
        key: "kcpSettings",
        value: compactRecord({
          mtu: integerParam(params.get("mtu")),
          tti: integerParam(params.get("tti")),
          uplinkCapacity: integerParam(params.get("uplinkCapacity") ?? params.get("up")),
          downlinkCapacity: integerParam(params.get("downlinkCapacity") ?? params.get("down")),
          congestion: booleanParam(params.get("congestion")),
          readBufferSize: integerParam(params.get("readBufferSize") ?? params.get("readBuffer")),
          writeBufferSize: integerParam(params.get("writeBufferSize") ?? params.get("writeBuffer")),
        }),
      };
    case "hysteria":
      return {
        key: "hysteriaSettings",
        value: compactRecord({
          version: 2,
          auth: stringOrUndefined(params.get("auth") ?? params.get("password")),
          udpIdleTimeout: hysteriaUDPIdleTimeoutFromParams(params),
        }),
      };
    default:
      return null;
  }
}

function shadowsocksPluginStreamSettings(params: URLSearchParams): Record<string, unknown> {
  const plugin = params.get("plugin");
  if (!plugin) {
    return {};
  }

  const parts = plugin.split(";").map((item) => item.trim()).filter(Boolean);
  const name = parts.shift()?.toLowerCase() ?? "";
  const pluginParams = new URLSearchParams();
  let hasTLS = false;
  for (const part of parts) {
    if (part === "tls") {
      hasTLS = true;
      continue;
    }
    const [key, ...rest] = part.split("=");
    if (!key) {
      continue;
    }
    pluginParams.set(key, rest.join("="));
  }

  if (name !== "v2ray-plugin" && name !== "xray-plugin") {
    return {};
  }

  const mode = pluginParams.get("mode")?.toLowerCase();
  if (mode === "websocket" || mode === "ws") {
    pluginParams.set("type", "ws");
  } else if (mode === "quic") {
    return {};
  }
  if (hasTLS && !pluginParams.has("security")) {
    pluginParams.set("security", "tls");
  }
  return streamSettingsFromParams(pluginParams);
}

function rawHeaderFromParams(params: URLSearchParams): Record<string, unknown> | undefined {
  const type = stringOrUndefined(params.get("headerType") ?? params.get("header"));
  const requestHost = splitList(params.get("host"));
  const requestPath = splitList(params.get("path"));
  const response = stringOrUndefined(params.get("response"));
  if (!type && !requestHost && !requestPath && !response) {
    return undefined;
  }
  return compactRecord({
    type,
    request: requestHost || requestPath
      ? compactRecord({
          headers: compactRecord({
            Host: requestHost,
          }),
          path: requestPath,
        })
      : undefined,
    response: response ? compactRecord({ version: response }) : undefined,
  });
}

function hostHeaders(params: URLSearchParams): Record<string, string> | undefined {
  const host = params.get("host");
  return host ? { Host: host } : undefined;
}

function tlsSettingsFromParams(params: URLSearchParams): Record<string, unknown> {
  return compactRecord({
    serverName: stringOrUndefined(params.get("sni") ?? params.get("peer")),
    verifyPeerCertByName: stringOrUndefined(
      params.get("verifyPeerCertByName") ?? params.get("verifyPeerCertByNames"),
    ),
    fingerprint: stringOrUndefined(params.get("fp") ?? params.get("fingerprint")),
    alpn: splitList(params.get("alpn")),
    allowInsecure: booleanParam(params.get("allowInsecure") ?? params.get("insecure")),
    minVersion: stringOrUndefined(params.get("minVersion")),
    maxVersion: stringOrUndefined(params.get("maxVersion")),
    cipherSuites: stringOrUndefined(params.get("cipherSuites")),
    disableSystemRoot: booleanParam(params.get("disableSystemRoot")),
    enableSessionResumption: booleanParam(params.get("enableSessionResumption")),
    pinnedPeerCertSha256: stringOrUndefined(
      params.get("pinnedPeerCertSha256") ?? params.get("pinnedPeerCertSHA256"),
    ),
    curvePreferences: splitList(params.get("curvePreferences")),
    masterKeyLog: stringOrUndefined(params.get("masterKeyLog")),
    echConfigList: stringOrUndefined(params.get("echConfigList") ?? params.get("ech")),
  });
}

function realitySettingsFromParams(params: URLSearchParams): Record<string, unknown> {
  return compactRecord({
    serverName: stringOrUndefined(params.get("sni") ?? params.get("peer")),
    fingerprint: stringOrUndefined(params.get("fp") ?? params.get("fingerprint")),
    password: stringOrUndefined(params.get("pbk") ?? params.get("publicKey") ?? params.get("password")),
    shortId: stringOrUndefined(params.get("sid") ?? params.get("shortId")),
    mldsa65Verify: stringOrUndefined(params.get("mldsa65Verify")),
    spiderX: stringOrUndefined(params.get("spx") ?? params.get("spiderX")),
  });
}

function compactOutbound(outbound: XrayOutboundObject): XrayOutboundObject {
  return compactRecord(outbound) as XrayOutboundObject;
}

function endpointFromSettings(
  protocol: ProxyProtocol,
  settings: Record<string, unknown>,
): { address: string; port: number } {
  if (protocol === "wireguard") {
    const peers = Array.isArray(settings.peers) ? settings.peers : [];
    const firstPeer = peers.find(isRecord);
    const endpoint = firstPeer ? stringValue(firstPeer.endpoint) : "";
    return parseEndpoint(endpoint, "wireguard", 0);
  }

  const legacyEndpoint = endpointFromLegacyServerSettings(protocol, settings);
  if (legacyEndpoint) {
    return legacyEndpoint;
  }

  return {
    address: stringValue(settings.address) || stringValue(settings.server) || protocol,
    port: numberValue(settings.port),
  };
}

function credentialFromSettings(
  protocol: ProxyProtocol,
  settings: Record<string, unknown>,
): string | undefined {
  switch (protocol) {
    case "vless":
    case "vmess":
      return stringOrUndefined(
        stringValue(settings.id) || stringValue(firstLegacyUser(settings)?.id),
      );
    case "trojan":
    case "tuic":
    case "hysteria":
      return stringOrUndefined(
        stringValue(settings.password) ||
          stringValue(settings.token) ||
          stringValue(settings.uuid) ||
          stringValue(settings.auth) ||
          stringValue(settings.authString) ||
          stringValue(firstLegacyServer(settings)?.password),
      );
    case "shadowsocks": {
      const method = stringValue(settings.method) || stringValue(firstLegacyServer(settings)?.method);
      const password =
        stringValue(settings.password) || stringValue(firstLegacyServer(settings)?.password);
      if (method && password) {
        return `${method}:${password}`;
      }
      return stringOrUndefined(password);
    }
    case "socks":
    case "http": {
      const userRecord = firstLegacyServerUser(settings);
      const user = stringValue(settings.user) || stringValue(userRecord?.user);
      const pass = stringValue(settings.pass) || stringValue(userRecord?.pass);
      return stringOrUndefined(user ? `${user}${pass ? ":***" : ""}` : "");
    }
    case "wireguard":
      return stringOrUndefined(stringValue(settings.secretKey));
    default:
      return undefined;
  }
}

function credentialFromStream(
  protocol: ProxyProtocol,
  stream: Record<string, unknown>,
): string | undefined {
  if (protocol !== "hysteria") {
    return undefined;
  }
  const hysteria = asRecord(stream.hysteriaSettings);
  return stringOrUndefined(stringValue(hysteria.auth));
}

function endpointFromLegacyServerSettings(
  protocol: ProxyProtocol,
  settings: Record<string, unknown>,
): { address: string; port: number } | null {
  if (protocol === "vless" || protocol === "vmess") {
    const firstVnext = firstRecord(settings.vnext);
    if (firstVnext) {
      const address = stringValue(firstVnext.address);
      const port = numberValue(firstVnext.port);
      if (address || port > 0) {
        return { address: address || protocol, port };
      }
    }
  }

  const firstServer = firstLegacyServer(settings);
  if (!firstServer) {
    return null;
  }
  const address = stringValue(firstServer.address) || stringValue(firstServer.server);
  const port = numberValue(firstServer.port);
  if (!address && port === 0) {
    return null;
  }
  return { address: address || protocol, port };
}

function firstLegacyServer(settings: Record<string, unknown>): Record<string, unknown> | null {
  return firstRecord(settings.servers);
}

function firstLegacyUser(settings: Record<string, unknown>): Record<string, unknown> | null {
  const firstVnext = firstRecord(settings.vnext);
  return firstVnext ? firstRecord(firstVnext.users) : null;
}

function firstLegacyServerUser(settings: Record<string, unknown>): Record<string, unknown> | null {
  const firstServer = firstLegacyServer(settings);
  return firstServer ? firstRecord(firstServer.users) : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.find(isRecord) ?? null;
}

function sniFromStream(stream: Record<string, unknown>): string | undefined {
  const tls = asRecord(stream.tlsSettings);
  const reality = asRecord(stream.realitySettings);
  return stringOrUndefined(
    stringValue(tls.serverName) ||
      stringValue(reality.serverName) ||
      stringValue(tls.verifyPeerCertByName),
  );
}

function normalizeStoredNode(
  value: unknown,
  xrayConfigTemplates: Record<string, XrayImportedConfig> = {},
): ProxyNode | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const protocol = normalizeProtocol(stringValue(value.protocol));
  const address = stringValue(value.address);
  const port = numberValue(value.port);
  const rawUri = stringValue(value.rawUri);
  if (!id || !name || protocol === "unknown" || !address || !rawUri) {
    return null;
  }
  const storedOutbound = isRecord(value.outbound)
    ? (cloneRecord(value.outbound) as XrayOutboundObject)
    : undefined;
  const legacyXrayConfig = normalizeXrayImportedConfig(value.xrayConfig);
  const xrayConfigId =
    stringValue(value.xrayConfigId) ||
    (legacyXrayConfig ? importedXrayConfigId(legacyXrayConfig) : undefined);
  if (xrayConfigId && legacyXrayConfig && !xrayConfigTemplates[xrayConfigId]) {
    xrayConfigTemplates[xrayConfigId] = legacyXrayConfig;
  }
  const xrayConfigTemplate = xrayConfigId
    ? xrayConfigTemplates[xrayConfigId]
    : undefined;
  const xrayOutboundIndex = xrayConfigTemplate
    ? storedXrayOutboundIndex(value, storedOutbound, xrayConfigTemplate, rawUri)
    : undefined;
  const reparsed = parseProxyUri(rawUri);
  const outbound =
    reparsed?.outbound && (!storedOutbound || outboundRequiresCanonicalUpgrade(protocol, storedOutbound))
      ? reparsed.outbound
      : storedOutbound;

  const node: ProxyNode = {
    id,
    name,
    protocol,
    address,
    port,
    ...(xrayOutboundIndex === undefined
      ? { credential: stringOrUndefined(stringValue(value.credential)) }
      : {}),
    security: stringOrUndefined(stringValue(value.security)),
    transport: stringOrUndefined(stringValue(value.transport)),
    sni: stringOrUndefined(stringValue(value.sni)),
    parameters: asStringRecord(value.parameters),
    ...(xrayOutboundIndex === undefined ? { outbound } : {}),
    xrayConfigId,
    xrayOutboundIndex,
    rawUri,
  };
  if (xrayConfigTemplate) {
    xrayConfigTemplateByNode.set(node, xrayConfigTemplate);
  }
  node.xrayCompatibility = xrayOutboundCompatibilityForNode(node);
  return node;
}

function outboundRequiresCanonicalUpgrade(
  protocol: ProxyProtocol,
  outbound: XrayOutboundObject,
): boolean {
  const settings = asRecord(outbound.settings);
  switch (protocol) {
    case "vless":
    case "vmess":
      return Array.isArray(settings.vnext);
    case "trojan":
    case "shadowsocks":
    case "socks":
    case "http":
      return Array.isArray(settings.servers);
    default:
      return false;
  }
}

function xrayOutboundCompatibilityForOutbound(
  outbound: XrayOutboundObject,
): XrayOutboundCompatibility {
  const stream = asRecord(outbound.streamSettings);
  const network = normalizeNetwork(stringValue(stream.network));
  const security = stringValue(stream.security);

  if (security === "reality" && !xrayRealityCompatibleNetworks.has(network)) {
    return {
      status: "unsupported-by-xray",
      reason: `Xray REALITY only works with raw, xhttp, or grpc transports; this outbound uses ${network || "no"} transport.`,
    };
  }

  if (network === "hysteria" && security !== "tls") {
    return {
      status: "unsupported-by-xray",
      reason: "Xray Hysteria outbounds require TLS; this outbound does not enable TLS.",
    };
  }

  return { status: "supported", reason: null };
}

function normalizeSubscriptionProfiles(value: unknown): SubscriptionProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles: SubscriptionProfile[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const xrayConfigTemplates = normalizeXrayConfigTemplates(item.xrayConfigTemplates);
    const nodes = Array.isArray(item.nodes)
      ? item.nodes
          .map((node) => normalizeStoredNode(node, xrayConfigTemplates))
          .filter((node): node is ProxyNode => node !== null)
      : [];
    const sourceUrl = stringValue(item.sourceUrl);
    const name = normalizeSubscriptionName(stringValue(item.name), sourceUrl);
    const id = stringValue(item.id) || subscriptionProfileId(name, sourceUrl);
    if (!id || nodes.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    profiles.push({
      id,
      name,
      sourceUrl,
      updatedAt: stringValue(item.updatedAt),
      nodes,
      ...(Object.keys(xrayConfigTemplates).length > 0
        ? { xrayConfigTemplates }
        : {}),
    });
  }
  return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

function snapshotFromProfiles(
  subscriptions: SubscriptionProfile[],
  selectedSubscriptionId: string,
  selectedNodeId: string,
): SubscriptionSnapshot {
  const profiles = normalizeSubscriptionProfiles(subscriptions);
  const active =
    profiles.find((profile) => profile.id === selectedSubscriptionId) ?? profiles[0];
  if (!active) {
    return emptySubscriptionSnapshot;
  }
  const nodeId = active.nodes.some((node) => node.id === selectedNodeId)
    ? selectedNodeId
    : active.nodes[0]?.id ?? "";
  return {
    sourceUrl: active.sourceUrl,
    updatedAt: active.updatedAt,
    nodes: active.nodes,
    selectedNodeId: nodeId,
    subscriptions: profiles,
    selectedSubscriptionId: active.id,
  };
}

function normalizeSubscriptionName(name: string, sourceUrl: string): string {
  const cleaned = name.trim();
  if (cleaned) {
    return cleaned;
  }
  if (sourceUrl === "manual") {
    return "Manual";
  }
  try {
    const url = new URL(sourceUrl);
    const pathSegments = safeDecodeURIComponent(url.pathname)
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const pathName = pathSegments[pathSegments.length - 1];
    return pathName || url.hostname || "Subscription";
  } catch {
    return "Subscription";
  }
}

function subscriptionProfileId(name: string, sourceUrl: string): string {
  return `sub-${stableNodeId(`${name}\n${sourceUrl}`).replace(/^node-/, "")}`;
}

function normalizeProtocol(protocol: string): ProxyProtocol {
  const value = protocol.replace(/:$/, "").toLowerCase();
  const aliases: Record<string, ProxyProtocol> = {
    ss: "shadowsocks",
    socks4: "socks",
    socks5: "socks",
    https: "http",
    hy2: "hysteria",
    hysteria2: "hysteria",
    "trojan-go": "trojan",
    wg: "wireguard",
  };
  const normalized = aliases[value] ?? value;
  return retainedProxyProtocols.has(normalized as ProxyProtocol)
    ? (normalized as ProxyProtocol)
    : "unknown";
}

function normalizeNetwork(value: string | null): string {
  const normalized = (value ?? "").replace(/:$/, "").toLowerCase();
  const aliases: Record<string, string> = {
    tcp: "raw",
    ws: "websocket",
    kcp: "mkcp",
    h2: "xhttp",
    http2: "xhttp",
    http: "xhttp",
    splithttp: "xhttp",
    httpupgrade: "httpupgrade",
    hu: "httpupgrade",
    hy2: "hysteria",
    hysteria2: "hysteria",
    quic: "",
  };
  return aliases[normalized] ?? normalized;
}

function normalizeSecurity(value: string | null): "" | "none" | "tls" | "reality" {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return "tls";
  }
  if (normalized === "tls" || normalized === "reality" || normalized === "none") {
    return normalized;
  }
  return "";
}

function nodeName(parsed: URL, protocol: ProxyProtocol, fallbackHost: string): string {
  const name = safeDecodeURIComponent(parsed.hash.replace(/^#/, "")).trim();
  if (name) {
    return name;
  }
  return `${protocol.toUpperCase()} ${fallbackHost}`;
}

function parseEndpoint(
  endpoint: string,
  fallbackAddress: string,
  fallbackPort: number,
): { address: string; port: number } {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return { address: fallbackAddress, port: fallbackPort };
  }
  const bracketMatch = /^\[([^\]]+)]:(\d+)$/.exec(trimmed);
  if (bracketMatch) {
    return { address: bracketMatch[1], port: parsePort(bracketMatch[2]) };
  }
  const splitAt = trimmed.lastIndexOf(":");
  if (splitAt > 0) {
    return {
      address: trimmed.slice(0, splitAt),
      port: parsePort(trimmed.slice(splitAt + 1)),
    };
  }
  return { address: trimmed, port: fallbackPort };
}

function headerValue(headers: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(headers[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return booleanParam(value);
  }
  return undefined;
}

function stringListValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => stringValue(item).trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return splitList(stringValue(value));
}

function numberListValue(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "number" ? item : Number.parseInt(stringValue(item), 10)))
      .filter((item) => Number.isInteger(item));
    return items.length > 0 ? items : undefined;
  }
  return integerList(stringValue(value));
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function paramsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

function recordFromEntries(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

function copyParam(
  params: URLSearchParams,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  const value = stringOrUndefined(params.get(sourceKey));
  if (value) {
    target[targetKey] = value;
  }
}

function copyNumericParam(
  params: URLSearchParams,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  const value = Number.parseInt(params.get(sourceKey) ?? "", 10);
  if (Number.isInteger(value)) {
    target[targetKey] = value;
  }
}

function integerParam(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function jsonParam(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  return parseJSON(value) ?? undefined;
}

function stringOrUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanParam(value: string | null): boolean | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function hysteriaUDPIdleTimeoutFromParams(params: URLSearchParams): number | undefined {
  return durationSecondsParam(params.get("udpIdleTimeout") ?? params.get("udp_idle_timeout"));
}

function durationSecondsParam(value: string | null): number | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+)(ms|s|m)?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    return undefined;
  }
  switch (match[2]) {
    case "ms":
      return Math.max(1, Math.ceil(amount / 1000));
    case "m":
      return amount * 60;
    default:
      return amount;
  }
}

function splitList(value: string | null): string[] | undefined {
  const raw = value?.trim();
  const body = raw?.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const items = body
    ?.split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function integerList(value: string | null): number[] | undefined {
  const items = splitList(value)
    ?.map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item));
  return items && items.length > 0 ? items : undefined;
}

function stringListFromParams(
  params: URLSearchParams,
  keys: string[],
): string[] | undefined {
  const items = keys.flatMap((key) =>
    params.getAll(key).flatMap((value) => splitList(value) ?? []),
  );
  return items.length > 0 ? items : undefined;
}

function integerListFromParams(
  params: URLSearchParams,
  keys: string[],
): number[] | undefined {
  const items = keys.flatMap((key) =>
    params.getAll(key).flatMap((value) => integerList(value) ?? []),
  );
  return items.length > 0 ? items : undefined;
}

function decodeBase64(value: string): string | null {
  try {
    const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseJSON(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stableNodeId(raw: string): string {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `node-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parsePort(value);
  }
  return 0;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === "" || item === null) {
      continue;
    }
    if (isRecord(item)) {
      const compacted = compactRecord(item);
      if (Object.keys(compacted).length > 0) {
        out[key] = compacted;
      }
      continue;
    }
    out[key] = item;
  }
  return out as T;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function importedXrayConfigId(value: XrayImportedConfig): string {
  return `xray-config-${stableNodeId(JSON.stringify(value)).replace(/^node-/, "")}`;
}

function profileXrayConfigTemplates(
  nodes: ProxyNode[],
): Pick<SubscriptionProfile, "xrayConfigTemplates"> {
  const xrayConfigTemplates: Record<string, XrayImportedConfig> = {};
  for (const node of nodes) {
    const template = xrayConfigTemplateByNode.get(node);
    if (!node.xrayConfigId || !template) {
      continue;
    }
    if (!xrayConfigTemplates[node.xrayConfigId]) {
      xrayConfigTemplates[node.xrayConfigId] = cloneRecord(template) as XrayImportedConfig;
    }
    xrayConfigTemplateByNode.set(node, xrayConfigTemplates[node.xrayConfigId]);
  }
  return Object.keys(xrayConfigTemplates).length > 0
    ? { xrayConfigTemplates }
    : {};
}

function xrayOutboundTemplateForNode(
  node: ProxyNode,
): XrayOutboundObject | undefined {
  const template = xrayConfigTemplateByNode.get(node);
  if (!template || !Number.isInteger(node.xrayOutboundIndex)) {
    return undefined;
  }
  const outbound = Array.isArray(template.outbounds)
    ? template.outbounds[node.xrayOutboundIndex!]
    : undefined;
  return isRecord(outbound)
    ? (cloneRecord(outbound) as XrayOutboundObject)
    : undefined;
}

function storedXrayOutboundIndex(
  value: Record<string, unknown>,
  storedOutbound: XrayOutboundObject | undefined,
  template: XrayImportedConfig,
  rawUri: string,
): number | undefined {
  const outbounds = Array.isArray(template.outbounds) ? template.outbounds : [];
  const explicitIndex = value.xrayOutboundIndex;
  if (
    typeof explicitIndex === "number" &&
    Number.isInteger(explicitIndex) &&
    explicitIndex >= 0 &&
    isRecord(outbounds[explicitIndex])
  ) {
    return explicitIndex;
  }
  const rawIndex = Number.parseInt(rawUri.match(/#outbound-(\d+)$/)?.[1] ?? "", 10);
  if (Number.isInteger(rawIndex) && isRecord(outbounds[rawIndex])) {
    return rawIndex;
  }
  if (!storedOutbound) {
    return undefined;
  }
  const serialized = JSON.stringify(storedOutbound);
  const exactIndex = outbounds.findIndex(
    (outbound) => isRecord(outbound) && JSON.stringify(outbound) === serialized,
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }
  const tag = stringValue(storedOutbound.tag);
  const taggedIndex = tag
    ? outbounds.findIndex(
        (outbound) => isRecord(outbound) && stringValue(outbound.tag) === tag,
      )
    : -1;
  return taggedIndex >= 0 ? taggedIndex : undefined;
}

function normalizeXrayConfigTemplates(
  value: unknown,
): Record<string, XrayImportedConfig> {
  if (!isRecord(value)) {
    return {};
  }
  const templates: Record<string, XrayImportedConfig> = {};
  for (const [id, template] of Object.entries(value)) {
    const normalized = normalizeXrayImportedConfig(template);
    if (id && normalized) {
      templates[id] = normalized;
    }
  }
  return templates;
}

function xrayImportedConfigFromJSON(value: Record<string, unknown>): XrayImportedConfig | undefined {
  return Array.isArray(value.outbounds) && value.outbounds.some(
    (outbound) => isRecord(outbound) && typeof outbound.protocol === "string",
  )
    ? (cloneRecord(value) as XrayImportedConfig)
    : undefined;
}

function normalizeXrayImportedConfig(value: unknown): XrayImportedConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return cloneRecord(value) as XrayImportedConfig;
}

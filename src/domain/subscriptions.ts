import { invokeDesktop } from "./tauri";

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

export type ProxyProtocol = XrayOutboundProtocol;

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
  rawUri: string;
}

export interface SubscriptionProfile {
  id: string;
  name: string;
  sourceUrl: string;
  updatedAt: string;
  nodes: ProxyNode[];
}

export interface SubscriptionSnapshot {
  sourceUrl: string;
  updatedAt: string;
  nodes: ProxyNode[];
  selectedNodeId: string;
  subscriptions: SubscriptionProfile[];
  selectedSubscriptionId: string;
}

const storageKey = "tachyon.prism.subscription.v1";

const xrayOutboundProtocols = new Set<XrayOutboundProtocol>([
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
    throw new Error("Subscription URL is required");
  }

  return parseSubscription(await fetchSubscriptionText(url));
}

export async function fetchSubscriptionText(sourceUrl: string): Promise<string> {
  const url = sourceUrl.trim();
  if (!url) {
    throw new Error("Subscription URL is required");
  }

  try {
    return await invokeDesktop<string>("fetch_subscription_text", { sourceUrl: url });
  } catch {
    const response = await fetch(url, {
      headers: {
        accept: "text/plain, application/json, application/octet-stream, */*",
      },
    });
    if (!response.ok) {
      throw new Error(`Subscription fetch failed: ${response.status}`);
    }
    return response.text();
  }
}

export function parseSubscription(input: string): ProxyNode[] {
  const seen = new Set<string>();
  const nodes: ProxyNode[] = [];

  for (const payload of subscriptionPayloadCandidates(input)) {
    for (const node of parsePayload(payload)) {
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      nodes.push(node);
    }
  }

  return nodes;
}

export function createSubscriptionSnapshot(
  sourceUrl: string,
  nodes: ProxyNode[],
  previous: SubscriptionSnapshot = emptySubscriptionSnapshot,
  name = "",
): SubscriptionSnapshot {
  if (nodes.length === 0) {
    throw new Error("No supported nodes found");
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
    throw new Error("Subscription no longer exists");
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
  const subscription = snapshot.subscriptions.find((item) =>
    item.nodes.some((node) => node.id === nodeId),
  );
  if (!subscription) {
    throw new Error("Selected node no longer exists");
  }
  return snapshotFromProfiles(snapshot.subscriptions, subscription.id, nodeId);
}

export function buildXrayOutboundDraft(node: ProxyNode): XrayOutboundObject {
  if (node.outbound) {
    return cloneRecord(node.outbound) as XrayOutboundObject;
  }
  throw new Error("Node does not contain an Xray outbound draft");
}

export function loadSubscriptionSnapshot(): SubscriptionSnapshot {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) {
      return emptySubscriptionSnapshot;
    }

    const snapshot = JSON.parse(raw) as Partial<SubscriptionSnapshot>;
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

    const nodes = Array.isArray(snapshot.nodes)
      ? snapshot.nodes.map(normalizeStoredNode).filter((node): node is ProxyNode => node !== null)
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

export function saveSubscriptionSnapshot(snapshot: SubscriptionSnapshot): void {
  globalThis.localStorage?.setItem(storageKey, JSON.stringify(snapshot));
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
    streamSettings: clashStreamSettings(record),
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
      return {
        vnext: [
          {
            address,
            port,
            users: [
              compactRecord({
                id: clashValue(record, ["uuid", "id"]),
                encryption: clashValue(record, ["encryption"]) || "none",
                flow: clashValue(record, ["flow"]),
              }),
            ],
          },
        ],
      };
    case "vmess":
      return {
        vnext: [
          {
            address,
            port,
            users: [
              compactRecord({
                id: clashValue(record, ["uuid", "id"]),
                security: clashValue(record, ["cipher", "security"]) || "auto",
              }),
            ],
          },
        ],
      };
    case "trojan":
      return {
        servers: [
          compactRecord({
            address,
            port,
            password: clashValue(record, ["password"]),
          }),
        ],
      };
    case "shadowsocks":
      return {
        servers: [
          compactRecord({
            address,
            port,
            method: clashValue(record, ["cipher", "method"]),
            password: clashValue(record, ["password"]),
          }),
        ],
      };
    case "hysteria":
      return compactRecord({
        version: clashValue(record, ["type"]).toLowerCase() === "hysteria" ? 1 : 2,
        address,
        port,
        auth: clashValue(record, ["auth", "auth-str", "password"]),
      });
    case "socks":
    case "http": {
      const user = clashValue(record, ["username", "user"]);
      const pass = clashValue(record, ["password", "pass"]);
      const server: Record<string, unknown> = { address, port };
      if (user) {
        server.users = [compactRecord({ user, pass })];
      }
      return {
        servers: [compactRecord(server)],
      };
    }
    case "wireguard":
      return compactRecord({
        secretKey: clashValue(record, ["private-key", "secret-key", "secretKey"]),
        address: splitList(clashValue(record, ["ip", "address"])),
        peers: [
          compactRecord({
            endpoint: `${address}:${port}`,
            publicKey: clashValue(record, ["public-key", "publicKey"]),
          }),
        ],
      });
    default:
      return compactRecord({ address, port });
  }
}

function clashStreamSettings(record: Record<string, string>): Record<string, unknown> {
  const params = new URLSearchParams();
  const network = clashValue(record, ["network", "net"]);
  if (network) {
    params.set("type", network);
  }

  const hasReality =
    clashValue(record, ["reality-opts.public-key", "reality-opts.publicKey", "pbk"]) !== "";
  if (hasReality) {
    params.set("security", "reality");
  } else if (clashBoolean(record, ["tls"]) || clashValue(record, ["security"]) === "tls") {
    params.set("security", "tls");
  }

  setParamIfPresent(params, "sni", clashValue(record, ["sni", "servername", "serverName"]));
  setParamIfPresent(params, "fp", clashValue(record, ["client-fingerprint", "fingerprint", "fp"]));
  setParamIfPresent(params, "alpn", clashValue(record, ["alpn"]));
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
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    } else if (!quote && char === "{") {
      depth += 1;
    } else if (!quote && char === "}") {
      depth -= 1;
    } else if (!quote && depth === 0 && char === ",") {
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

  if (Array.isArray(value.outbounds)) {
    return value.outbounds.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const node = nodeFromOutbound(item, `${raw}#outbound-${index}`);
      return node ? [node] : [];
    });
  }

  if (isRecord(value.outbound)) {
    const node = nodeFromOutbound(value.outbound, raw);
    return node ? [node] : [];
  }

  if (typeof value.protocol === "string") {
    const node = nodeFromOutbound(value, raw);
    return node ? [node] : [];
  }

  const vmessNode = nodeFromVMessShare(value, raw);
  return vmessNode ? [vmessNode] : [];
}

function nodeFromOutbound(value: Record<string, unknown>, raw: string): ProxyNode | null {
  const protocol = normalizeProtocol(stringValue(value.protocol));
  if (protocol === "unknown" && stringValue(value.protocol) !== "unknown") {
    return null;
  }

  const outbound = cloneRecord(value) as XrayOutboundObject;
  outbound.protocol = protocol;
  const settings = asRecord(outbound.settings);
  const stream = asRecord(outbound.streamSettings);
  const endpoint = endpointFromSettings(protocol, settings);
  const tag = stringValue(outbound.tag);
  const name = tag || `${protocol.toUpperCase()} ${endpoint.address}`;

  return {
    id: stableNodeId(JSON.stringify(outbound)),
    name,
    protocol,
    address: endpoint.address,
    port: endpoint.port,
    credential: credentialFromSettings(protocol, settings),
    security: stringValue(stream.security) || stringValue(settings.security) || stringValue(settings.encryption),
    transport: stringValue(stream.network),
    sni: sniFromStream(stream),
    outbound,
    rawUri: raw,
  };
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
    const user: Record<string, unknown> = {
      id: credential ?? "",
      encryption: parsed.searchParams.get("encryption") || "none",
    };
    copyParam(parsed.searchParams, user, "flow", "flow");
    settings = {
      vnext: [
        {
          address: parsed.hostname,
          port,
          users: [compactRecord(user)],
        },
      ],
    };
  } else {
    settings = {
      servers: [
        {
          address: parsed.hostname,
          port,
          password: credential ?? "",
        },
      ],
    };
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
  const searchParams = new URLSearchParams(params);
  const outbound = compactOutbound({
    protocol: "vmess",
    settings: {
      vnext: [
        {
          address,
          port,
          users: [
            compactRecord({
              id,
              alterId: numberValue(value.aid),
              security: stringValue(value.scy) || stringValue(value.security) || "auto",
            }),
          ],
        },
      ],
    },
    streamSettings: streamSettingsFromParams(searchParams),
  });

  return {
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
  const outbound = compactOutbound({
    protocol: "shadowsocks",
    settings: {
      servers: [
        {
          address: parsed.hostname,
          port,
          method,
          password,
        },
      ],
    },
  });

  return nodeFromUri(rawUri, parsed, "shadowsocks", outbound, {
    credential: `${method}:${password}`,
    parameters: params,
    transport: parsed.searchParams.get("plugin") ?? undefined,
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
  const server: Record<string, unknown> = {
    address: parsed.hostname,
    port,
  };
  if (user) {
    server.users = [
      compactRecord({
        user,
        pass,
      }),
    ];
  }
  const settings: Record<string, unknown> = {
    servers: [compactRecord(server)],
  };

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
  const streamSettings = {
    ...streamSettingsFromParams(parsed.searchParams, "hysteria"),
    network: "hysteria",
    hysteriaSettings,
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

function parseWireGuardUri(rawUri: string, parsed: URL): ProxyNode | null {
  const port = parsePort(parsed.port);
  const publicKey = stringOrUndefined(decodeURIComponent(parsed.username));
  const secretKey = stringOrUndefined(parsed.searchParams.get("secretKey"));
  if (!parsed.hostname || port === 0 || !publicKey || !secretKey) {
    return null;
  }

  const address = parsed.searchParams.getAll("address");
  const reserved = parsed.searchParams
    .getAll("reserved")
    .flatMap((value) => value.split(","))
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value));
  const settings: Record<string, unknown> = {
    secretKey,
    address: address.length > 0 ? address : undefined,
    peers: [
      {
        endpoint: `${parsed.hostname}:${port}`,
        publicKey,
      },
    ],
  };
  if (reserved.length > 0) {
    settings.reserved = reserved;
  }
  copyNumericParam(parsed.searchParams, settings, "mtu", "mtu");
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

  return {
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
    case "websocket":
      return {
        key: "wsSettings",
        value: compactRecord({
          path: stringOrUndefined(params.get("path")),
          headers: params.get("host") ? { Host: params.get("host") } : undefined,
        }),
      };
    case "grpc":
      return {
        key: "grpcSettings",
        value: compactRecord({
          serviceName: stringOrUndefined(params.get("serviceName") ?? params.get("service")),
          authority: stringOrUndefined(params.get("authority") ?? params.get("host")),
        }),
      };
    case "httpupgrade":
      return {
        key: "httpupgradeSettings",
        value: compactRecord({
          path: stringOrUndefined(params.get("path")),
          host: stringOrUndefined(params.get("host")),
        }),
      };
    case "xhttp":
      return {
        key: "xhttpSettings",
        value: compactRecord({
          path: stringOrUndefined(params.get("path")),
          host: stringOrUndefined(params.get("host")),
          mode: stringOrUndefined(params.get("mode")),
        }),
      };
    case "mkcp":
      return {
        key: "kcpSettings",
        value: compactRecord({
          header: params.get("headerType") ?? params.get("type")
            ? { type: params.get("headerType") ?? params.get("type") }
            : undefined,
          seed: stringOrUndefined(params.get("seed")),
        }),
      };
    case "hysteria":
      return {
        key: "hysteriaSettings",
        value: compactRecord({
          version: 2,
          auth: stringOrUndefined(params.get("auth") ?? params.get("password")),
        }),
      };
    default:
      return null;
  }
}

function tlsSettingsFromParams(params: URLSearchParams): Record<string, unknown> {
  return compactRecord({
    serverName: stringOrUndefined(params.get("sni") ?? params.get("peer")),
    fingerprint: stringOrUndefined(params.get("fp") ?? params.get("fingerprint")),
    alpn: splitList(params.get("alpn")),
    allowInsecure: booleanParam(params.get("allowInsecure") ?? params.get("insecure")),
  });
}

function realitySettingsFromParams(params: URLSearchParams): Record<string, unknown> {
  return compactRecord({
    serverName: stringOrUndefined(params.get("sni") ?? params.get("peer")),
    fingerprint: stringOrUndefined(params.get("fp") ?? params.get("fingerprint")),
    publicKey: stringOrUndefined(params.get("pbk") ?? params.get("publicKey")),
    shortId: stringOrUndefined(params.get("sid") ?? params.get("shortId")),
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
    case "hysteria":
      return stringOrUndefined(
        stringValue(settings.password) ||
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

function normalizeStoredNode(value: unknown): ProxyNode | null {
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
  const reparsed = parseProxyUri(rawUri);
  const outbound =
    reparsed?.outbound && (!storedOutbound || outboundRequiresCanonicalUpgrade(protocol, storedOutbound))
      ? reparsed.outbound
      : storedOutbound;

  return {
    id,
    name,
    protocol,
    address,
    port,
    credential: stringOrUndefined(stringValue(value.credential)),
    security: stringOrUndefined(stringValue(value.security)),
    transport: stringOrUndefined(stringValue(value.transport)),
    sni: stringOrUndefined(stringValue(value.sni)),
    parameters: asStringRecord(value.parameters),
    outbound,
    rawUri,
  };
}

function outboundRequiresCanonicalUpgrade(
  protocol: ProxyProtocol,
  outbound: XrayOutboundObject,
): boolean {
  const settings = asRecord(outbound.settings);
  switch (protocol) {
    case "vless":
    case "vmess":
      return "address" in settings || "id" in settings || !Array.isArray(settings.vnext);
    case "trojan":
    case "shadowsocks":
    case "socks":
    case "http":
      return "address" in settings || "server" in settings || !Array.isArray(settings.servers);
    default:
      return false;
  }
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
    const nodes = Array.isArray(item.nodes)
      ? item.nodes.map(normalizeStoredNode).filter((node): node is ProxyNode => node !== null)
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
    wg: "wireguard",
  };
  const normalized = aliases[value] ?? value;
  return xrayOutboundProtocols.has(normalized as XrayOutboundProtocol)
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

function splitList(value: string | null): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
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

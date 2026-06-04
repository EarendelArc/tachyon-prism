export type ProxyProtocol = "vless" | "trojan" | "ss" | "unknown";

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
  rawUri: string;
}

export interface SubscriptionSnapshot {
  sourceUrl: string;
  updatedAt: string;
  nodes: ProxyNode[];
  selectedNodeId: string;
}

export interface CoreProxyConfigDraft {
  server_addr: string;
  vless_uuid: string;
  sni?: string;
}

const storageKey = "tachyon.prism.subscription.v1";

export const emptySubscriptionSnapshot: SubscriptionSnapshot = {
  sourceUrl: "",
  updatedAt: "",
  nodes: [],
  selectedNodeId: "",
};

export async function fetchSubscriptionNodes(sourceUrl: string): Promise<ProxyNode[]> {
  const url = sourceUrl.trim();
  if (!url) {
    throw new Error("Subscription URL is required");
  }

  const response = await fetch(url, {
    headers: {
      accept: "text/plain, application/octet-stream, */*",
    },
  });
  if (!response.ok) {
    throw new Error(`Subscription fetch failed: ${response.status}`);
  }
  return parseSubscription(await response.text());
}

export function parseSubscription(input: string): ProxyNode[] {
  const payload = decodeSubscriptionPayload(input);
  const seen = new Set<string>();
  const nodes: ProxyNode[] = [];

  for (const line of payload.split(/\r?\n/)) {
    const rawUri = line.trim();
    if (!rawUri || rawUri.startsWith("#")) {
      continue;
    }

    const node = parseProxyUri(rawUri);
    if (!node || seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    nodes.push(node);
  }

  return nodes;
}

export function createSubscriptionSnapshot(
  sourceUrl: string,
  nodes: ProxyNode[],
  previous: SubscriptionSnapshot = emptySubscriptionSnapshot,
): SubscriptionSnapshot {
  if (nodes.length === 0) {
    throw new Error("No supported nodes found");
  }

  const selectedNodeId = nodes.some((node) => node.id === previous.selectedNodeId)
    ? previous.selectedNodeId
    : nodes[0]?.id ?? "";

  return {
    sourceUrl: sourceUrl.trim(),
    updatedAt: new Date().toISOString(),
    nodes,
    selectedNodeId,
  };
}

export function selectSubscriptionNode(
  snapshot: SubscriptionSnapshot,
  nodeId: string,
): SubscriptionSnapshot {
  if (!snapshot.nodes.some((node) => node.id === nodeId)) {
    throw new Error("Selected node no longer exists");
  }
  return {
    ...snapshot,
    selectedNodeId: nodeId,
  };
}

export function buildCoreProxyConfigDraft(node: ProxyNode): CoreProxyConfigDraft {
  if (node.protocol !== "vless") {
    throw new Error("Only VLESS nodes can be exported to Core proxy config");
  }
  if (!node.credential) {
    throw new Error("VLESS node is missing UUID");
  }

  return {
    server_addr: `${node.address}:${node.port}`,
    vless_uuid: node.credential,
    sni: node.sni ?? node.address,
  };
}

export function loadSubscriptionSnapshot(): SubscriptionSnapshot {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) {
      return emptySubscriptionSnapshot;
    }

    const snapshot = JSON.parse(raw) as Partial<SubscriptionSnapshot>;
    const nodes = Array.isArray(snapshot.nodes)
      ? snapshot.nodes.filter(isProxyNode)
      : [];
    return {
      sourceUrl: typeof snapshot.sourceUrl === "string" ? snapshot.sourceUrl : "",
      updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : "",
      nodes,
      selectedNodeId:
        typeof snapshot.selectedNodeId === "string" &&
        nodes.some((node) => node.id === snapshot.selectedNodeId)
          ? snapshot.selectedNodeId
          : nodes[0]?.id ?? "",
    };
  } catch {
    return emptySubscriptionSnapshot;
  }
}

export function saveSubscriptionSnapshot(snapshot: SubscriptionSnapshot): void {
  globalThis.localStorage?.setItem(storageKey, JSON.stringify(snapshot));
}

function decodeSubscriptionPayload(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("://")) {
    return trimmed;
  }

  const decoded = decodeBase64(trimmed);
  if (decoded?.includes("://")) {
    return decoded;
  }

  return trimmed;
}

function parseProxyUri(rawUri: string): ProxyNode | null {
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
  if (protocol !== "vless" && protocol !== "trojan") {
    return null;
  }

  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0) {
    return null;
  }

  return {
    id: stableNodeId(rawUri),
    name: nodeName(parsed, protocol, parsed.hostname),
    protocol,
    address: parsed.hostname,
    port,
    credential: stringOrUndefined(decodeURIComponent(parsed.username)),
    security: stringOrUndefined(parsed.searchParams.get("security")),
    transport: stringOrUndefined(
      parsed.searchParams.get("type") ?? parsed.searchParams.get("transport"),
    ),
    sni: stringOrUndefined(
      parsed.searchParams.get("sni") ?? parsed.searchParams.get("peer"),
    ),
    rawUri,
  };
}

function parseShadowsocksUri(rawUri: string): ProxyNode | null {
  const withoutScheme = rawUri.slice("ss://".length);
  const [mainWithQuery, hash = ""] = withoutScheme.split("#", 2);
  const [main] = mainWithQuery.split("?", 1);

  if (!main.includes("@")) {
    const decoded = decodeBase64(main);
    if (!decoded) {
      return null;
    }
    return parseShadowsocksUri(`ss://${decoded}${hash ? `#${hash}` : ""}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    return null;
  }

  const port = parsePort(parsed.port);
  if (!parsed.hostname || port === 0) {
    return null;
  }

  return {
    id: stableNodeId(rawUri),
    name: nodeName(parsed, "ss", parsed.hostname),
    protocol: "ss",
    address: parsed.hostname,
    port,
    credential: shadowsocksCredential(parsed),
    transport: stringOrUndefined(parsed.searchParams.get("plugin")),
    rawUri,
  };
}

function normalizeProtocol(protocol: string): ProxyProtocol {
  const value = protocol.replace(/:$/, "").toLowerCase();
  if (value === "vless" || value === "trojan" || value === "ss") {
    return value;
  }
  return "unknown";
}

function nodeName(parsed: URL, protocol: ProxyProtocol, fallbackHost: string): string {
  const name = decodeURIComponent(parsed.hash.replace(/^#/, "")).trim();
  if (name) {
    return name;
  }
  return `${protocol.toUpperCase()} ${fallbackHost}`;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function stringOrUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function shadowsocksCredential(parsed: URL): string | undefined {
  const username = decodeURIComponent(parsed.username).trim();
  const password = decodeURIComponent(parsed.password).trim();
  if (!username && !password) {
    return undefined;
  }
  return password ? `${username}:${password}` : username;
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

function stableNodeId(rawUri: string): string {
  let hash = 2166136261;
  for (let index = 0; index < rawUri.length; index += 1) {
    hash ^= rawUri.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `node-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isProxyNode(value: unknown): value is ProxyNode {
  if (!value || typeof value !== "object") {
    return false;
  }

  const node = value as Partial<ProxyNode>;
  return (
    typeof node.id === "string" &&
    typeof node.name === "string" &&
    typeof node.protocol === "string" &&
    typeof node.address === "string" &&
    typeof node.port === "number" &&
    typeof node.rawUri === "string"
  );
}

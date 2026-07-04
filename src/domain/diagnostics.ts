import type {
  CoreReleaseDiagnostics,
  LocalProxyProbeReport,
  ManagedBinaryInventory,
  ManagedBinaryKind,
  ProcessStatus,
  RuntimeSettings,
  RuntimeStatus,
} from "./runtime";
import type { ProxyNode, SubscriptionSnapshot } from "./subscriptions";

export const prismVersion = "0.1.0";

export interface ClientDiagnosticsInput {
  generatedAt?: string;
  managedBinaries: ManagedBinaryInventory | null;
  platform: string;
  releaseDiagnostics: Partial<Record<ManagedBinaryKind, CoreReleaseDiagnostics>>;
  recentErrors: string[];
  runtimeSettings: RuntimeSettings;
  runtimeStatus: RuntimeStatus | null;
  selectedNode: ProxyNode | undefined;
  subscription: SubscriptionSnapshot;
  userAgent: string;
  version?: string;
  xrayLocalProxyProbe: LocalProxyProbeReport | null;
}

export interface ClientDiagnosticsExport {
  schemaVersion: 1;
  generatedAt: string;
  safety: {
    readOnly: true;
    noSpawn: true;
    noSystemProxy: true;
    noTun: true;
    redaction: string[];
  };
  prism: {
    version: string;
    platform: string;
    userAgent: string;
  };
  runtime: {
    releaseChannels: Record<ManagedBinaryKind, "stable" | "preview">;
    paths: Record<ManagedBinaryKind, DiagnosticsBinaryPath>;
    status: Record<ManagedBinaryKind, DiagnosticsProcessStatus> | null;
  };
  releaseDiagnostics: Record<ManagedBinaryKind, DiagnosticsReleaseSummary>;
  subscriptions: {
    activeGroup: string | null;
    groups: DiagnosticsSubscriptionGroup[];
    protocolCounts: Record<string, number>;
    totalGroups: number;
    totalNodes: number;
  };
  selectedNode: DiagnosticsNodeSummary | null;
  localProxyProbe: LocalProxyProbeReport | null;
  recentErrors: string[];
}

interface DiagnosticsBinaryPath {
  configuredPath: string;
  configuredExists: boolean | null;
  installedPath: string;
  installedExists: boolean | null;
  managedPath: string;
  managedExists: boolean | null;
}

interface DiagnosticsProcessStatus {
  state: string;
  pid: number | null;
  binaryPath: string | null;
  configPath: string | null;
  lastError: string | null;
}

interface DiagnosticsReleaseSummary {
  assetName: string | null;
  checksumMatch: boolean | null;
  displayName: string;
  installedExists: boolean;
  installedPath: string;
  installedVersionStatus: string;
  lastError: string | null;
  resolvedTag: string | null;
  selectedChannel: "stable" | "preview";
}

interface DiagnosticsSubscriptionGroup {
  name: string;
  nodeCount: number;
  protocolCounts: Record<string, number>;
  sourceUrl: string;
  updatedAt: string;
}

interface DiagnosticsNodeSummary {
  address: string;
  credentialPresent: boolean;
  name: string;
  port: number;
  protocol: string;
  rawUriScheme: string;
  security: string | null;
  sni: string | null;
  transport: string | null;
}

const redacted = "[redacted]";
const sensitiveKeyPattern =
  /(^|[_-])(auth|credential|id|password|pass|private|privatekey|psk|secret|secretkey|shortid|token|uuid)([_-]|$)/i;
const uuidPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const privateKeyPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const inlineSecretPattern =
  /\b(auth|credential|password|passwd|privateKey|private key|psk|secret|token|uuid)\s*[:= ]\s*[^,\s;]+/gi;
const opaqueTokenPattern = /\b[A-Za-z0-9_-]{24,}\b/g;

export function buildClientDiagnosticsExport(
  input: ClientDiagnosticsInput,
): ClientDiagnosticsExport {
  const version = input.version?.trim() || prismVersion;
  const releaseDiagnostics = {
    tachyonCore: releaseSummary(
      input.releaseDiagnostics.tachyonCore,
      "tachyonCore",
      input.runtimeSettings,
    ),
    xray: releaseSummary(input.releaseDiagnostics.xray, "xray", input.runtimeSettings),
  };

  return redactDiagnosticsValue({
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    localProxyProbe: input.xrayLocalProxyProbe,
    prism: {
      platform: input.platform,
      userAgent: input.userAgent,
      version,
    },
    recentErrors: uniqueErrors(input.recentErrors),
    releaseDiagnostics,
    runtime: {
      paths: {
        tachyonCore: binaryPathSummary("tachyonCore", input),
        xray: binaryPathSummary("xray", input),
      },
      releaseChannels: {
        tachyonCore: input.runtimeSettings.tachyonCoreReleaseChannel,
        xray: input.runtimeSettings.xrayReleaseChannel,
      },
      status: input.runtimeStatus
        ? {
            tachyonCore: processStatusSummary(input.runtimeStatus.tachyonCore),
            xray: processStatusSummary(input.runtimeStatus.xray),
          }
        : null,
    },
    safety: {
      noSpawn: true,
      noSystemProxy: true,
      noTun: true,
      readOnly: true,
      redaction: [
        "subscription URL credentials/query values",
        "UUIDs, passwords, tokens, PSKs, private keys, and Reality private fields",
        "full share links, raw subscription payloads, and Xray outbound secrets",
      ],
    },
    schemaVersion: 1,
    selectedNode: input.selectedNode ? nodeSummary(input.selectedNode) : null,
    subscriptions: subscriptionSummary(input.subscription),
  }) as ClientDiagnosticsExport;
}

export function stringifyDiagnosticsExport(value: ClientDiagnosticsExport): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function redactDiagnosticsValue(value: unknown, key = ""): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, key);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticsValue(item, key));
  }

  const out: Record<string, unknown> = {};
  for (const [itemKey, itemValue] of Object.entries(value)) {
    if (isSensitiveKey(itemKey)) {
      out[itemKey] =
        typeof itemValue === "string" && itemValue.trim() ? redacted : itemValue;
      continue;
    }
    out[itemKey] = redactDiagnosticsValue(itemValue, itemKey);
  }
  return out;
}

export function redactSubscriptionUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "manual") {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.pathname = url.pathname
      .split("/")
      .map((segment) => redactPathSegment(segment))
      .join("/");
    for (const key of Array.from(url.searchParams.keys())) {
      url.searchParams.set(key, redacted);
    }
    if (url.hash) {
      url.hash = redacted;
    }
    return url.toString();
  } catch {
    return redactString(trimmed, "sourceUrl");
  }
}

function releaseSummary(
  diagnostics: CoreReleaseDiagnostics | undefined,
  kind: ManagedBinaryKind,
  settings: RuntimeSettings,
): DiagnosticsReleaseSummary {
  const selectedChannel =
    kind === "xray" ? settings.xrayReleaseChannel : settings.tachyonCoreReleaseChannel;
  const installedPath =
    diagnostics?.installedPath ??
    (kind === "xray" ? settings.xrayBinaryPath : settings.tachyonCoreBinaryPath);
  return {
    assetName: diagnostics?.assetName ?? null,
    checksumMatch: diagnostics?.checksumMatch ?? null,
    displayName: diagnostics?.displayName ?? managedBinaryDisplayName(kind),
    installedExists: diagnostics?.installedExists ?? false,
    installedPath,
    installedVersionStatus: diagnostics?.installedExists
      ? diagnostics.installedVersion ?? "not probed - diagnostics does not execute installed binaries"
      : "not installed",
    lastError: diagnostics?.lastError ?? null,
    resolvedTag: diagnostics?.resolvedTag ?? null,
    selectedChannel,
  };
}

function binaryPathSummary(
  kind: ManagedBinaryKind,
  input: ClientDiagnosticsInput,
): DiagnosticsBinaryPath {
  const binary = kind === "xray" ? input.managedBinaries?.xray : input.managedBinaries?.tachyonCore;
  const configuredPath =
    kind === "xray"
      ? input.runtimeSettings.xrayBinaryPath
      : input.runtimeSettings.tachyonCoreBinaryPath;
  return {
    configuredExists: binary?.configuredExists ?? null,
    configuredPath: binary?.configuredPath || configuredPath,
    installedExists: binary?.configuredExists ?? null,
    installedPath: binary?.configuredPath || configuredPath,
    managedExists: binary?.managedExists ?? null,
    managedPath: binary?.targetPath ?? "",
  };
}

function processStatusSummary(status: ProcessStatus): DiagnosticsProcessStatus {
  return {
    binaryPath: status.binaryPath,
    configPath: status.configPath,
    lastError: status.lastError,
    pid: status.pid,
    state: status.state,
  };
}

function subscriptionSummary(snapshot: SubscriptionSnapshot) {
  const groups = snapshot.subscriptions.map((subscription) => ({
    name: subscription.name,
    nodeCount: subscription.nodes.length,
    protocolCounts: protocolCounts(subscription.nodes),
    sourceUrl: redactSubscriptionUrl(subscription.sourceUrl),
    updatedAt: subscription.updatedAt,
  }));
  return {
    activeGroup:
      snapshot.subscriptions.find((item) => item.id === snapshot.selectedSubscriptionId)?.name ??
      null,
    groups,
    protocolCounts: protocolCounts(snapshot.subscriptions.flatMap((item) => item.nodes)),
    totalGroups: snapshot.subscriptions.length,
    totalNodes: snapshot.subscriptions.reduce((total, item) => total + item.nodes.length, 0),
  };
}

function nodeSummary(node: ProxyNode): DiagnosticsNodeSummary {
  return {
    address: redactHost(node.address),
    credentialPresent: Boolean(node.credential),
    name: node.name,
    port: node.port,
    protocol: node.protocol,
    rawUriScheme: rawUriScheme(node.rawUri),
    security: node.security ?? null,
    sni: node.sni ? redactHost(node.sni) : null,
    transport: node.transport ?? null,
  };
}

function protocolCounts(nodes: ProxyNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.protocol] = (counts[node.protocol] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueErrors(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => redactString(value.trim())).filter(Boolean)),
  ).slice(0, 20);
}

function redactString(value: string, key = ""): string {
  if (!value) {
    return value;
  }
  if (isSensitiveKey(key)) {
    return redacted;
  }
  const withoutPrivateKeys = value.replace(privateKeyPattern, redacted);
  if (looksLikeUrl(withoutPrivateKeys)) {
    return redactSubscriptionUrl(withoutPrivateKeys);
  }
  const withoutInlineSecrets = withoutPrivateKeys.replace(
    inlineSecretPattern,
    (match, label: string) => `${label} ${redacted}`,
  );
  const withoutUuid = withoutInlineSecrets.replace(uuidPattern, redacted);
  const withoutOpaqueTokens = withoutUuid.replace(opaqueTokenPattern, redacted);
  return withoutOpaqueTokens;
}

function redactPathSegment(value: string): string {
  if (!value) {
    return value;
  }
  const decoded = safeDecodeURIComponent(value);
  if (
    containsUuid(decoded) ||
    decoded.length >= 24 ||
    /token|secret|key|uuid|password|passwd|pwd/i.test(decoded)
  ) {
    return redacted;
  }
  return value;
}

function redactHost(value: string): string {
  const host = value.trim();
  if (!host) {
    return "";
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".");
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  if (host.includes(":") && /^[0-9a-f:]+$/i.test(host)) {
    return `${host.slice(0, 4)}...`;
  }
  const labels = host.split(".");
  if (labels.length <= 1) {
    return host.length <= 3 ? "***" : `${host.slice(0, 2)}***`;
  }
  const first = labels[0] ?? "";
  const suffix = labels.slice(-2).join(".");
  return `${first.slice(0, 2)}***.${suffix}`;
}

function rawUriScheme(value: string): string {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase() ?? "";
}

function containsUuid(value: string): boolean {
  uuidPattern.lastIndex = 0;
  return uuidPattern.test(value);
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key.replace(/([a-z])([A-Z])/g, "$1_$2"));
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function managedBinaryDisplayName(kind: ManagedBinaryKind): string {
  return kind === "xray" ? "Xray Core" : "Tachyon Core";
}

import { invokeDesktop, isTauriRuntime } from "./tauri";
import type { ConfigDraftPaths } from "./desktopConfig";

export type ProcessState = "failed" | "running" | "stopped";

export interface RuntimePaths {
  binDir: string;
  tachyonCoreBinaryPath: string;
  xrayBinaryPath: string;
  runtimeSettingsPath: string;
}

export interface RuntimeSettings {
  tachyonGrpcListen: string;
  tachyonGrpcPort: number;
  tachyonIpcListen: string;
  tachyonIpcPort: number;
  tachyonCoreBinaryPath: string;
  xrayBinaryPath: string;
  tachyonFecAdaptWindow: number;
  tachyonFecDataShards: number;
  tachyonFecDynamic: boolean;
  tachyonFecGroupTimeoutMs: number;
  tachyonFecParityShards: number;
  tachyonConnectionMigration: boolean;
  tachyonLocalAddrs: string;
  tachyonMultipath: boolean;
  tachyonServerAddress: string;
  tachyonTgpAuthPsk: string;
  tachyonTgpServerAddress: string;
  tachyonTelemetryIntervalMs: number;
  tachyonCoreReleaseChannel: ReleaseChannel;
  tachyonTunAddress: string;
  tachyonTunAutoRoute: boolean;
  tachyonTunDnsHijack: boolean;
  tachyonTunMtu: number;
  xrayHttpListen: string;
  xrayHttpPort: number;
  xraySocksListen: string;
  xraySocksPort: number;
  systemProxyBypass: string;
  xrayStatsEnabled: boolean;
  xrayStatsListen: string;
  xrayStatsPort: number;
  xrayReleaseChannel: ReleaseChannel;
}

export type ManagedBinaryKind = "tachyonCore" | "xray";
export type ReleaseChannel = "stable" | "preview";

export interface SidecarDependencyInfo {
  name: string;
  path: string;
  required: boolean;
  exists: boolean;
}

export interface ManagedBinaryInfo {
  kind: ManagedBinaryKind;
  displayName: string;
  targetPath: string;
  configuredPath: string;
  sidecarDependencies: SidecarDependencyInfo[];
  managedExists: boolean;
  configuredExists: boolean;
  managedSizeBytes: number | null;
  configuredSizeBytes: number | null;
  managedModifiedAt: number | null;
  configuredModifiedAt: number | null;
}

export interface ManagedBinaryInventory {
  binDir: string;
  runtimeSettings: RuntimeSettings;
  tachyonCore: ManagedBinaryInfo;
  xray: ManagedBinaryInfo;
}

export interface RuntimeReleaseInfo {
  tagName: string;
  assetName: string;
  assetUrl: string;
  assetSizeBytes: number;
  checksumAssetName: string;
  checksumUrl: string;
  publishedAt: string | null;
}

export interface RuntimeInstallResult {
  release: RuntimeReleaseInfo;
  sha256: string;
  binaryPath: string;
  inventory: ManagedBinaryInventory;
}

export interface CoreReleaseDiagnostics {
  kind: ManagedBinaryKind;
  displayName: string;
  selectedChannel: ReleaseChannel;
  resolvedTag: string | null;
  assetName: string | null;
  assetUrl: string | null;
  assetSizeBytes: number | null;
  checksumAssetName: string | null;
  checksumUrl: string | null;
  checksumExpectedSha256: string | null;
  checksumActualSha256: string | null;
  checksumMatch: boolean | null;
  installedPath: string;
  installedExists: boolean;
  installedVersion: string | null;
  lastError: string | null;
}

export interface ReleaseDiagnosticsDisplayRow {
  label: string;
  tone: "bad" | "good" | "";
  title?: string;
  value: string;
  wide: boolean;
}

export interface ReleaseDiagnosticsDisplay {
  lastError: string | null;
  rows: ReleaseDiagnosticsDisplayRow[];
}

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  binaryPath: string | null;
  configPath: string | null;
  startedAt: number | null;
  lastError: string | null;
}

export interface RuntimeStatus {
  tachyonCore: ProcessStatus;
  xray: ProcessStatus;
}

export interface RuntimePrivilegeStatus {
  platform: string;
  elevated: boolean;
  canManageTun: boolean;
  message: string;
}

export interface XrayTrafficStats {
  bytesSent: number;
  bytesReceived: number;
  queriedAt: number | null;
}

export interface TcpLatencyResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface ProxyProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  via: string;
  targetUrl: string;
  error: string | null;
}

export interface LocalProxyProbeReport {
  ok: boolean;
  targetUrl: string;
  checkedAt: number | null;
  http: ProxyProbeResult;
  socks: ProxyProbeResult;
}

export interface ConfigValidationResult {
  ok: boolean;
  target: string;
  command: string;
  details: string;
  error: string | null;
}

export interface CanonicalXrayConfigText {
  exists: boolean;
  contents: string | null;
}

export interface TachyonCorePreflightCheck {
  code: string;
  status: string;
  message: string;
  details: string;
  raw: unknown;
}

export interface TachyonCorePreflightResult {
  supported: boolean;
  ok: boolean;
  overall: string;
  checks: TachyonCorePreflightCheck[];
  structuredReport: unknown;
  command: string;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  exitCode: number | null;
  error: string | null;
}

export interface SystemProxyState {
  supported: boolean;
  enabled: boolean;
  matchesPrism: boolean;
  proxyServer: string;
  expectedProxyServer: string;
  bypass: string;
  error: string | null;
}

export function tachyonIpcBaseUrl(
  settings: Pick<RuntimeSettings, "tachyonIpcListen" | "tachyonIpcPort">,
): string {
  const listen = settings.tachyonIpcListen.trim() || "127.0.0.1";
  const port = settings.tachyonIpcPort > 0 ? settings.tachyonIpcPort : 55123;
  return `http://${httpHost(listen)}:${port}`;
}

export function buildReleaseDiagnosticsDisplay(
  diagnostics: CoreReleaseDiagnostics,
  formatBytes: (value: number | null) => string,
): ReleaseDiagnosticsDisplay {
  const checksumLabel =
    diagnostics.checksumMatch === true
      ? "Match"
      : diagnostics.checksumMatch === false
        ? "Mismatch"
        : diagnostics.checksumExpectedSha256
          ? "Not checked"
          : "Unknown";
  const hasResolvedRelease = Boolean(diagnostics.resolvedTag);
  const installedPath = diagnostics.installedPath.trim();

  return {
    lastError: diagnostics.lastError,
    rows: [
      {
        label: "Channel",
        tone: "",
        value: diagnostics.selectedChannel === "preview" ? "Pre" : "Stable",
        wide: false,
      },
      {
        label: "Resolved tag",
        tone: "",
        value: diagnostics.resolvedTag ?? (diagnostics.lastError ? "Empty" : "--"),
        wide: false,
      },
      {
        label: "Asset",
        title: diagnostics.assetName ?? undefined,
        tone: "",
        value: diagnostics.assetName
          ? `${diagnostics.assetName} / ${formatBytes(diagnostics.assetSizeBytes)}`
          : hasResolvedRelease
            ? "No compatible asset"
            : "--",
        wide: true,
      },
      {
        label: "Checksum",
        tone: diagnostics.checksumMatch === false ? "bad" : diagnostics.checksumMatch ? "good" : "",
        value: checksumLabel,
        wide: false,
      },
      {
        label: "SHA-256",
        title: diagnostics.checksumExpectedSha256 ?? undefined,
        tone: "",
        value: shortDiagnosticHash(diagnostics.checksumExpectedSha256),
        wide: false,
      },
      {
        label: "Installed version",
        title: diagnostics.installedPath || undefined,
        tone: "",
        value: diagnostics.installedExists
          ? diagnostics.installedVersion ?? "Not probed - diagnostics does not execute installed binaries"
          : "Not installed",
        wide: true,
      },
      {
        label: "Installed path",
        title: installedPath || undefined,
        tone: "",
        value: installedPath || "--",
        wide: true,
      },
    ],
  };
}

function shortDiagnosticHash(hash: string | null): string {
  if (!hash) {
    return "--";
  }
  if (hash.length <= 16) {
    return hash;
  }
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

export async function getRuntimePaths(): Promise<RuntimePaths> {
  if (!isTauriRuntime()) {
    return previewRuntimePaths();
  }
  return invokeDesktop<RuntimePaths>("runtime_paths");
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  if (!isTauriRuntime()) {
    return previewRuntimeSettings();
  }
  return invokeDesktop<RuntimeSettings>("runtime_settings");
}

export async function saveRuntimeSettings(
  settings: RuntimeSettings,
): Promise<RuntimeSettings> {
  if (!isTauriRuntime()) {
    return settings;
  }
  return invokeDesktop<RuntimeSettings>("save_runtime_settings", { settings });
}

export async function getManagedBinaries(): Promise<ManagedBinaryInventory> {
  if (!isTauriRuntime()) {
    return previewManagedBinaries();
  }
  return invokeDesktop<ManagedBinaryInventory>("managed_binaries");
}

export async function installManagedBinary(
  kind: ManagedBinaryKind,
  sourcePath: string,
): Promise<ManagedBinaryInventory> {
  return invokeDesktop<ManagedBinaryInventory>("install_managed_binary", {
    kind,
    sourcePath,
  });
}

export async function getLatestXrayRelease(): Promise<RuntimeReleaseInfo> {
  return invokeDesktop<RuntimeReleaseInfo>("latest_xray_release");
}

export async function installLatestXray(): Promise<RuntimeInstallResult> {
  return invokeDesktop<RuntimeInstallResult>("install_latest_xray");
}

export async function getLatestTachyonCoreRelease(): Promise<RuntimeReleaseInfo> {
  return invokeDesktop<RuntimeReleaseInfo>("latest_tachyon_core_release");
}

export async function installLatestTachyonCore(): Promise<RuntimeInstallResult> {
  return invokeDesktop<RuntimeInstallResult>("install_latest_tachyon_core");
}

export async function getCoreReleaseDiagnostics(
  kind: ManagedBinaryKind,
): Promise<CoreReleaseDiagnostics> {
  if (!isTauriRuntime()) {
    return previewCoreReleaseDiagnostics(kind);
  }
  return invokeDesktop<CoreReleaseDiagnostics>("core_release_diagnostics", { kind });
}

export async function installWintunSidecar(): Promise<ManagedBinaryInventory> {
  return invokeDesktop<ManagedBinaryInventory>("install_wintun_sidecar");
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isTauriRuntime()) {
    return previewRuntimeStatus();
  }
  return invokeDesktop<RuntimeStatus>("runtime_status");
}

export async function getRuntimePrivilegeStatus(): Promise<RuntimePrivilegeStatus> {
  if (!isTauriRuntime()) {
    return previewRuntimePrivilegeStatus();
  }
  return invokeDesktop<RuntimePrivilegeStatus>("runtime_privilege_status");
}

export async function getXrayTrafficStats(): Promise<XrayTrafficStats> {
  if (!isTauriRuntime()) {
    return previewXrayTrafficStats();
  }
  return invokeDesktop<XrayTrafficStats>("xray_traffic_stats");
}

export async function testTcpLatency(
  address: string,
  port: number,
  timeoutMs = 2500,
): Promise<TcpLatencyResult> {
  if (!isTauriRuntime()) {
    return previewTcpLatency(address, port);
  }
  return invokeDesktop<TcpLatencyResult>("test_tcp_latency", {
    address,
    port,
    timeoutMs,
  });
}

export async function testXrayProxy(
  targetUrl = "http://cp.cloudflare.com/generate_204",
  timeoutMs = 5000,
): Promise<ProxyProbeResult> {
  if (!isTauriRuntime()) {
    return previewProxyProbe(targetUrl);
  }
  return invokeDesktop<ProxyProbeResult>("test_xray_proxy", {
    targetUrl,
    timeoutMs,
  });
}

export async function testXrayLocalProxies(
  targetUrl = "http://cp.cloudflare.com/generate_204",
  timeoutMs = 5000,
): Promise<LocalProxyProbeReport> {
  if (!isTauriRuntime()) {
    return previewLocalProxyProbe(targetUrl);
  }
  return invokeDesktop<LocalProxyProbeReport>("test_xray_local_proxies", {
    targetUrl,
    timeoutMs,
  });
}

export async function validateXrayConfig(
  binaryPath?: string,
  configPath?: string,
): Promise<ConfigValidationResult> {
  if (!isTauriRuntime()) {
    return previewConfigValidation("xray");
  }
  return invokeDesktop<ConfigValidationResult>("validate_xray_config", {
    binaryPath,
    configPath,
  });
}

export async function commitValidatedXrayConfig(contents: string): Promise<ConfigDraftPaths> {
  if (!isTauriRuntime()) {
    return {
      configDir: "Preview mode",
      coreConfigPath: "Preview mode / client.json",
      xrayConfigPath: "Preview mode / xray-client.json",
    };
  }
  return invokeDesktop<ConfigDraftPaths>("commit_validated_xray_config", { contents });
}

export async function readCanonicalXrayConfig(): Promise<CanonicalXrayConfigText> {
  if (!isTauriRuntime()) {
    return { exists: false, contents: null };
  }
  return invokeDesktop<CanonicalXrayConfigText>("read_canonical_xray_config");
}

export async function validateTachyonCoreConfig(
  binaryPath?: string,
  configPath?: string,
): Promise<ConfigValidationResult> {
  if (!isTauriRuntime()) {
    return previewConfigValidation("tachyon-core");
  }
  return invokeDesktop<ConfigValidationResult>("validate_tachyon_core_config", {
    binaryPath,
    configPath,
  });
}

export async function preflightTachyonCore(
  binaryPath?: string,
  configPath?: string,
): Promise<TachyonCorePreflightResult> {
  if (!isTauriRuntime()) {
    return previewTachyonCorePreflight();
  }
  return invokeDesktop<TachyonCorePreflightResult>("tachyon_core_preflight", {
    binaryPath,
    configPath,
  });
}

const tachyonCoreStartBlockCodes = new Set([
  "WINTUN_DLL_PRESENT",
  "TUN_PRIVILEGE",
  "TUN_DEVICE_PRESENT",
]);

export function tachyonCorePreflightFallbackMessage(result: TachyonCorePreflightResult): string | null {
  return result.supported ? null : "Core version lacks preflight; validate only";
}

export function tachyonCorePreflightReadinessMessage(result: TachyonCorePreflightResult): string {
  const fallback = tachyonCorePreflightFallbackMessage(result);
  if (fallback) {
    return fallback;
  }
  if (result.ok) {
    return result.overall.toLowerCase() === "warn" || result.overall.toLowerCase() === "warning"
      ? `Tachyon Core preflight completed with warnings: ${preflightWarningSummary(result)}`
      : "Tachyon Core preflight passed";
  }
  return `Tachyon Core preflight found readiness issues: ${
    result.error || preflightFailureSummary(result)
  }`;
}

export function tachyonCorePreflightStartBlockReason(
  result: TachyonCorePreflightResult | null,
): string | null {
  if (!result?.supported) {
    return null;
  }
  const blockingChecks = result.checks.filter(
    (check) =>
      tachyonCoreStartBlockCodes.has(check.code.toUpperCase()) &&
      ["error", "failed", "fail"].includes(check.status.toLowerCase()),
  );
  if (blockingChecks.length === 0) {
    return null;
  }
  const details = blockingChecks
    .map((check) => {
      const message = check.message || check.details || "required capability is unavailable";
      return `${check.code}: ${message}`;
    })
    .join("; ");
  return `Tachyon Core game acceleration cannot start: ${details}. Xray local proxy can still run independently.`;
}

function preflightFailureSummary(result: TachyonCorePreflightResult): string {
  const failedChecks = result.checks.filter((check) =>
    ["error", "failed", "fail"].includes(check.status.toLowerCase()),
  );
  const checks = failedChecks.length > 0 ? failedChecks : result.checks;
  return preflightCheckSummary(checks) || `overall=${result.overall}`;
}

function preflightWarningSummary(result: TachyonCorePreflightResult): string {
  return (
    preflightCheckSummary(
      result.checks.filter((check) =>
        ["warn", "warning"].includes(check.status.toLowerCase()),
      ),
    ) || `overall=${result.overall}`
  );
}

function preflightCheckSummary(checks: TachyonCorePreflightCheck[]): string {
  return checks
    .map((check) => {
      const message = check.message || check.details;
      return message ? `${check.code}: ${message}` : check.code;
    })
    .filter(Boolean)
    .join("; ");
}

export async function getSystemProxyStatus(): Promise<SystemProxyState> {
  if (!isTauriRuntime()) {
    return previewSystemProxyState(false);
  }
  return invokeDesktop<SystemProxyState>("system_proxy_status");
}

export async function enableSystemProxy(): Promise<SystemProxyState> {
  if (!isTauriRuntime()) {
    return previewSystemProxyState(true);
  }
  return invokeDesktop<SystemProxyState>("enable_system_proxy");
}

export async function disableSystemProxy(): Promise<SystemProxyState> {
  if (!isTauriRuntime()) {
    return previewSystemProxyState(false);
  }
  return invokeDesktop<SystemProxyState>("disable_system_proxy");
}

export async function startXray(
  binaryPath: string,
  configPath: string,
): Promise<ProcessStatus> {
  return invokeDesktop<ProcessStatus>("start_xray", { binaryPath, configPath });
}

export async function stopXray(): Promise<ProcessStatus> {
  return invokeDesktop<ProcessStatus>("stop_xray");
}

export async function startTachyonCore(
  binaryPath: string,
  configPath: string,
): Promise<ProcessStatus> {
  return invokeDesktop<ProcessStatus>("start_tachyon_core", { binaryPath, configPath });
}

export async function stopTachyonCore(): Promise<ProcessStatus> {
  return invokeDesktop<ProcessStatus>("stop_tachyon_core");
}

function previewRuntimeSettings(): RuntimeSettings {
  return {
    tachyonGrpcListen: "127.0.0.1",
    tachyonGrpcPort: 50051,
    tachyonIpcListen: "127.0.0.1",
    tachyonIpcPort: 55123,
    tachyonCoreBinaryPath: "",
    tachyonCoreReleaseChannel: "preview",
    tachyonFecAdaptWindow: 32,
    tachyonFecDataShards: 4,
    tachyonFecDynamic: true,
    tachyonFecGroupTimeoutMs: 20,
    tachyonFecParityShards: 2,
    tachyonConnectionMigration: true,
    tachyonLocalAddrs: "",
    tachyonMultipath: false,
    tachyonServerAddress: "",
    tachyonTgpAuthPsk: "",
    tachyonTgpServerAddress: "",
    tachyonTelemetryIntervalMs: 500,
    tachyonTunAddress: "198.18.0.1/16",
    tachyonTunAutoRoute: false,
    tachyonTunDnsHijack: false,
    tachyonTunMtu: 1280,
    xrayBinaryPath: "",
    xrayHttpListen: "127.0.0.1",
    xrayHttpPort: 10809,
    xraySocksListen: "127.0.0.1",
    xraySocksPort: 10808,
    systemProxyBypass: "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>",
    xrayStatsEnabled: true,
    xrayStatsListen: "127.0.0.1",
    xrayStatsPort: 10085,
    xrayReleaseChannel: "stable",
  };
}

function previewRuntimePaths(): RuntimePaths {
  return {
    binDir: "Preview mode",
    runtimeSettingsPath: "Preview mode / runtime-settings.json",
    tachyonCoreBinaryPath: "Preview mode / tachyon-core",
    xrayBinaryPath: "Preview mode / xray",
  };
}

function previewManagedBinaries(): ManagedBinaryInventory {
  const settings = previewRuntimeSettings();
  return {
    binDir: "Preview mode",
    runtimeSettings: settings,
    tachyonCore: previewBinary("tachyonCore", "Tachyon Core"),
    xray: previewBinary("xray", "Xray Core"),
  };
}

function previewBinary(kind: ManagedBinaryKind, displayName: string): ManagedBinaryInfo {
  return {
    configuredExists: false,
    configuredModifiedAt: null,
    configuredPath: "",
    configuredSizeBytes: null,
    displayName,
    kind,
    managedExists: false,
    managedModifiedAt: null,
    managedSizeBytes: null,
    sidecarDependencies: [],
    targetPath: `Preview mode / ${displayName}`,
  };
}

function previewCoreReleaseDiagnostics(kind: ManagedBinaryKind): CoreReleaseDiagnostics {
  const settings = previewRuntimeSettings();
  const isXray = kind === "xray";
  const assetName = isXray
    ? "Xray-windows-64.zip"
    : "tachyon-core_v0.1.0-alpha.12_windows_amd64.zip";
  return {
    assetName,
    assetSizeBytes: isXray ? 18153472 : 12320768,
    assetUrl: `https://example.invalid/${assetName}`,
    checksumActualSha256: null,
    checksumAssetName: isXray ? `${assetName}.dgst` : "SHA256SUMS.txt",
    checksumExpectedSha256: "a".repeat(64),
    checksumMatch: null,
    checksumUrl: "https://example.invalid/SHA256SUMS.txt",
    displayName: isXray ? "Xray Core" : "Tachyon Core",
    installedExists: false,
    installedPath: isXray ? settings.xrayBinaryPath : settings.tachyonCoreBinaryPath,
    installedVersion: null,
    kind,
    lastError: null,
    resolvedTag: isXray ? "v25.3.6" : "v0.1.0-alpha.12",
    selectedChannel: isXray ? settings.xrayReleaseChannel : settings.tachyonCoreReleaseChannel,
  };
}

function previewRuntimeStatus(): RuntimeStatus {
  return {
    tachyonCore: stoppedPreviewProcess(),
    xray: stoppedPreviewProcess(),
  };
}

function previewRuntimePrivilegeStatus(): RuntimePrivilegeStatus {
  return {
    canManageTun: true,
    elevated: true,
    message: "Preview runtime can manage TUN.",
    platform: "preview",
  };
}

function previewXrayTrafficStats(): XrayTrafficStats {
  return {
    bytesReceived: 0,
    bytesSent: 0,
    queriedAt: null,
  };
}

function previewTcpLatency(address: string, port: number): TcpLatencyResult {
  if (!address || port <= 0) {
    return {
      error: "endpoint unavailable",
      latencyMs: null,
      ok: false,
    };
  }
  const seed = Array.from(`${address}:${port}`).reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return {
    error: null,
    latencyMs: 82 + (seed % 236),
    ok: true,
  };
}

function previewProxyProbe(targetUrl: string): ProxyProbeResult {
  return {
    error: null,
    latencyMs: 42,
    ok: true,
    statusCode: 204,
    targetUrl,
    via: "127.0.0.1:10809",
  };
}

function previewLocalProxyProbe(targetUrl: string): LocalProxyProbeReport {
  return {
    checkedAt: Math.floor(Date.now() / 1000),
    http: previewProxyProbe(targetUrl),
    ok: true,
    socks: {
      ...previewProxyProbe(targetUrl),
      latencyMs: 45,
      via: "socks5://127.0.0.1:10808",
    },
    targetUrl,
  };
}

function previewConfigValidation(target: string): ConfigValidationResult {
  return {
    command: `${target} validate preview`,
    details: "Preview runtime config looks valid.",
    error: null,
    ok: true,
    target,
  };
}

function previewTachyonCorePreflight(): TachyonCorePreflightResult {
  return {
    checks: [
      {
        code: "CONFIG_VALID",
        details: "Preview runtime does not execute tachyon-core.",
        message: "Tachyon Core client JSON can be parsed.",
        raw: null,
        status: "ok",
      },
      {
        code: "AUTO_ROUTE_DISABLED",
        details: "auto_route=false avoids default-route takeover, but Core client still needs TUN device capability.",
        message: "OS default route takeover is disabled.",
        raw: null,
        status: "warning",
      },
    ],
    command: "tachyon-core preflight --config preview --json",
    error: null,
    exitCode: 0,
    ok: true,
    overall: "warning",
    structuredReport: null,
    stderr: "",
    stderrTruncated: false,
    stdout: "",
    stdoutTruncated: false,
    supported: true,
  };
}

function previewSystemProxyState(enabled: boolean): SystemProxyState {
  const expectedProxyServer = "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808";
  return {
    bypass: "localhost;127.*;<local>",
    enabled,
    error: null,
    expectedProxyServer,
    matchesPrism: enabled,
    proxyServer: enabled ? expectedProxyServer : "",
    supported: true,
  };
}

function httpHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }
  return host.includes(":") ? `[${host}]` : host;
}

function stoppedPreviewProcess(): ProcessStatus {
  return {
    binaryPath: null,
    configPath: null,
    lastError: null,
    pid: null,
    startedAt: null,
    state: "stopped",
  };
}

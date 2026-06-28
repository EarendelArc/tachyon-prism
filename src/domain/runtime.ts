import { invokeDesktop, isTauriRuntime } from "./tauri";

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
  tachyonTelemetryIntervalMs: number;
  tachyonCoreReleaseChannel: ReleaseChannel;
  tachyonTunAddress: string;
  tachyonTunMtu: number;
  xraySocksListen: string;
  xraySocksPort: number;
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

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isTauriRuntime()) {
    return previewRuntimeStatus();
  }
  return invokeDesktop<RuntimeStatus>("runtime_status");
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
    tachyonTelemetryIntervalMs: 500,
    tachyonTunAddress: "198.18.0.1/16",
    tachyonTunMtu: 9000,
    xrayBinaryPath: "",
    xraySocksListen: "127.0.0.1",
    xraySocksPort: 10808,
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

function previewRuntimeStatus(): RuntimeStatus {
  return {
    tachyonCore: stoppedPreviewProcess(),
    xray: stoppedPreviewProcess(),
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

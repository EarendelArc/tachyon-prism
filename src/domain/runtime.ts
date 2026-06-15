import { invokeDesktop, isTauriRuntime } from "./tauri";

export type ProcessState = "failed" | "running" | "stopped";

export interface RuntimePaths {
  binDir: string;
  tachyonCoreBinaryPath: string;
  xrayBinaryPath: string;
  runtimeSettingsPath: string;
}

export interface RuntimeSettings {
  tachyonCoreBinaryPath: string;
  xrayBinaryPath: string;
  tachyonCoreReleaseChannel: ReleaseChannel;
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
    tachyonCoreBinaryPath: "",
    tachyonCoreReleaseChannel: "preview",
    xrayBinaryPath: "",
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

import { invoke } from "@tauri-apps/api/core";

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
}

export type ManagedBinaryKind = "tachyonCore" | "xray";

export interface ManagedBinaryInfo {
  kind: ManagedBinaryKind;
  displayName: string;
  targetPath: string;
  configuredPath: string;
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
  return invoke<RuntimePaths>("runtime_paths");
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return invoke<RuntimeSettings>("runtime_settings");
}

export async function saveRuntimeSettings(
  settings: RuntimeSettings,
): Promise<RuntimeSettings> {
  return invoke<RuntimeSettings>("save_runtime_settings", { settings });
}

export async function getManagedBinaries(): Promise<ManagedBinaryInventory> {
  return invoke<ManagedBinaryInventory>("managed_binaries");
}

export async function installManagedBinary(
  kind: ManagedBinaryKind,
  sourcePath: string,
): Promise<ManagedBinaryInventory> {
  return invoke<ManagedBinaryInventory>("install_managed_binary", {
    kind,
    sourcePath,
  });
}

export async function getLatestXrayRelease(): Promise<RuntimeReleaseInfo> {
  return invoke<RuntimeReleaseInfo>("latest_xray_release");
}

export async function installLatestXray(): Promise<RuntimeInstallResult> {
  return invoke<RuntimeInstallResult>("install_latest_xray");
}

export async function getLatestTachyonCoreRelease(): Promise<RuntimeReleaseInfo> {
  return invoke<RuntimeReleaseInfo>("latest_tachyon_core_release");
}

export async function installLatestTachyonCore(): Promise<RuntimeInstallResult> {
  return invoke<RuntimeInstallResult>("install_latest_tachyon_core");
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_status");
}

export async function startXray(
  binaryPath: string,
  configPath: string,
): Promise<ProcessStatus> {
  return invoke<ProcessStatus>("start_xray", { binaryPath, configPath });
}

export async function stopXray(): Promise<ProcessStatus> {
  return invoke<ProcessStatus>("stop_xray");
}

export async function startTachyonCore(
  binaryPath: string,
  configPath: string,
): Promise<ProcessStatus> {
  return invoke<ProcessStatus>("start_tachyon_core", { binaryPath, configPath });
}

export async function stopTachyonCore(): Promise<ProcessStatus> {
  return invoke<ProcessStatus>("stop_tachyon_core");
}

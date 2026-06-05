import { invoke } from "@tauri-apps/api/core";

export type ProcessState = "failed" | "running" | "stopped";

export interface RuntimePaths {
  binDir: string;
  tachyonCoreBinaryPath: string;
  xrayBinaryPath: string;
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

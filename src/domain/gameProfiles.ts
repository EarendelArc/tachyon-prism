import { invoke } from "@tauri-apps/api/core";

export type UDPPolicy = "auto" | "tgp" | "direct" | "block";
export type TCPPolicy = "auto" | "direct" | "block";

export interface MatchRule {
  processNames: string[];
  paths: string[];
  pathPrefixes: string[];
  sha256: string[];
  steamAppIds: number[];
}

export interface GameProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  manual: boolean;
  priority: number;
  match: MatchRule;
  udpPolicy: UDPPolicy;
  tcpPolicy: TCPPolicy;
}

export interface GameProfilesFile {
  profiles: GameProfile[];
}

export interface SteamAppManifest {
  appId: number;
  name: string;
  installDir: string;
  universe: string;
  stateFlags: number;
  libraryPath: string;
}

export interface SteamScanResult {
  apps: SteamAppManifest[];
  profiles: GameProfile[];
}

export interface SteamLauncherSettings {
  enabled: boolean;
  trackChildProcesses: boolean;
  accelerateGameUdp: boolean;
  accelerateSteamDownloads: boolean;
}

export interface LauncherSettings {
  steam: SteamLauncherSettings;
}

export const defaultGameProfiles: GameProfile[] = [
  {
    id: "cs2",
    displayName: "Counter-Strike 2",
    enabled: true,
    manual: true,
    priority: 100,
    match: {
      processNames: ["cs2.exe"],
      paths: [],
      pathPrefixes: [],
      sha256: [],
      steamAppIds: [730],
    },
    udpPolicy: "tgp",
    tcpPolicy: "auto",
  },
];

export const defaultLauncherSettings: LauncherSettings = {
  steam: {
    enabled: true,
    trackChildProcesses: true,
    accelerateGameUdp: true,
    accelerateSteamDownloads: false,
  },
};

const launcherSettingsKey = "tachyon.prism.launchers.v1";

export async function listGameProfiles(): Promise<GameProfile[]> {
  const file = await invoke<GameProfilesFile>("list_game_profiles");
  return file.profiles;
}

export async function saveGameProfile(profile: GameProfile): Promise<GameProfile> {
  return invoke<GameProfile>("save_game_profile", { profile });
}

export async function removeGameProfile(id: string): Promise<GameProfile[]> {
  const file = await invoke<GameProfilesFile>("remove_game_profile", { id });
  return file.profiles;
}

export async function scanSteamLibrary(root?: string): Promise<SteamScanResult> {
  return invoke<SteamScanResult>("scan_steam_library", {
    root: root?.trim() ? root.trim() : null,
  });
}

export function loadLauncherSettings(): LauncherSettings {
  try {
    const raw = globalThis.localStorage?.getItem(launcherSettingsKey);
    if (!raw) {
      return defaultLauncherSettings;
    }
    return normalizeLauncherSettings(JSON.parse(raw));
  } catch {
    return defaultLauncherSettings;
  }
}

export function saveLauncherSettings(settings: LauncherSettings): void {
  globalThis.localStorage?.setItem(
    launcherSettingsKey,
    JSON.stringify(normalizeLauncherSettings(settings)),
  );
}

function normalizeLauncherSettings(value: unknown): LauncherSettings {
  if (!isRecord(value)) {
    return defaultLauncherSettings;
  }
  const steam = isRecord(value.steam) ? value.steam : {};
  return {
    steam: {
      enabled: booleanValue(steam.enabled, defaultLauncherSettings.steam.enabled),
      trackChildProcesses: booleanValue(
        steam.trackChildProcesses,
        defaultLauncherSettings.steam.trackChildProcesses,
      ),
      accelerateGameUdp: booleanValue(
        steam.accelerateGameUdp,
        defaultLauncherSettings.steam.accelerateGameUdp,
      ),
      accelerateSteamDownloads: booleanValue(
        steam.accelerateSteamDownloads,
        defaultLauncherSettings.steam.accelerateSteamDownloads,
      ),
    },
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

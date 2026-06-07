import { describe, expect, it } from "vitest";
import {
  defaultGameProfiles,
  defaultLauncherSettings,
  loadLauncherSettings,
  saveLauncherSettings,
} from "../gameProfiles";
import type { GameProfile, LauncherSettings } from "../gameProfiles";

describe("defaultGameProfiles", () => {
  it("includes Counter-Strike 2 as the default profile", () => {
    expect(defaultGameProfiles).toHaveLength(1);
    const cs2 = defaultGameProfiles[0];
    expect(cs2.id).toBe("cs2");
    expect(cs2.displayName).toBe("Counter-Strike 2");
    expect(cs2.enabled).toBe(true);
    expect(cs2.manual).toBe(true);
    expect(cs2.priority).toBe(100);
  });

  it("has process name and Steam app ID match rules", () => {
    const cs2 = defaultGameProfiles[0];
    expect(cs2.match.processNames).toContain("cs2.exe");
    expect(cs2.match.steamAppIds).toContain(730);
  });

  it("defaults UDP policy to TGP", () => {
    for (const profile of defaultGameProfiles) {
      expect(profile.udpPolicy).toBe("tgp");
    }
  });

  it("all profiles have required fields", () => {
    for (const profile of defaultGameProfiles) {
      expect(profile.id).toBeTruthy();
      expect(profile.displayName).toBeTruthy();
      expect(profile.enabled).toBeDefined();
      expect(profile.match).toBeDefined();
      expect(profile.udpPolicy).toBeDefined();
      expect(profile.tcpPolicy).toBeDefined();
      expect(profile.priority).toBeGreaterThan(0);
    }
  });
});

describe("defaultLauncherSettings", () => {
  it("has Steam enabled by default", () => {
    expect(defaultLauncherSettings.steam.enabled).toBe(true);
  });

  it("enables child process tracking by default", () => {
    expect(defaultLauncherSettings.steam.trackChildProcesses).toBe(true);
  });

  it("enables game UDP acceleration by default", () => {
    expect(defaultLauncherSettings.steam.accelerateGameUdp).toBe(true);
  });

  it("disables Steam download acceleration by default", () => {
    expect(defaultLauncherSettings.steam.accelerateSteamDownloads).toBe(false);
  });
});

describe("loadLauncherSettings / saveLauncherSettings", () => {
  it("returns defaults when no settings are stored", () => {
    const settings = loadLauncherSettings();
    expect(settings).toEqual(defaultLauncherSettings);
  });

  it("round-trips valid settings", () => {
    const custom: LauncherSettings = {
      steam: {
        enabled: false,
        trackChildProcesses: false,
        accelerateGameUdp: false,
        accelerateSteamDownloads: true,
      },
    };
    saveLauncherSettings(custom);
    const loaded = loadLauncherSettings();
    expect(loaded).toEqual(custom);
  });

  it("normalizes malformed stored values", () => {
    // Simulate corrupted localStorage
    globalThis.localStorage?.setItem("tachyon.prism.launchers.v1", '{"steam":"not-an-object"}');
    const loaded = loadLauncherSettings();
    expect(loaded.steam.enabled).toBe(defaultLauncherSettings.steam.enabled);
  });

  it("handles missing steam key", () => {
    globalThis.localStorage?.setItem("tachyon.prism.launchers.v1", "{}");
    const loaded = loadLauncherSettings();
    expect(loaded.steam.enabled).toBe(defaultLauncherSettings.steam.enabled);
  });

  it("preserves boolean types across round-trip", () => {
    const custom: LauncherSettings = {
      steam: {
        enabled: true,
        trackChildProcesses: false,
        accelerateGameUdp: true,
        accelerateSteamDownloads: false,
      },
    };
    saveLauncherSettings(custom);
    const loaded = loadLauncherSettings();
    expect(typeof loaded.steam.enabled).toBe("boolean");
    expect(typeof loaded.steam.trackChildProcesses).toBe("boolean");
    expect(typeof loaded.steam.accelerateGameUdp).toBe("boolean");
    expect(typeof loaded.steam.accelerateSteamDownloads).toBe("boolean");
  });
});

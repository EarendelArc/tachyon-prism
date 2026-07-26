export type PrismTheme = "dark" | "contrast";
export type PrismDensity = "comfortable" | "compact";

export interface AppearancePreferences {
  density: PrismDensity;
  motion: boolean;
  theme: PrismTheme;
}

const storageKey = "tachyon.prism.appearance.v1";

export const defaultAppearancePreferences: AppearancePreferences = {
  density: "comfortable",
  motion: true,
  theme: "dark",
};

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  const source = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    density: source.density === "compact" ? "compact" : "comfortable",
    motion: source.motion !== false,
    theme: source.theme === "contrast" ? "contrast" : "dark",
  };
}

export function loadAppearancePreferences(): AppearancePreferences {
  try {
    const value = globalThis.localStorage?.getItem(storageKey);
    return normalizeAppearancePreferences(value ? JSON.parse(value) : {});
  } catch {
    return defaultAppearancePreferences;
  }
}

export function saveAppearancePreferences(value: AppearancePreferences): void {
  globalThis.localStorage?.setItem(storageKey, JSON.stringify(value));
}

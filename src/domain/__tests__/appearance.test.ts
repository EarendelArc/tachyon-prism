import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  saveAppearancePreferences,
} from "../appearance";

class MemoryStorage {
  private values = new Map<string, string>();
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

describe("appearance preferences", () => {
  it("normalizes unknown persisted values", () => {
    expect(normalizeAppearancePreferences({ density: "wide", motion: 0, theme: "light" }))
      .toEqual({ density: "comfortable", motion: true, theme: "dark" });
  });

  it("persists real theme, density, and motion choices", () => {
    const value = { density: "compact", motion: false, theme: "contrast" } as const;
    saveAppearancePreferences(value);
    expect(loadAppearancePreferences()).toEqual(value);
  });
});

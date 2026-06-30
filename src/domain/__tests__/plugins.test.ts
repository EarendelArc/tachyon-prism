import { describe, expect, it } from "vitest";
import {
  enabledPluginCount,
  installPluginState,
  installedPluginCount,
  normalizePluginState,
  recordPluginRun,
  togglePluginEnabled,
} from "../plugins";

describe("plugin state", () => {
  const ids = ["rolling-release", "node-transform"] as const;

  it("normalizes missing plugin state for the known catalog", () => {
    const state = normalizePluginState({}, ids);

    expect(Object.keys(state)).toEqual([...ids]);
    expect(state["rolling-release"]).toMatchObject({
      enabled: false,
      installed: false,
      lastRunStatus: "idle",
      lastResult: "",
      runCount: 0,
    });
  });

  it("installs and enables plugins in one step", () => {
    const state = installPluginState(normalizePluginState({}, ids), "rolling-release");

    expect(state["rolling-release"]).toMatchObject({
      enabled: true,
      installed: true,
    });
    expect(installedPluginCount(state)).toBe(1);
    expect(enabledPluginCount(state)).toBe(1);
  });

  it("toggles installed plugins without uninstalling them", () => {
    const installed = installPluginState(normalizePluginState({}, ids), "rolling-release");
    const disabled = togglePluginEnabled(installed, "rolling-release");
    const enabled = togglePluginEnabled(disabled, "rolling-release");

    expect(disabled["rolling-release"]).toMatchObject({
      enabled: false,
      installed: true,
    });
    expect(enabled["rolling-release"].enabled).toBe(true);
  });

  it("records plugin runs only for enabled installed plugins", () => {
    const installed = installPluginState(normalizePluginState({}, ids), "node-transform");
    const ran = recordPluginRun(
      installed,
      "node-transform",
      {
        now: new Date("2026-06-30T00:00:00.000Z"),
        result: "Generated Xray config draft",
        status: "ok",
      },
    );

    expect(ran["node-transform"].runCount).toBe(1);
    expect(ran["node-transform"].lastRunAt).toBe("2026-06-30T00:00:00.000Z");
    expect(ran["node-transform"].lastRunStatus).toBe("ok");
    expect(ran["node-transform"].lastResult).toBe("Generated Xray config draft");
    expect(() => recordPluginRun(normalizePluginState({}, ids), "node-transform")).toThrow(
      "Plugin must be installed and enabled before running",
    );
  });

  it("keeps the legacy Date argument for existing callers", () => {
    const installed = installPluginState(normalizePluginState({}, ids), "node-transform");
    const ran = recordPluginRun(
      installed,
      "node-transform",
      new Date("2026-06-30T00:00:00.000Z"),
    );

    expect(ran["node-transform"]).toMatchObject({
      lastRunAt: "2026-06-30T00:00:00.000Z",
      lastRunStatus: "ok",
      lastResult: "",
      runCount: 1,
    });
  });
});

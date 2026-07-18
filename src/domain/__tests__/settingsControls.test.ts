import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  fileURLToPath(new URL("../../App.tsx", import.meta.url)),
  "utf8",
);

describe("settings controls", () => {
  it("keeps only the persisted language control in General settings", () => {
    const general = /\{section === "general"[\s\S]*?\) : null\}/.exec(appSource)?.[0] ?? "";

    expect(general).toContain('onClick={() => changeLanguage("zh-CN")}');
    expect(general).toContain('onClick={() => changeLanguage("en")}');
    expect(general).not.toContain("ui.theme");
    expect(general).not.toContain("ui.color");
    expect(general).not.toContain("ui.pageVisibility");
    expect(general).not.toContain("ui.adminRestart");
  });

  it("does not expose unimplemented plugin policy checkboxes", () => {
    const settingsSections = /const sections:[\s\S]*?const coreRuntimeItems/.exec(appSource)?.[0] ?? "";
    const pluginView = /function PluginsView[\s\S]*?function SettingsView/.exec(appSource)?.[0] ?? "";

    expect(appSource).not.toContain("ui.pluginAutoUpdate");
    expect(appSource).not.toContain("ui.pluginAllowNodeRead");
    expect(settingsSections).not.toContain('id: "plugins"');
    expect(pluginView).not.toContain("onCheckUpdates");
    expect(pluginView).not.toContain("onSource");
    expect(pluginView).not.toContain("ui.pluginTriggerApp");
    expect(pluginView).not.toContain("ui.pluginTriggerNode");
    expect(pluginView).not.toContain("ui.pluginTriggerUpdate");
  });
});

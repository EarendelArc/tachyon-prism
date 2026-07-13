import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  fileURLToPath(new URL("../../App.tsx", import.meta.url)),
  "utf8",
);
const stylesSource = readFileSync(
  fileURLToPath(new URL("../../styles.css", import.meta.url)),
  "utf8",
);

describe("advanced Xray JSON UI wiring", () => {
  it("exposes edit, import, export, and both restore paths", () => {
    expect(appSource).toContain("data-xray-advanced-toggle");
    expect(appSource).toContain('data-xray-json-import');
    expect(appSource).toContain('data-xray-advanced-editor={xrayAdvancedEditor.enabled');
    expect(appSource).toContain("onExportAdvancedXray");
    expect(appSource).toContain("onRestoreAdvancedXray(false)");
    expect(appSource).toContain("onRestoreAdvancedXray(true)");
    expect(stylesSource).toContain(".xray-editor-actions");
  });

  it("provides explicit English and Chinese labels", () => {
    expect(appSource).toContain('advancedXrayConfig: "高级 Xray JSON"');
    expect(appSource).toContain('advancedXrayConfig: "Advanced Xray JSON"');
    expect(appSource).toContain("未知字段与未来协议保持原样");
    expect(appSource).toContain("Unknown fields and future protocols remain untouched");
  });

  it("uses the validated rollback transaction for every Xray write", () => {
    const commit = /async function commitXrayDraft[\s\S]*?\n  async function writeDrafts/.exec(
      appSource,
    )?.[0];
    const write = /async function writeDrafts[\s\S]*?\n  async function saveDrafts/.exec(
      appSource,
    )?.[0];

    expect(commit).toContain("commitValidatedXrayConfig<ConfigDraftPaths>");
    expect(commit).toContain("previousValidText: xrayAdvancedEditor.lastValidText");
    expect(commit).toContain("validateXrayConfig(settings.xrayBinaryPath, paths.xrayConfigPath)");
    expect(commit).toContain('saveConfigDraft("xray", text)');
    expect(write).toContain("return commitXrayDraft(settings)");
    expect(write).not.toContain('saveConfigDraft("xray", drafts.xray)');
  });

  it("validates through the same write path before Xray start", () => {
    const start = /async function startRuntime[\s\S]*?\n  async function stopRuntime/.exec(
      appSource,
    )?.[0];
    const startAll = /async function startAllRuntime[\s\S]*?\n  async function stopAllRuntime/.exec(
      appSource,
    )?.[0];

    expect(start).toContain("const paths = await writeDrafts(kind, settings)");
    expect(start).toContain('if (kind === "tachyonCore")');
    expect(startAll).toContain('const paths = await writeDrafts("all", settings)');
    expect(startAll).not.toContain('runConfigValidation("xray"');
  });
});

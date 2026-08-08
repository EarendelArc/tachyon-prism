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
    expect(appSource).toContain("data-xray-advanced-confirmation");
    expect(appSource).toContain('data-xray-json-import');
    expect(appSource).toContain(
      'data-xray-advanced-editor={xrayAdvancedEditor.mode === "raw" ? "enabled" : "disabled"}',
    );
    expect(appSource).toContain('data-xray-config-mode={xrayAdvancedEditor.mode}');
    expect(appSource).toContain("data-xray-raw-mode-notice");
    expect(appSource).toContain(
      "Raw config keeps its own routing semantics; the selected node does not control its default outbound.",
    );
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

  it("uses the Rust transaction as the only Xray commit path", () => {
    const commit = /async function commitXrayDraft[\s\S]*?\n  async function writeDrafts/.exec(
      appSource,
    )?.[0];
    const write = /async function writeDrafts[\s\S]*?\n  async function saveDrafts/.exec(
      appSource,
    )?.[0];

    expect(commit).toContain("parseXrayConfigText(drafts.xray, language)");
    expect(commit).toContain("advancedXrayConfirmationRequired");
    expect(commit).toContain("const paths = await commitValidatedXrayConfig(");
    expect(commit).toContain('const advanced = xrayAdvancedEditor.mode === "raw"');
    expect(commit).toContain('advanced ? "advanced" : "managed"');
    expect(commit).toContain("setCanonicalXrayText(drafts.xray)");
    expect(commit).toContain("setConfigPaths(paths)");
    expect(commit).not.toContain('saveConfigDraft("xray"');
    expect(commit).not.toContain("validateXrayConfig");
    expect(commit?.indexOf("await commitValidatedXrayConfig")).toBeLessThan(
      commit?.indexOf("setCanonicalXrayText") ?? -1,
    );
    expect(write).toContain("return commitXrayDraft()");
    expect(appSource).not.toContain('saveConfigDraft("xray"');
  });

  it("commits through the same Rust path before Xray start", () => {
    const start = /async function startRuntime[\s\S]*?\n  async function stopRuntime/.exec(
      appSource,
    )?.[0];
    const startAll = /async function startAllRuntime[\s\S]*?\n  async function stopAllRuntime/.exec(
      appSource,
    )?.[0];

    expect(start).toContain("const paths = await writeDrafts(kind)");
    expect(start).toContain('if (kind === "tachyonCore")');
    expect(startAll).toContain('const paths = await writeDrafts("all")');
    expect(startAll).not.toContain("validateXrayConfig");
  });

  it("keeps advanced Xray JSON in the secure vault", () => {
    const state = /interface XrayAdvancedEditorState[\s\S]*?\n}/.exec(appSource)?.[0];
    const loader = /function xrayAdvancedEditorFromStored[\s\S]*?\n}/.exec(appSource)?.[0];

    expect(state).toContain("enabled: boolean");
    expect(state).toContain("text: string");
    expect(state).toContain("confirmed: boolean");
    expect(state).not.toContain("lastValid");
    expect(loader).not.toContain("lastValid");
    expect(appSource).toContain("secureVaultSections.xrayAdvancedEditor");
    expect(appSource).not.toContain("tachyon.prism.xrayAdvancedEditor.v1");
    expect(appSource).toContain('const [canonicalXrayText, setCanonicalXrayText] = useState("")');
  });

  it("hydrates the restart restore source from the controlled canonical command", () => {
    const hydration = /void readCanonicalXrayConfig\(\)[\s\S]*?\n  }, \[\]\);/.exec(
      appSource,
    )?.[0];

    expect(hydration).toContain("canonical.exists && canonical.contents !== null");
    expect(hydration).toContain("setCanonicalXrayText(canonical.contents)");
    expect(hydration).toContain('setCanonicalXrayLoadState("loaded")');
    expect(hydration).toContain('setCanonicalXrayLoadState("error")');
    expect(hydration).toContain("setMessage(ui.canonicalXrayReadFailed)");
    expect(hydration).not.toContain("error.message");
    expect(hydration).not.toContain("setXrayAdvancedEditor");
    expect(appSource).toContain('useState<CanonicalXrayLoadState>("loading")');
    expect(appSource).toContain("loadState: canonicalXrayLoadState");
    expect(appSource).toContain('canonicalXrayLoadState === "error"');
    expect(appSource).toContain("disabled={!canonicalXrayAvailable}");
    expect(appSource).toContain('className="xray-canonical-error" role="alert"');
  });

  it("updates canonical text only after disk read or a validated commit", () => {
    expect(appSource.match(/setCanonicalXrayText\(/g)).toHaveLength(2);
    expect(appSource).toContain("const paths = await commitValidatedXrayConfig(");
    expect(appSource.indexOf("await commitValidatedXrayConfig(")).toBeLessThan(
      appSource.indexOf("setCanonicalXrayText(drafts.xray)"),
    );
    expect(appSource).toContain("xray: xrayAdvancedEditor.text");
  });

  it("uses i18n fallbacks for every advanced editor error", () => {
    expect(appSource).toContain("ui.xrayJsonValidationFailed");
    expect(appSource).toContain("ui.advancedXrayImportFailed");
    expect(appSource).toContain("ui.advancedXrayExportFailed");
    expect(appSource).toContain("ui.xrayConfigDraftUnavailable");
    expect(appSource).toContain("ui.configSaveFailed");
    expect(appSource).toContain("ui.configValidationFailed");
    expect(appSource).toContain("ui.canonicalXrayReadFailed");
    expect(appSource).toContain('advancedXrayImportFailed: "Xray JSON 导入失败"');
    expect(appSource).toContain('advancedXrayImportFailed: "Xray JSON import failed"');
    expect(appSource).toContain('advancedXrayExportFailed: "Xray JSON 导出失败"');
    expect(appSource).toContain('advancedXrayExportFailed: "Xray JSON export failed"');
    expect(appSource).toContain('configSaveFailed: "配置保存失败"');
    expect(appSource).toContain('configSaveFailed: "Config save failed"');
    expect(appSource).toContain(
      'canonicalXrayReadFailed: "无法读取上次有效 Xray 配置；当前草稿未更改"',
    );
    expect(appSource).toContain(
      'canonicalXrayReadFailed: "Could not read the last valid Xray config; the current draft was not changed"',
    );
    expect(stylesSource).toContain("overflow-wrap: anywhere");
  });
});

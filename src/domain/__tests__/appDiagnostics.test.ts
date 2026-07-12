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

describe("diagnostics UI wiring", () => {
  it("keeps the Diagnose release path read-only", () => {
    const match = /async function diagnoseCoreRelease[\s\S]*?\n  async function downloadLatestRelease/.exec(appSource);

    expect(match?.[0]).toContain("getCoreReleaseDiagnostics(kind)");
    expect(match?.[0]).not.toContain("saveRuntimeSettings");
    expect(match?.[0]).not.toContain("startXray");
    expect(match?.[0]).not.toContain("startTachyonCore");
    expect(match?.[0]).not.toContain("enableSystemProxy");
    expect(match?.[0]).not.toContain("testXrayLocalProxies");
  });

  it("shows a manual redaction review reminder before diagnostics export is shared", () => {
    expect(appSource).toContain("diagnosticsReviewReminder");
    expect(appSource).toContain("diagnostics-review-reminder");
    expect(stylesSource).toContain(".diagnostics-review-reminder");
  });

  it("renders installed release diagnostics as visible wide rows", () => {
    expect(stylesSource).toContain(".release-diagnostics .wide strong");
    expect(stylesSource).toContain("overflow-wrap: anywhere");
    expect(stylesSource).toContain("white-space: normal");
  });

  it("keeps Tachyon Core preflight separate from Xray startup", () => {
    expect(appSource).toContain("preflightTachyonCore");
    expect(appSource).toContain("assertTachyonCoreStartable(paths, settings)");
    expect(appSource).toContain("kind === \"xray\"");
    expect(appSource).toContain("await startXray(settings.xrayBinaryPath, paths.xrayConfigPath)");
    expect(appSource).toContain("await startTachyonCore(settings.tachyonCoreBinaryPath, paths.coreConfigPath)");
  });

  it("explains TUN semantics without claiming game acceleration can run without TUN routing", () => {
    expect(appSource).toContain("Core client still needs TUN device capability");
    expect(appSource).toContain("Xray local HTTP/SOCKS proxy can be usable even when Tachyon Core game acceleration is blocked");
    expect(appSource).not.toContain("Tachyon game acceleration can run without enabling OS TUN routing");
  });

  it("uses atomic dual-core commands and refreshes runtime state after failures", () => {
    const startAll = /async function startAllRuntime[\s\S]*?\n  async function stopAllRuntime/.exec(appSource)?.[0];
    const stopAll = /async function stopAllRuntime[\s\S]*?\n  async function handleWindowAction/.exec(appSource)?.[0];

    expect(startAll).toContain('invokeDesktop<StartAllResult>("start_all"');
    expect(startAll).toContain("setRuntimeStatus(result.runtime)");
    expect(startAll).toContain("String(error || ui.capabilityUnavailable)");
    expect(startAll).toContain("await refreshRuntime()");
    expect(startAll).not.toContain('startRuntime("xray")');
    expect(stopAll).toContain('invokeDesktop<StopAllResult>("stop_all")');
    expect(stopAll).toContain('result.errors.join("; ")');
    expect(stopAll).toContain("await refreshRuntime()");
    expect(stopAll).not.toContain('stopRuntime("xray")');
  });
});

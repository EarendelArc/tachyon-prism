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
});

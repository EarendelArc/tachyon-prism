import { describe, expect, it, vi } from "vitest";
import {
  buildReleaseDiagnosticsDisplay,
  tachyonCorePreflightFallbackMessage,
  tachyonCorePreflightReadinessMessage,
  tachyonCorePreflightStartBlockReason,
  tachyonIpcBaseUrl,
  testXrayLocalProxies,
  type CoreReleaseDiagnostics,
  type TachyonCorePreflightResult,
} from "../runtime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe("tachyonIpcBaseUrl", () => {
  it("uses the configured Tachyon IPC listen address and port", () => {
    expect(
      tachyonIpcBaseUrl({
        tachyonIpcListen: "127.0.0.6",
        tachyonIpcPort: 55124,
      }),
    ).toBe("http://127.0.0.6:55124");
  });

  it("falls back to the default IPC endpoint for empty values", () => {
    expect(
      tachyonIpcBaseUrl({
        tachyonIpcListen: " ",
        tachyonIpcPort: 0,
      }),
    ).toBe("http://127.0.0.1:55123");
  });

  it("wraps IPv6 listen addresses for HTTP URLs", () => {
    expect(
      tachyonIpcBaseUrl({
        tachyonIpcListen: "::1",
        tachyonIpcPort: 55123,
      }),
    ).toBe("http://[::1]:55123");
  });
});

describe("testXrayLocalProxies", () => {
  it("returns HTTP and SOCKS preview probe results outside Tauri", async () => {
    const report = await testXrayLocalProxies("http://example.test/probe");

    expect(report.ok).toBe(true);
    expect(report.http.ok).toBe(true);
    expect(report.socks.ok).toBe(true);
    expect(report.http.via).toContain("10809");
    expect(report.socks.via).toContain("10808");
  });
});

describe("buildReleaseDiagnosticsDisplay", () => {
  it("shows release, checksum, installed path, version, and last error details", () => {
    const diagnostics: CoreReleaseDiagnostics = {
      assetName: "tachyon-core_v0.1.0-alpha.12_windows_amd64.zip",
      assetSizeBytes: 12_320_768,
      assetUrl: "https://example.invalid/tachyon-core.zip",
      checksumActualSha256: "b".repeat(64),
      checksumAssetName: "SHA256SUMS.txt",
      checksumExpectedSha256: "a".repeat(64),
      checksumMatch: true,
      checksumUrl: "https://example.invalid/SHA256SUMS.txt",
      displayName: "Tachyon Core",
      installedExists: true,
      installedPath: "C:\\Users\\tester\\AppData\\Roaming\\tachyon-prism\\bin\\tachyon-core.exe",
      installedVersion: "tachyon-core 0.1.0-alpha.12",
      kind: "tachyonCore",
      lastError: "cached checksum missing",
      resolvedTag: "v0.1.0-alpha.12",
      selectedChannel: "preview",
    };

    const display = buildReleaseDiagnosticsDisplay(diagnostics, (value) => `${value ?? 0} bytes`);
    const rows = new Map(display.rows.map((row) => [row.label, row.value]));

    expect(rows.get("Channel")).toBe("Pre");
    expect(rows.get("Resolved tag")).toBe("v0.1.0-alpha.12");
    expect(rows.get("Asset")).toBe("tachyon-core_v0.1.0-alpha.12_windows_amd64.zip / 12320768 bytes");
    expect(rows.get("Checksum")).toBe("Match");
    expect(rows.get("SHA-256")).toBe("aaaaaaaa...aaaaaaaa");
    expect(rows.get("Installed version")).toBe("tachyon-core 0.1.0-alpha.12");
    expect(rows.get("Installed path")).toBe(
      "C:\\Users\\tester\\AppData\\Roaming\\tachyon-prism\\bin\\tachyon-core.exe",
    );
    expect(display.rows.find((row) => row.label === "Installed version")?.wide).toBe(true);
    expect(display.rows.find((row) => row.label === "Installed path")?.wide).toBe(true);
    expect(display.lastError).toBe("cached checksum missing");
  });

  it("shows installed binaries as not probed when diagnostics skips version execution", () => {
    const diagnostics: CoreReleaseDiagnostics = {
      assetName: null,
      assetSizeBytes: null,
      assetUrl: null,
      checksumActualSha256: null,
      checksumAssetName: null,
      checksumExpectedSha256: null,
      checksumMatch: null,
      checksumUrl: null,
      displayName: "Xray",
      installedExists: true,
      installedPath: "C:\\Users\\tester\\AppData\\Roaming\\tachyon-prism\\bin\\xray.exe",
      installedVersion: null,
      kind: "xray",
      lastError: null,
      resolvedTag: null,
      selectedChannel: "stable",
    };

    const display = buildReleaseDiagnosticsDisplay(diagnostics, (value) => `${value ?? 0} bytes`);
    const versionRow = display.rows.find((row) => row.label === "Installed version");
    const pathRow = display.rows.find((row) => row.label === "Installed path");

    expect(versionRow?.value).toBe("Not probed - diagnostics does not execute installed binaries");
    expect(versionRow?.wide).toBe(true);
    expect(pathRow?.value).toBe("C:\\Users\\tester\\AppData\\Roaming\\tachyon-prism\\bin\\xray.exe");
  });
});

describe("tachyonCore preflight helpers", () => {
  it("blocks Tachyon Core startup for TUN and Wintun preflight errors", () => {
    const result: TachyonCorePreflightResult = {
      checks: [
        {
          code: "WINTUN_DLL_PRESENT",
          details: "Install wintun.dll next to tachyon-core.exe.",
          message: "wintun.dll missing",
          raw: null,
          status: "error",
        },
      ],
      command: "tachyon-core preflight --config client.json --json",
      error: "WINTUN_DLL_PRESENT: wintun.dll missing",
      exitCode: 1,
      ok: false,
      overall: "error",
      rawReport: null,
      stderr: "",
      stdout: "",
      supported: true,
    };

    expect(tachyonCorePreflightStartBlockReason(result)).toContain("Tachyon Core game acceleration cannot start");
    expect(tachyonCorePreflightStartBlockReason(result)).toContain("Xray local proxy can still run independently");
  });

  it("falls back to validate-only mode for old Core without blocking startup", () => {
    const result: TachyonCorePreflightResult = {
      checks: [],
      command: "tachyon-core preflight --config client.json --json",
      error: "Core version lacks preflight; validate only",
      exitCode: 2,
      ok: true,
      overall: "unsupported",
      rawReport: null,
      stderr: "unrecognized subcommand",
      stdout: "",
      supported: false,
    };

    expect(tachyonCorePreflightFallbackMessage(result)).toBe("Core version lacks preflight; validate only");
    expect(tachyonCorePreflightReadinessMessage(result)).toBe("Core version lacks preflight; validate only");
    expect(tachyonCorePreflightStartBlockReason(result)).toBeNull();
  });

  it("blocks targeted startup errors even if overall is not normalized to error", () => {
    const result: TachyonCorePreflightResult = {
      checks: [
        {
          code: "TUN_PRIVILEGE",
          details: "Run Prism as administrator.",
          message: "",
          raw: null,
          status: "error",
        },
      ],
      command: "tachyon-core preflight --config client.json --json",
      error: "TUN_PRIVILEGE: Run Prism as administrator.",
      exitCode: 0,
      ok: false,
      overall: "unknown",
      rawReport: null,
      stderr: "",
      stdout: "",
      supported: true,
    };

    expect(tachyonCorePreflightStartBlockReason(result)).toContain("TUN_PRIVILEGE");
    expect(tachyonCorePreflightReadinessMessage(result)).toContain("preflight found readiness issues");
  });
});

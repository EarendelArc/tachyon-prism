import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  buildReleaseDiagnosticsDisplay,
  commitValidatedXrayConfig,
  readCanonicalXrayConfig,
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

const root = globalThis as typeof globalThis & { isTauri?: boolean };
const invokeMock = vi.mocked(invoke);

afterEach(() => {
  delete root.isTauri;
  invokeMock.mockReset();
});

describe("commitValidatedXrayConfig", () => {
  it("uses the Rust transaction with contents only on first upgrade", async () => {
    root.isTauri = true;
    const paths = {
      configDir: "C:\\Prism\\config",
      coreConfigPath: "C:\\Prism\\config\\client.json",
      xrayConfigPath: "C:\\Prism\\config\\xray-client.json",
    };
    invokeMock.mockResolvedValueOnce(paths);
    const contents = '{"inbounds":[],"outbounds":[]}';

    await expect(commitValidatedXrayConfig(contents)).resolves.toEqual(paths);

    expect(invokeMock).toHaveBeenCalledWith("commit_validated_xray_config", { contents });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a write command after semantic validation fails", async () => {
    root.isTauri = true;
    invokeMock.mockRejectedValueOnce(new Error("Xray semantic validation failed"));

    await expect(commitValidatedXrayConfig('{"outbounds":[]}')).rejects.toThrow(
      "Xray semantic validation failed",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "commit_validated_xray_config",
    ]);
  });

  it("keeps preview mode side-effect free", async () => {
    await expect(commitValidatedXrayConfig('{"outbounds":[]}')).resolves.toMatchObject({
      xrayConfigPath: "Preview mode / xray-client.json",
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("readCanonicalXrayConfig", () => {
  it("reads the controlled canonical Xray file with the Rust command", async () => {
    root.isTauri = true;
    const canonical = {
      exists: true,
      contents: '{"unknownFutureField":{"preserved":true}}',
    };
    invokeMock.mockResolvedValueOnce(canonical);

    await expect(readCanonicalXrayConfig()).resolves.toEqual(canonical);
    expect(invokeMock).toHaveBeenCalledWith("read_canonical_xray_config", undefined);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("reports an absent canonical without inventing fallback contents", async () => {
    root.isTauri = true;
    invokeMock.mockResolvedValueOnce({ exists: false, contents: null });

    await expect(readCanonicalXrayConfig()).resolves.toEqual({
      exists: false,
      contents: null,
    });
  });

  it("keeps preview mode absent and side-effect free", async () => {
    await expect(readCanonicalXrayConfig()).resolves.toEqual({
      exists: false,
      contents: null,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

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
      structuredReport: null,
      stderr: "",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
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
      structuredReport: null,
      stderr: "unrecognized subcommand",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
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
      structuredReport: null,
      stderr: "",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
      supported: true,
    };

    expect(tachyonCorePreflightStartBlockReason(result)).toContain("TUN_PRIVILEGE");
    expect(tachyonCorePreflightReadinessMessage(result)).toContain("preflight found readiness issues");
  });
});

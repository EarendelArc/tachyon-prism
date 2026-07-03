import { describe, expect, it, vi } from "vitest";
import { tachyonIpcBaseUrl, testXrayLocalProxies } from "../runtime";

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

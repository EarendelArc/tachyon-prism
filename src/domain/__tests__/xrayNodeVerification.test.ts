import { describe, expect, it, vi } from "vitest";
import type { LocalProxyProbeReport } from "../runtime";
import { verifySelectedXrayNode } from "../xrayNodeVerification";

const passedReport: LocalProxyProbeReport = {
  checkedAt: 1,
  http: {
    error: null,
    latencyMs: 12,
    ok: true,
    statusCode: 204,
    targetUrl: "http://probe.invalid/generate_204",
    via: "127.0.0.1:10809",
  },
  ok: true,
  socks: {
    error: null,
    latencyMs: 14,
    ok: true,
    statusCode: 204,
    targetUrl: "http://probe.invalid/generate_204",
    via: "socks5://127.0.0.1:10808",
  },
  targetUrl: "http://probe.invalid/generate_204",
};

function operations(overrides: Partial<Parameters<typeof verifySelectedXrayNode>[0]> = {}) {
  return {
    hasSelectedNode: true,
    verify: vi.fn(async () => ({ code: "success" as const, ok: true, report: passedReport })),
    ...overrides,
  };
}

describe("isolated Xray node verification", () => {
  it("requires a selected node without starting a process", async () => {
    const subject = operations({ hasSelectedNode: false });

    await expect(verifySelectedXrayNode(subject)).resolves.toMatchObject({
      code: "node-required",
      ok: false,
    });
    expect(subject.verify).not.toHaveBeenCalled();
  });

  it("preserves the native busy result for an existing Xray session", async () => {
    const subject = operations({
      verify: vi.fn(async () => ({ code: "xray-busy" as const, ok: false, report: null })),
    });

    await expect(verifySelectedXrayNode(subject)).resolves.toMatchObject({
      code: "xray-busy",
      ok: false,
    });
    expect(subject.verify).toHaveBeenCalledOnce();
  });

  it("preserves a successful native dual-proxy report", async () => {
    const subject = operations();

    await expect(verifySelectedXrayNode(subject)).resolves.toEqual({
      code: "success",
      ok: true,
      report: passedReport,
    });
    expect(subject.verify).toHaveBeenCalledOnce();
  });

  it("preserves a failed native probe report", async () => {
    const failed = {
      ...passedReport,
      http: { ...passedReport.http, error: "upstream unavailable", ok: false },
      ok: false,
    };
    const subject = operations({
      verify: vi.fn(async () => ({ code: "probe-failed" as const, ok: false, report: failed })),
    });

    await expect(verifySelectedXrayNode(subject)).resolves.toEqual({
      code: "probe-failed",
      ok: false,
      report: failed,
    });
  });

  it("maps rejected native calls without exposing thrown process output", async () => {
    const secret = "subscription-private-key";
    const subject = operations({
      verify: vi.fn(async () => {
        throw new Error(`failed to verify ${secret}`);
      }),
    });

    const verification = await verifySelectedXrayNode(subject);
    expect(verification).toMatchObject({ code: "start-failed", ok: false });
    expect(JSON.stringify(verification)).not.toContain(secret);
  });

  it("preserves a native cleanup failure without adding diagnostics", async () => {
    const subject = operations({
      verify: vi.fn(async () => ({
        code: "cleanup-failed" as const,
        ok: false,
        report: passedReport,
      })),
    });

    await expect(verifySelectedXrayNode(subject)).resolves.toEqual({
      code: "cleanup-failed",
      ok: false,
      report: passedReport,
    });
  });
});

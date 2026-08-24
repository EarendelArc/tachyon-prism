import { describe, expect, it, vi } from "vitest";
import type { LocalProxyProbeReport } from "../runtime";
import {
  createXrayNodeVerificationRequest,
  verifySelectedXrayNode,
  XrayNodeVerificationGate,
  type XrayNodeVerificationRequest,
  type XrayNodeVerificationResult,
} from "../xrayNodeVerification";

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

const request: XrayNodeVerificationRequest = {
  configDigest: "a".repeat(64),
  contents: "{}",
  nodeId: "node-a",
  requestToken: "request-a",
};

function success(
  identity: XrayNodeVerificationRequest = request,
): XrayNodeVerificationResult {
  return {
    code: "success",
    configDigest: identity.configDigest,
    nodeId: identity.nodeId,
    ok: true,
    report: passedReport,
    requestToken: identity.requestToken,
  };
}

function operations(overrides: Partial<Parameters<typeof verifySelectedXrayNode>[0]> = {}) {
  return {
    hasSelectedNode: true,
    request,
    verify: vi.fn(async () => success()),
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
      verify: vi.fn(async () => ({
        ...success(),
        code: "xray-busy" as const,
        ok: false,
        report: null,
      })),
    });

    await expect(verifySelectedXrayNode(subject)).resolves.toMatchObject({
      code: "xray-busy",
      ok: false,
    });
    expect(subject.verify).toHaveBeenCalledOnce();
  });

  it("preserves a successful native dual-proxy report", async () => {
    const subject = operations();

    await expect(verifySelectedXrayNode(subject)).resolves.toEqual(success());
    expect(subject.verify).toHaveBeenCalledOnce();
  });

  it("preserves a failed native probe report", async () => {
    const failed = {
      ...passedReport,
      http: { ...passedReport.http, error: "upstream unavailable", ok: false },
      ok: false,
    };
    const subject = operations({
      verify: vi.fn(async () => ({
        ...success(),
        code: "probe-failed" as const,
        ok: false,
        report: failed,
      })),
    });

    await expect(verifySelectedXrayNode(subject)).resolves.toEqual({
      ...success(),
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
        ...success(),
        code: "cleanup-failed" as const,
        ok: false,
        report: passedReport,
      })),
    });

    await expect(verifySelectedXrayNode(subject)).resolves.toEqual({
      ...success(),
      code: "cleanup-failed",
      ok: false,
      report: passedReport,
    });
  });

  it("canonicalizes config keys and binds the SHA-256 digest to exact IPC contents", async () => {
    const prepared = await createXrayNodeVerificationRequest(
      "node-a",
      '{"z":1,"nested":{"b":2,"a":1},"a":0}',
      "request-token-a",
    );

    expect(prepared).toEqual({
      configDigest: "429a32bab55fed1602457657d2d3ab25ffedd05b524e2cca83ab644d84ee9e3a",
      contents: '{"a":0,"nested":{"a":1,"b":2},"z":1}',
      nodeId: "node-a",
      requestToken: "request-token-a",
    });
  });

  it("drops an old completion after a second node/config/token transaction starts", () => {
    const gate = new XrayNodeVerificationGate();
    const first = { ...request };
    const second = {
      ...request,
      configDigest: "b".repeat(64),
      nodeId: "node-b",
      requestToken: "request-b",
    };
    gate.begin(first);
    gate.begin(second);

    expect(gate.accepts(success(first))).toBe(false);
    expect(gate.accepts(success(second))).toBe(true);
  });

  it("accepts only the latest transaction when concurrent IPC calls complete out of order", async () => {
    const gate = new XrayNodeVerificationGate();
    const first = { ...request };
    const second = {
      ...request,
      configDigest: "b".repeat(64),
      nodeId: "node-b",
      requestToken: "request-b",
    };
    let finishFirst!: (result: XrayNodeVerificationResult) => void;
    let finishSecond!: (result: XrayNodeVerificationResult) => void;
    const firstCall = new Promise<XrayNodeVerificationResult>((resolve) => {
      finishFirst = resolve;
    });
    const secondCall = new Promise<XrayNodeVerificationResult>((resolve) => {
      finishSecond = resolve;
    });

    gate.begin(first);
    gate.begin(second);
    finishSecond(success(second));
    expect(gate.accepts(await secondCall)).toBe(true);
    finishFirst(success(first));
    expect(gate.accepts(await firstCall)).toBe(false);
  });

  it.each([
    ["node switch", { nodeId: "node-b" }],
    ["subscription refresh", { requestToken: "request-refresh" }],
    ["config edit", { configDigest: "c".repeat(64) }],
  ] as const)("drops a result after %s", (_case, change) => {
    const gate = new XrayNodeVerificationGate();
    gate.begin(request);
    gate.begin({ ...request, ...change });

    expect(gate.accepts(success(request))).toBe(false);
  });

  it("drops pending results when the UI context is invalidated", () => {
    const gate = new XrayNodeVerificationGate();
    gate.begin(request);
    gate.invalidate();

    expect(gate.accepts(success())).toBe(false);
  });
});

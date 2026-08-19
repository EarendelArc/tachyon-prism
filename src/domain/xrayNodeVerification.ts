import type { LocalProxyProbeReport } from "./runtime";

export type XrayNodeVerificationCode =
  | "cleanup-failed"
  | "node-required"
  | "probe-failed"
  | "start-failed"
  | "success"
  | "xray-busy";

export interface XrayNodeVerificationResult {
  code: XrayNodeVerificationCode;
  ok: boolean;
  report: LocalProxyProbeReport | null;
}

export interface XrayNodeVerificationOperations {
  hasSelectedNode: boolean;
  verify: () => Promise<XrayNodeVerificationResult>;
}

export async function verifySelectedXrayNode(
  operations: XrayNodeVerificationOperations,
): Promise<XrayNodeVerificationResult> {
  if (!operations.hasSelectedNode) {
    return result("node-required");
  }
  try {
    return await operations.verify();
  } catch {
    return result("start-failed");
  }
}

function result(
  code: XrayNodeVerificationCode,
  report: LocalProxyProbeReport | null = null,
): XrayNodeVerificationResult {
  return { code, ok: code === "success", report };
}

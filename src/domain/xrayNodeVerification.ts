import type { LocalProxyProbeReport } from "./runtime";

export type XrayNodeVerificationCode =
  | "cleanup-failed"
  | "node-required"
  | "probe-failed"
  | "start-failed"
  | "success"
  | "unsupported"
  | "xray-busy";

export interface XrayNodeVerificationResult {
  code: XrayNodeVerificationCode;
  configDigest: string;
  nodeId: string;
  ok: boolean;
  report: LocalProxyProbeReport | null;
  requestToken: string;
}

export interface XrayNodeVerificationRequest {
  configDigest: string;
  contents: string;
  nodeId: string;
  requestToken: string;
}

export interface XrayNodeVerificationOperations {
  hasSelectedNode: boolean;
  request: XrayNodeVerificationRequest;
  verify: (request: XrayNodeVerificationRequest) => Promise<XrayNodeVerificationResult>;
}

export async function verifySelectedXrayNode(
  operations: XrayNodeVerificationOperations,
): Promise<XrayNodeVerificationResult> {
  if (!operations.hasSelectedNode) {
    return result("node-required", operations.request);
  }
  try {
    return await operations.verify(operations.request);
  } catch {
    return result("start-failed", operations.request);
  }
}

export async function createXrayNodeVerificationRequest(
  nodeId: string,
  contents: string,
  requestToken: string = globalThis.crypto.randomUUID(),
): Promise<XrayNodeVerificationRequest> {
  const canonicalContents = canonicalJsonText(contents);
  const bytes = new TextEncoder().encode(canonicalContents);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const configDigest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    configDigest,
    contents: canonicalContents,
    nodeId,
    requestToken,
  };
}

export class XrayNodeVerificationGate {
  private current: XrayNodeVerificationRequest | null = null;

  begin(request: XrayNodeVerificationRequest): void {
    this.current = request;
  }

  invalidate(): void {
    this.current = null;
  }

  accepts(result: XrayNodeVerificationResult): boolean {
    return this.current !== null && sameIdentity(this.current, result);
  }
}

function result(
  code: XrayNodeVerificationCode,
  request: XrayNodeVerificationRequest,
  report: LocalProxyProbeReport | null = null,
): XrayNodeVerificationResult {
  return {
    code,
    configDigest: request.configDigest,
    nodeId: request.nodeId,
    ok: code === "success",
    report,
    requestToken: request.requestToken,
  };
}

function canonicalJsonText(contents: string): string {
  const value: unknown = JSON.parse(contents);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Xray verification config must be a JSON object");
  }
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function sameIdentity(
  left: Pick<XrayNodeVerificationRequest, "configDigest" | "nodeId" | "requestToken">,
  right: Pick<XrayNodeVerificationResult, "configDigest" | "nodeId" | "requestToken">,
): boolean {
  return left.nodeId === right.nodeId
    && left.configDigest === right.configDigest
    && left.requestToken === right.requestToken;
}

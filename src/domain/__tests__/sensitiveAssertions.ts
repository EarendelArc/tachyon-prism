import { createHash } from "node:crypto";

function sensitiveDigest(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized ?? "undefined").digest("hex");
}

export function assertSensitiveEqual(actual: unknown, expected: unknown): void {
  if (sensitiveDigest(actual) !== sensitiveDigest(expected)) {
    throw new Error("sensitive assertion mismatch");
  }
}

function containsSensitiveShape(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((value, index) => containsSensitiveShape(actual[index], value))
    );
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      containsSensitiveShape((actual as Record<string, unknown>)[key], value),
    );
  }
  return sensitiveDigest(actual) === sensitiveDigest(expected);
}

export function assertSensitiveContains(actual: unknown, expected: unknown): void {
  if (!containsSensitiveShape(actual, expected)) {
    throw new Error("sensitive shape assertion mismatch");
  }
}

export function assertSensitiveInvocation(
  calls: unknown[][],
  index: number,
  command: string,
  payload: unknown,
): void {
  const call = calls[index];
  if (!call || call[0] !== command || sensitiveDigest(call[1]) !== sensitiveDigest(payload)) {
    throw new Error("sensitive invocation mismatch");
  }
}

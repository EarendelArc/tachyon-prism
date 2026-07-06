import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildXrayClientConfigDraft, stringifyDraft } from "../configDrafts";
import { parseSubscription } from "../subscriptions";
import {
  singBoxTuicJsonFixture,
  subscriptionCompatibilityFixtures,
} from "./subscriptionFixtures";

const xrayBinaryPath = process.env.TACHYON_XRAY_BINARY_PATH?.trim();
const itWithXray = xrayBinaryPath ? it : it.skip;
const xrayExecHelper = vi.fn(runXrayConfigTest);

beforeEach(() => {
  xrayExecHelper.mockClear();
});

describe("live Xray config contract", () => {
  itWithXray("generates an xray-client.json accepted by xray run -test -config", () => {
    const [node] = parseSubscription(fixturePayload("xray-full-outbound-json"));
    expect(node).toMatchObject({
      name: "Xray Full Trojan TLS",
      protocol: "trojan",
      address: "xray-trojan.example.com",
      port: 443,
    });

    const config = buildXrayClientConfigDraft(node, {
      enableStats: false,
      httpListen: "127.0.0.1",
      httpPort: 19081,
      routingMode: "global",
      socksListen: "127.0.0.1",
      socksPort: 19080,
    });
    const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-xray-contract-"));
    const configPath = join(tempDir, "xray-client.json");

    try {
      writeFileSync(configPath, stringifyDraft(config), "utf8");
      xrayExecHelper(xrayBinaryPath!, configPath, ["xray-trojan-secret"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks TUIC before any xray exec helper is called", () => {
    const [node] = parseSubscription(singBoxTuicJsonFixture);

    expect(node).toMatchObject({
      name: "sing-box TUIC",
      protocol: "tuic",
      xrayCompatibility: {
        status: "unsupported-by-xray",
      },
    });
    expect(() =>
      buildXrayClientConfigDraft(node, {
        enableStats: false,
        routingMode: "global",
      }),
    ).toThrow(/unsupported-by-xray/);
    expect(xrayExecHelper).not.toHaveBeenCalled();
  });
});

function fixturePayload(id: string): string {
  const fixture = subscriptionCompatibilityFixtures.find((item) => item.id === id);
  if (!fixture) {
    throw new Error(`Missing subscription fixture: ${id}`);
  }
  return fixture.payload;
}

function runXrayConfigTest(binaryPath: string, configPath: string, secrets: string[]): void {
  try {
    execFileSync(binaryPath, ["run", "-test", "-config", configPath], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(xrayFailureSummary(error, secrets));
  }
}

function xrayFailureSummary(error: unknown, secrets: string[]): string {
  const details = error as {
    message?: string;
    signal?: string;
    status?: number;
    stderr?: Buffer | string;
    stdout?: Buffer | string;
  };
  const stdout = redactSecrets(String(details.stdout ?? ""), secrets);
  const stderr = redactSecrets(String(details.stderr ?? ""), secrets);
  return [
    "xray run -test -config failed",
    `status: ${details.status ?? "unknown"}`,
    `signal: ${details.signal ?? "none"}`,
    `message: ${redactSecrets(details.message ?? "unknown error", secrets)}`,
    `stdout: ${truncateOutput(stdout)}`,
    `stderr: ${truncateOutput(stderr)}`,
  ].join("\n");
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (output, secret) => (secret ? output.split(secret).join("[redacted]") : output),
    value,
  );
}

function truncateOutput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}...` : trimmed;
}

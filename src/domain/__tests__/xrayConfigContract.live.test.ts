import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildXrayClientConfigDraft, stringifyDraft } from "../configDrafts";
import { parseSubscription } from "../subscriptions";
import type { ProxyProtocol } from "../subscriptions";
import {
  singBoxTuicJsonFixture,
  subscriptionCompatibilityFixtures,
} from "./subscriptionFixtures";

const xrayBinaryPath = process.env.TACHYON_XRAY_BINARY_PATH?.trim();
const itWithXray = xrayBinaryPath ? it : it.skip;
const xrayExecHelper = vi.fn(runXrayConfigTest);
const baseLiveContractCases: Array<Omit<LiveContractCase, "portOffset">> = [
  { fixtureId: "vless-ws-tls", protocol: "vless", secrets: ["vless-ws-uuid"] },
  { fixtureId: "vmess-ws-tls", protocol: "vmess", secrets: ["vmess-uuid"] },
  { fixtureId: "trojan-tls", protocol: "trojan", secrets: ["trojan-secret"] },
  { fixtureId: "shadowsocks-aead", protocol: "shadowsocks", secrets: ["ss-secret"] },
  { fixtureId: "socks", protocol: "socks", secrets: ["socks-user", "socks-pass"] },
  { fixtureId: "http", protocol: "http", secrets: ["http-user", "http-pass"] },
  { fixtureId: "hysteria2", protocol: "hysteria", secrets: ["hy-secret"] },
  {
    fixtureId: "wireguard",
    protocol: "wireguard",
    secrets: [
      "kC+rcYLfu5eDay+B38l+3BsaCj3SaHEsLVVDnDcifUY=",
      "bmksqJz2tpgoNqoSqIxgcSxosP2NfQ2fK10zzju93yI=",
    ],
  },
];
const liveContractCases: LiveContractCase[] = baseLiveContractCases.map((item, portOffset) => ({
  ...item,
  portOffset,
}));

beforeEach(() => {
  xrayExecHelper.mockClear();
});

describe("live Xray config contract", () => {
  itWithXray.each(liveContractCases)(
    "generates an xray-client.json for $protocol accepted by xray run -test -config",
    ({ fixtureId, protocol, secrets, portOffset }) => {
      const [node] = parseSubscription(fixturePayload(fixtureId));
      expect(node).toMatchObject({ protocol });

      const config = buildXrayClientConfigDraft(node, {
        enableStats: false,
        httpListen: "127.0.0.1",
        httpPort: 19081 + portOffset * 2,
        routingMode: "global",
        socksListen: "127.0.0.1",
        socksPort: 19080 + portOffset * 2,
      });
      const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-xray-contract-"));
      const configPath = join(tempDir, "xray-client.json");

      try {
        writeFileSync(configPath, stringifyDraft(config), "utf8");
        xrayExecHelper(xrayBinaryPath!, configPath, secrets);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

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

interface LiveContractCase {
  fixtureId: string;
  portOffset: number;
  protocol: ProxyProtocol;
  secrets: string[];
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

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
// Stable X25519 Reality public key input for live config validation.
const realityPublicKey = "QNNCH0rpsoqjwyLiEuvvM38dpQaSteremSU96JdCuC8";
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
  {
    payload: `vless://reality-raw-uuid@reality-raw.example.com:443?encryption=none&type=tcp&security=reality&sni=www.cloudflare.com&pbk=${realityPublicKey}&sid=01&flow=xtls-rprx-vision#VLESS Reality Raw`,
    protocol: "vless",
    secrets: ["reality-raw-uuid"],
  },
  {
    payload: `vless://reality-xhttp-uuid@reality-xhttp.example.com:443?encryption=none&type=splithttp&security=reality&sni=www.cloudflare.com&pbk=${realityPublicKey}&path=/xhttp&mode=auto#VLESS Reality XHTTP`,
    protocol: "vless",
    secrets: ["reality-xhttp-uuid"],
  },
  {
    payload: `vless://reality-grpc-uuid@reality-grpc.example.com:443?encryption=none&type=grpc&security=reality&sni=www.cloudflare.com&pbk=${realityPublicKey}&serviceName=tunnel#VLESS Reality gRPC`,
    protocol: "vless",
    secrets: ["reality-grpc-uuid"],
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
    ({ fixtureId, payload, protocol, secrets, portOffset }) => {
      const [node] = parseSubscription(resolveLiveContractPayload(fixtureId, payload));
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
    15_000,
  );

  itWithXray.each(["direct", "global", "rule"] as const)(
    "accepts isolated selected-node routing when the UI mode is %s",
    (routingMode) => {
      const [node] = parseSubscription(fixturePayload("socks"));
      const config = buildXrayClientConfigDraft(node, {
        enableStats: true,
        httpPort: 19201,
        purpose: "node-verification",
        routingMode,
        socksPort: 19200,
      });
      const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-xray-isolated-contract-"));
      const configPath = join(tempDir, "xray-client.json");

      try {
        writeFileSync(configPath, stringifyDraft(config), "utf8");
        xrayExecHelper(xrayBinaryPath!, configPath, ["socks-user", "socks-pass"]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  itWithXray("accepts a managed-tag merge from an imported multi-outbound config", () => {
    const payload = JSON.stringify({
      log: { loglevel: "warning" },
      inbounds: [
        {
          tag: "tachyon-socks",
          listen: "127.0.0.1",
          port: 19120,
          protocol: "socks",
          settings: { auth: "noauth", udp: true },
        },
      ],
      routing: {
        domainStrategy: "AsIs",
        rules: [
          {
            type: "field",
            inboundTag: ["tachyon-socks"],
            outboundTag: "tachyon-proxy",
          },
        ],
      },
      outbounds: [
        {
          tag: "tachyon-proxy",
          protocol: "freedom",
          settings: { domainStrategy: "UseIPv4" },
        },
        {
          tag: "user-backup",
          protocol: "freedom",
          settings: { domainStrategy: "UseIPv6" },
        },
      ],
    });
    const nodes = parseSubscription(payload);
    const config = buildXrayClientConfigDraft(nodes[1], {
      enableStats: false,
      httpPort: 19122,
      routingMode: "global",
      socksPort: 19121,
    });
    const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-xray-import-contract-"));
    const configPath = join(tempDir, "xray-client.json");

    try {
      writeFileSync(configPath, stringifyDraft(config), "utf8");
      xrayExecHelper(xrayBinaryPath!, configPath, []);
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

function resolveLiveContractPayload(fixtureId: string | undefined, payload: string | undefined): string {
  if (payload) {
    return payload;
  }
  if (fixtureId) {
    return fixturePayload(fixtureId);
  }
  throw new Error("Live contract case is missing a payload");
}

interface LiveContractCase {
  fixtureId?: string;
  payload?: string;
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

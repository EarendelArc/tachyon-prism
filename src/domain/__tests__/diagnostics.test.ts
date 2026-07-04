import { describe, expect, it } from "vitest";
import {
  buildClientDiagnosticsExport,
  redactDiagnosticsValue,
  redactSubscriptionUrl,
  stringifyDiagnosticsExport,
} from "../diagnostics";
import type { CoreReleaseDiagnostics, RuntimeSettings } from "../runtime";
import type { ProxyNode, SubscriptionSnapshot } from "../subscriptions";

const runtimeSettings: RuntimeSettings = {
  systemProxyBypass: "localhost;127.*;<local>",
  tachyonConnectionMigration: true,
  tachyonCoreBinaryPath: "C:\\Prism\\bin\\tachyon-core.exe",
  tachyonCoreReleaseChannel: "preview",
  tachyonFecAdaptWindow: 32,
  tachyonFecDataShards: 4,
  tachyonFecDynamic: true,
  tachyonFecGroupTimeoutMs: 20,
  tachyonFecParityShards: 2,
  tachyonGrpcListen: "127.0.0.1",
  tachyonGrpcPort: 50051,
  tachyonIpcListen: "127.0.0.1",
  tachyonIpcPort: 55123,
  tachyonLocalAddrs: "",
  tachyonMultipath: false,
  tachyonServerAddress: "game.example.com",
  tachyonTelemetryIntervalMs: 1000,
  tachyonTgpAuthPsk: "do-not-export-this-psk",
  tachyonTgpServerAddress: "game.example.com:443",
  tachyonTunAddress: "198.18.0.1/16",
  tachyonTunAutoRoute: false,
  tachyonTunDnsHijack: false,
  tachyonTunMtu: 9000,
  xrayBinaryPath: "C:\\Prism\\bin\\xray.exe",
  xrayHttpListen: "127.0.0.1",
  xrayHttpPort: 10809,
  xrayReleaseChannel: "stable",
  xraySocksListen: "127.0.0.1",
  xraySocksPort: 10808,
  xrayStatsEnabled: true,
  xrayStatsListen: "127.0.0.1",
  xrayStatsPort: 10085,
};

const secretUuid = "123e4567-e89b-12d3-a456-426614174000";
const trojanPassword = "trojan-password-secret";
const subscriptionToken = "sub-token-0123456789abcdef0123456789abcdef";

const node: ProxyNode = {
  address: "edge.secret.example.com",
  credential: secretUuid,
  id: "node-aaaa",
  name: "Reality Node",
  outbound: {
    protocol: "vless",
    settings: {
      id: secretUuid,
    },
    streamSettings: {
      realitySettings: {
        privateKey: "reality-private-key",
        serverName: "www.example.com",
        shortId: "0123456789abcdef",
      },
    },
  },
  parameters: {
    password: trojanPassword,
    token: subscriptionToken,
  },
  port: 443,
  protocol: "vless",
  rawUri: `vless://${secretUuid}@edge.secret.example.com:443?token=${subscriptionToken}#Reality`,
  security: "reality",
  sni: "www.example.com",
  transport: "raw",
};

const subscription: SubscriptionSnapshot = {
  nodes: [node],
  selectedNodeId: node.id,
  selectedSubscriptionId: "sub-main",
  sourceUrl: `https://sub.example.com/client/${subscriptionToken}?token=${subscriptionToken}`,
  subscriptions: [
    {
      id: "sub-main",
      name: "Main",
      nodes: [
        node,
        {
          ...node,
          id: "node-bbbb",
          protocol: "trojan",
          rawUri: `trojan://${trojanPassword}@trojan.example.com:443`,
        },
      ],
      sourceUrl: `https://sub.example.com/client/${subscriptionToken}?token=${subscriptionToken}`,
      updatedAt: "2026-07-04T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-07-04T00:00:00.000Z",
};

const xrayDiagnostics: CoreReleaseDiagnostics = {
  assetName: "Xray-windows-64.zip",
  assetSizeBytes: 1234,
  assetUrl: "https://github.com/XTLS/Xray-core/releases/download/v1/Xray-windows-64.zip",
  checksumActualSha256: "b".repeat(64),
  checksumAssetName: "Xray-windows-64.zip.dgst",
  checksumExpectedSha256: "a".repeat(64),
  checksumMatch: false,
  checksumUrl: "https://github.com/XTLS/Xray-core/releases/download/v1/Xray-windows-64.zip.dgst",
  displayName: "Xray Core",
  installedExists: true,
  installedPath: "C:\\Prism\\bin\\xray.exe",
  installedVersion: null,
  kind: "xray",
  lastError: `failed for user ${secretUuid}`,
  resolvedTag: "v1.0.0",
  selectedChannel: "stable",
};

describe("redactSubscriptionUrl", () => {
  it("removes subscription URL credentials, token query values, and long path tokens", () => {
    expect(
      redactSubscriptionUrl(
        `https://user:pass@example.com/api/${subscriptionToken}?token=${subscriptionToken}&uuid=${secretUuid}#${subscriptionToken}`,
      ),
    ).toBe("https://example.com/api/[redacted]?token=%5Bredacted%5D&uuid=%5Bredacted%5D#[redacted]");
  });
});

describe("redactDiagnosticsValue", () => {
  it("redacts nested credentials and UUID-like values", () => {
    const redacted = redactDiagnosticsValue({
      id: secretUuid,
      nested: {
        privateKey: "private-key-value",
        publicNote: `uuid ${secretUuid}`,
      },
      password: trojanPassword,
      token: subscriptionToken,
    });

    expect(redacted).toEqual({
      id: "[redacted]",
      nested: {
        privateKey: "[redacted]",
        publicNote: "uuid [redacted]",
      },
      password: "[redacted]",
      token: "[redacted]",
    });
  });
});

describe("buildClientDiagnosticsExport", () => {
  it("exports the support structure without subscription secrets or node credentials", () => {
    const diagnostics = buildClientDiagnosticsExport({
      generatedAt: "2026-07-04T12:00:00.000Z",
      managedBinaries: null,
      platform: "Win32",
      recentErrors: [`proxy failed for ${secretUuid}`],
      releaseDiagnostics: { xray: xrayDiagnostics },
      runtimeSettings,
      runtimeStatus: {
        tachyonCore: {
          binaryPath: runtimeSettings.tachyonCoreBinaryPath,
          configPath: "C:\\Prism\\client.json",
          lastError: `psk ${runtimeSettings.tachyonTgpAuthPsk}`,
          pid: null,
          startedAt: null,
          state: "failed",
        },
        xray: {
          binaryPath: runtimeSettings.xrayBinaryPath,
          configPath: "C:\\Prism\\xray-client.json",
          lastError: null,
          pid: 1234,
          startedAt: 1,
          state: "running",
        },
      },
      selectedNode: node,
      subscription,
      userAgent: "vitest",
      version: "0.1.0-test",
      xrayLocalProxyProbe: {
        checkedAt: 1,
        http: {
          error: null,
          latencyMs: 12,
          ok: true,
          statusCode: 204,
          targetUrl: "http://cp.cloudflare.com/generate_204",
          via: "127.0.0.1:10809",
        },
        ok: true,
        socks: {
          error: null,
          latencyMs: 15,
          ok: true,
          statusCode: 204,
          targetUrl: "http://cp.cloudflare.com/generate_204",
          via: "socks5://127.0.0.1:10808",
        },
        targetUrl: "http://cp.cloudflare.com/generate_204",
      },
    });
    const output = stringifyDiagnosticsExport(diagnostics);

    expect(diagnostics.safety).toMatchObject({
      noSpawn: true,
      noSystemProxy: true,
      noTun: true,
      readOnly: true,
    });
    expect(diagnostics.runtime.releaseChannels).toEqual({
      tachyonCore: "preview",
      xray: "stable",
    });
    expect(diagnostics.subscriptions).toMatchObject({
      activeGroup: "Main",
      protocolCounts: { trojan: 1, vless: 1 },
      totalGroups: 1,
      totalNodes: 2,
    });
    expect(diagnostics.selectedNode).toEqual({
      address: "ed***.example.com",
      credentialPresent: true,
      name: "Reality Node",
      port: 443,
      protocol: "vless",
      rawUriScheme: "vless",
      security: "reality",
      sni: "ww***.example.com",
      transport: "raw",
    });
    expect(output).not.toContain(secretUuid);
    expect(output).not.toContain(trojanPassword);
    expect(output).not.toContain(subscriptionToken);
    expect(output).not.toContain(runtimeSettings.tachyonTgpAuthPsk);
    expect(output).not.toContain('"rawUri":');
    expect(output).not.toContain('"outbound":');
  });
});

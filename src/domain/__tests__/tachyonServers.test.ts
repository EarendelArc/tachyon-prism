import { describe, expect, it } from "vitest";
import { buildCoreClientConfigDraft } from "../configDrafts";
import { assertSensitiveEqual } from "./sensitiveAssertions";
import {
  activeTachyonServer,
  draftFromTachyonServerProfile,
  emptyTachyonServerSnapshot,
  removeTachyonServerProfile,
  selectTachyonServerProfile,
  tachyonServerEndpoint,
  tachyonServerSnapshotForStorage,
  tachyonServerSnapshotFromStored,
  upsertTachyonServerProfile,
} from "../tachyonServers";

describe("tachyon server profiles", () => {
  it("stores Tachyon server profiles independently from Xray nodes", () => {
    const snapshot = upsertTachyonServerProfile(emptyTachyonServerSnapshot, {
      name: "Game Relay",
      address: "tachyon://relay.example.com",
      port: 443,
      psk: "0123456789abcdef",
      remark: "low-latency profile",
    });

    const active = activeTachyonServer(snapshot);
    expect(active).toMatchObject({
      name: "Game Relay",
      address: "relay.example.com",
      port: 443,
    });
    assertSensitiveEqual(active?.psk, "0123456789abcdef");
    expect(active?.id).toMatch(/^tachyon-server-/);
    expect(tachyonServerEndpoint(active)).toBe("relay.example.com:443");
  });

  it("generates Core client JSON with tgp.auth.psk from the selected profile", () => {
    const snapshot = upsertTachyonServerProfile(emptyTachyonServerSnapshot, {
      name: "PSK Relay",
      address: "relay.example.com",
      port: 2443,
      psk: "psk-value-012345",
      remark: "",
    });
    const active = activeTachyonServer(snapshot);
    const config = buildCoreClientConfigDraft({
      serverAddr: tachyonServerEndpoint(active),
      tgpAuthPsk: active?.psk,
    });
    const client = config.client as Record<string, unknown>;
    const proxy = client.proxy as Record<string, unknown>;
    const tgp = config.tgp as Record<string, unknown>;

    expect(proxy.server_addr).toBe("relay.example.com:2443");
    assertSensitiveEqual(tgp.auth, { psk: "psk-value-012345" });
  });

  it("selects and removes profiles without touching other entries", () => {
    const first = upsertTachyonServerProfile(emptyTachyonServerSnapshot, {
      name: "Alpha",
      address: "alpha.example.com",
      port: 443,
      psk: "alpha-psk-012345",
      remark: "",
    });
    const second = upsertTachyonServerProfile(first, {
      name: "Beta",
      address: "beta.example.com",
      port: 8443,
      psk: "beta-psk-0123456",
      remark: "",
    });
    const alphaId = second.profiles.find((profile) => profile.name === "Alpha")?.id ?? "";
    const selected = selectTachyonServerProfile(second, alphaId);

    expect(activeTachyonServer(selected)?.name).toBe("Alpha");

    const removed = removeTachyonServerProfile(selected, alphaId);
    expect(removed.profiles).toHaveLength(1);
    expect(activeTachyonServer(removed)?.name).toBe("Beta");
  });

  it("rejects incomplete server drafts", () => {
    expect(() =>
      upsertTachyonServerProfile(emptyTachyonServerSnapshot, {
        name: "Short PSK",
        address: "relay.example.com",
        port: 443,
        psk: "short",
        remark: "",
      }),
    ).toThrow(/PSK/);

    expect(() =>
      upsertTachyonServerProfile(emptyTachyonServerSnapshot, {
        name: "Missing address",
        address: "",
        port: 443,
        psk: "0123456789abcdef",
        remark: "",
      }),
    ).toThrow(/address/);
  });

  it("round-trips normalized profiles through the vault payload", () => {
    const snapshot = upsertTachyonServerProfile(emptyTachyonServerSnapshot, {
      name: "Stored",
      address: "stored.example.com",
      port: 443,
      psk: "stored-psk-01234",
      remark: "saved",
    });

    const loaded = tachyonServerSnapshotFromStored(
      tachyonServerSnapshotForStorage(snapshot),
    );

    expect(activeTachyonServer(loaded)?.name).toBe("Stored");
    const loadedDraft = draftFromTachyonServerProfile(activeTachyonServer(loaded));
    expect(loadedDraft).toMatchObject({
      address: "stored.example.com",
    });
    assertSensitiveEqual(loadedDraft.psk, "stored-psk-01234");
  });
});

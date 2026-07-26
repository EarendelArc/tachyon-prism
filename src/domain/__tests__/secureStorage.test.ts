import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tauriMocks = vi.hoisted(() => ({
  invokeDesktop: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("../tauri", () => tauriMocks);

import {
  clearSecureStorage,
  hasLegacySecureStorage,
  initializeSecureStorage,
  saveSecureStorageSection,
  secureVaultSections,
  SecureStorageError,
} from "../secureStorage";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
  tauriMocks.invokeDesktop.mockReset();
  tauriMocks.isTauriRuntime.mockReturnValue(true);
});

afterEach(() => {
  if (originalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("secure storage migration", () => {
  it("removes legacy plaintext only after the backend returns identical data", async () => {
    const subscriptions = {
      sourceUrl: "https://subscriber:token@example.test/private",
      subscriptions: [],
    };
    const servers = {
      profiles: [{ id: "relay", psk: "private-tgp-psk" }],
      selectedProfileId: "relay",
    };
    store.set("tachyon.prism.subscription.v1", JSON.stringify(subscriptions));
    store.set("tachyon.prism.tachyonServers.v1", JSON.stringify(servers));
    tauriMocks.invokeDesktop.mockResolvedValue({
      version: 1,
      revision: 1,
      migratedSections: ["subscriptions", "tachyonServers"],
      payload: { subscriptions, tachyonServers: servers },
    });

    const result = await initializeSecureStorage();

    expect(result.payload).toEqual({ subscriptions, tachyonServers: servers });
    expect(store.has("tachyon.prism.subscription.v1")).toBe(false);
    expect(store.has("tachyon.prism.tachyonServers.v1")).toBe(false);
    expect(store.get("tachyon.prism.secureMigration.v1")).toBe("complete");
    expect(tauriMocks.invokeDesktop).toHaveBeenCalledWith("migrate_secure_vault", {
      payload: { subscriptions, tachyonServers: servers },
    });
  });

  it("preserves every legacy plaintext value when migration fails", async () => {
    const raw = JSON.stringify({ sourceUrl: "https://example.test/secret" });
    store.set("tachyon.prism.subscription.v1", raw);
    tauriMocks.invokeDesktop.mockRejectedValue(new Error("secure-vault-keyring-unavailable"));

    await expect(initializeSecureStorage()).rejects.toMatchObject({
      code: "secure-vault-keyring-unavailable",
    });
    expect(store.get("tachyon.prism.subscription.v1")).toBe(raw);
    expect(store.has("tachyon.prism.secureMigration.v1")).toBe(false);
  });

  it("preserves legacy data when write-back verification differs", async () => {
    const raw = JSON.stringify({ profiles: [{ psk: "legacy-secret" }] });
    store.set("tachyon.prism.tachyonServers.v1", raw);
    tauriMocks.invokeDesktop.mockResolvedValue({
      version: 1,
      revision: 2,
      migratedSections: [],
      payload: { tachyonServers: { profiles: [] } },
    });

    await expect(initializeSecureStorage()).rejects.toEqual(
      new SecureStorageError("secure-vault-migration-verification-failed"),
    );
    expect(store.get("tachyon.prism.tachyonServers.v1")).toBe(raw);
  });

  it("is idempotent after a completed migration", async () => {
    tauriMocks.invokeDesktop.mockResolvedValue({
      version: 1,
      revision: 3,
      migratedSections: [],
      payload: {},
    });

    const first = await initializeSecureStorage();
    const second = await initializeSecureStorage();

    expect(first).toEqual(second);
    expect(hasLegacySecureStorage()).toBe(false);
    expect(tauriMocks.invokeDesktop).toHaveBeenCalledTimes(2);
  });

  it("does not delete malformed legacy data", async () => {
    store.set("tachyon.prism.subscription.v1", "{not-json");

    await expect(initializeSecureStorage()).rejects.toMatchObject({
      code: "secure-vault-legacy-invalid",
    });
    expect(store.get("tachyon.prism.subscription.v1")).toBe("{not-json");
    expect(tauriMocks.invokeDesktop).not.toHaveBeenCalled();
  });
});

describe("secure storage commands", () => {
  it("saves a whitelisted section through Tauri without browser fallback", async () => {
    tauriMocks.invokeDesktop.mockResolvedValue({ version: 1, revision: 4, payload: {} });

    await saveSecureStorageSection(secureVaultSections.runtimeTgpAuthPsk, "private-psk");

    expect(tauriMocks.invokeDesktop).toHaveBeenCalledWith("save_secure_vault_section", {
      section: "runtimeTgpAuthPsk",
      value: "private-psk",
    });
    expect([...store.values()].join("\n")).not.toContain("private-psk");
  });

  it("fails closed when the Tauri runtime is unavailable", async () => {
    tauriMocks.isTauriRuntime.mockReturnValue(false);

    await expect(initializeSecureStorage()).rejects.toMatchObject({
      code: "secure-vault-runtime-unavailable",
    });
    expect(tauriMocks.invokeDesktop).not.toHaveBeenCalled();
  });

  it("clears the vault and every legacy sensitive key", async () => {
    store.set("tachyon.prism.subscription.v1", "secret-subscription");
    store.set("tachyon.prism.tachyonServers.v1", "secret-psk");
    store.set("tachyon.prism.xrayAdvancedEditor.v1", "secret-outbound");
    tauriMocks.invokeDesktop.mockResolvedValue(undefined);

    await clearSecureStorage();

    expect(tauriMocks.invokeDesktop).toHaveBeenCalledWith("clear_secure_vault");
    expect(store.size).toBe(0);
  });
});

describe("renderer secret boundary", () => {
  it("keeps subscriptions, Xray outbounds, and TGP PSKs out of feature localStorage", () => {
    const subscriptionsSource = readFileSync(
      fileURLToPath(new URL("../subscriptions.ts", import.meta.url)),
      "utf8",
    );
    const tachyonServersSource = readFileSync(
      fileURLToPath(new URL("../tachyonServers.ts", import.meta.url)),
      "utf8",
    );
    const appSource = readFileSync(
      fileURLToPath(new URL("../../App.tsx", import.meta.url)),
      "utf8",
    );

    expect(subscriptionsSource).not.toContain("localStorage");
    expect(tachyonServersSource).not.toContain("localStorage");
    expect(appSource).not.toContain("tachyon.prism.subscription.v1");
    expect(appSource).not.toContain("tachyon.prism.tachyonServers.v1");
    expect(appSource).not.toContain("tachyon.prism.xrayAdvancedEditor.v1");
    expect(appSource).toContain("saveSecureStorageSection");
  });

  it("contains localized fail-closed and migration messages", () => {
    const appSource = readFileSync(
      fileURLToPath(new URL("../../App.tsx", import.meta.url)),
      "utf8",
    );
    expect(appSource).toContain("敏感配置迁移失败");
    expect(appSource).toContain("Sensitive settings migration failed");
    expect(appSource).toContain("系统安全存储不可用");
    expect(appSource).toContain("System secure storage is unavailable");
  });
});

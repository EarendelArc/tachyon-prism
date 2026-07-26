import { invokeDesktop, isTauriRuntime } from "./tauri";

export const secureVaultSections = {
  runtimeTgpAuthPsk: "runtimeTgpAuthPsk",
  subscriptions: "subscriptions",
  tachyonServers: "tachyonServers",
  xrayAdvancedEditor: "xrayAdvancedEditor",
} as const;

export type SecureVaultSection =
  (typeof secureVaultSections)[keyof typeof secureVaultSections];

export interface SecureVaultPayload {
  subscriptions?: unknown;
  tachyonServers?: unknown;
  xrayAdvancedEditor?: unknown;
  runtimeTgpAuthPsk?: unknown;
}

export interface SecureVaultLoadResult {
  version: number;
  revision: number;
  payload: SecureVaultPayload;
}

export interface SecureVaultMigrationResult extends SecureVaultLoadResult {
  migratedSections: string[];
}

export class SecureStorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SecureStorageError";
  }
}

const legacyStorageKeys = {
  subscriptions: "tachyon.prism.subscription.v1",
  tachyonServers: "tachyon.prism.tachyonServers.v1",
  xrayAdvancedEditor: "tachyon.prism.xrayAdvancedEditor.v1",
} as const;

const migrationMarkerKey = "tachyon.prism.secureMigration.v1";
const uiSmokeVaultKey = "tachyon.prism.uiSmokeVault.v1";

interface UiSmokeVaultDocument extends SecureVaultLoadResult {}

function usesUiSmokeVault(): boolean {
  return import.meta.env.MODE === "ui-smoke";
}

export async function initializeSecureStorage(): Promise<SecureVaultMigrationResult> {
  if (!isTauriRuntime() && !usesUiSmokeVault()) {
    throw new SecureStorageError("secure-vault-runtime-unavailable");
  }

  const legacy = readLegacySecurePayload();
  let migration: SecureVaultMigrationResult;
  try {
    migration = usesUiSmokeVault()
      ? uiSmokeMigrate(legacy.payload)
      : await invokeDesktop<SecureVaultMigrationResult>("migrate_secure_vault", {
          payload: legacy.payload,
        });
  } catch (error) {
    throw secureStorageError(error);
  }

  verifyLegacyMigration(legacy.payload, migration.payload);
  for (const key of legacy.keys) {
    globalThis.localStorage?.removeItem(key);
  }
  globalThis.localStorage?.setItem(migrationMarkerKey, "complete");
  return migration;
}

export async function loadSecureStorage(): Promise<SecureVaultLoadResult> {
  if (usesUiSmokeVault()) return uiSmokeLoad();
  try {
    return await invokeDesktop<SecureVaultLoadResult>("load_secure_vault");
  } catch (error) {
    throw secureStorageError(error);
  }
}

export async function saveSecureStorageSection(
  section: SecureVaultSection,
  value: unknown,
): Promise<SecureVaultLoadResult> {
  if (usesUiSmokeVault()) return uiSmokeSaveSection(section, value);
  try {
    return await invokeDesktop<SecureVaultLoadResult>("save_secure_vault_section", {
      section,
      value,
    });
  } catch (error) {
    throw secureStorageError(error);
  }
}

export async function clearSecureStorage(): Promise<void> {
  if (usesUiSmokeVault()) {
    globalThis.localStorage?.removeItem(uiSmokeVaultKey);
  } else {
    try {
      await invokeDesktop<void>("clear_secure_vault");
    } catch (error) {
      throw secureStorageError(error);
    }
  }
  for (const key of Object.values(legacyStorageKeys)) {
    globalThis.localStorage?.removeItem(key);
  }
  globalThis.localStorage?.removeItem(migrationMarkerKey);
}

function uiSmokeLoad(): UiSmokeVaultDocument {
  const raw = globalThis.localStorage?.getItem(uiSmokeVaultKey);
  if (!raw) return { version: 1, revision: 0, payload: {} };
  try {
    const parsed = JSON.parse(raw) as UiSmokeVaultDocument;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || !parsed.payload) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new SecureStorageError("secure-vault-corrupt");
  }
}

function uiSmokePersist(document: UiSmokeVaultDocument): UiSmokeVaultDocument {
  globalThis.localStorage?.setItem(uiSmokeVaultKey, JSON.stringify(document));
  return structuredClone(document);
}

function uiSmokeSaveSection(
  section: SecureVaultSection,
  value: unknown,
): UiSmokeVaultDocument {
  const current = uiSmokeLoad();
  return uiSmokePersist({
    version: 1,
    revision: current.revision + 1,
    payload: { ...current.payload, [section]: structuredClone(value) },
  });
}

function uiSmokeMigrate(payload: SecureVaultPayload): SecureVaultMigrationResult {
  const current = uiSmokeLoad();
  const nextPayload = { ...current.payload };
  const migratedSections: string[] = [];
  for (const [section, value] of Object.entries(payload)) {
    if (section in nextPayload) continue;
    nextPayload[section as keyof SecureVaultPayload] = structuredClone(value);
    migratedSections.push(section);
  }
  const next = migratedSections.length
    ? uiSmokePersist({ version: 1, revision: current.revision + 1, payload: nextPayload })
    : current;
  return { ...next, migratedSections };
}

export function hasLegacySecureStorage(): boolean {
  return Object.values(legacyStorageKeys).some(
    (key) => globalThis.localStorage?.getItem(key) !== null,
  );
}

function readLegacySecurePayload(): {
  payload: SecureVaultPayload;
  keys: string[];
} {
  const payload: SecureVaultPayload = {};
  const keys: string[] = [];
  for (const [section, key] of Object.entries(legacyStorageKeys)) {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new SecureStorageError("secure-vault-legacy-invalid");
    }
    payload[section as keyof SecureVaultPayload] = value;
    keys.push(key);
  }
  return { payload, keys };
}

function verifyLegacyMigration(
  legacy: SecureVaultPayload,
  persisted: SecureVaultPayload,
): void {
  for (const section of Object.keys(legacy) as Array<keyof SecureVaultPayload>) {
    if (!deepEqualJson(legacy[section], persisted[section])) {
      throw new SecureStorageError("secure-vault-migration-verification-failed");
    }
  }
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function secureStorageError(error: unknown): SecureStorageError {
  if (error instanceof SecureStorageError) {
    return error;
  }
  const code = error instanceof Error ? error.message : String(error);
  return new SecureStorageError(
    code.startsWith("secure-vault-") ? code : "secure-vault-unavailable",
  );
}

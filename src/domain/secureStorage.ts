import { secureStorageBackend } from "./secureStorageBackend";
import type {
  SecureVaultLoadResult,
  SecureVaultMigrationResult,
  SecureVaultPayload,
} from "./secureStorageContract";

export type {
  SecureVaultLoadResult,
  SecureVaultMigrationResult,
  SecureVaultPayload,
} from "./secureStorageContract";

export const secureVaultSections = {
  runtimeTgpAuthPsk: "runtimeTgpAuthPsk",
  subscriptions: "subscriptions",
  tachyonServers: "tachyonServers",
  xrayAdvancedEditor: "xrayAdvancedEditor",
} as const;

export type SecureVaultSection =
  (typeof secureVaultSections)[keyof typeof secureVaultSections];

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

export async function initializeSecureStorage(): Promise<SecureVaultMigrationResult> {
  if (!secureStorageBackend.available()) {
    throw new SecureStorageError("secure-vault-runtime-unavailable");
  }

  const legacy = readLegacySecurePayload();
  let migration: SecureVaultMigrationResult;
  try {
    migration = await secureStorageBackend.migrate(legacy.payload);
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
  try {
    return await secureStorageBackend.load();
  } catch (error) {
    throw secureStorageError(error);
  }
}

export async function saveSecureStorageSection(
  section: SecureVaultSection,
  value: unknown,
): Promise<SecureVaultLoadResult> {
  try {
    return await secureStorageBackend.saveSection(section, value);
  } catch (error) {
    throw secureStorageError(error);
  }
}

export async function clearSecureStorage(): Promise<void> {
  try {
    await secureStorageBackend.clear();
  } catch (error) {
    throw secureStorageError(error);
  }
  for (const key of Object.values(legacyStorageKeys)) {
    globalThis.localStorage?.removeItem(key);
  }
  globalThis.localStorage?.removeItem(migrationMarkerKey);
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

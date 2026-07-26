import type {
  SecureStorageBackend,
  SecureVaultLoadResult,
  SecureVaultMigrationResult,
  SecureVaultPayload,
} from "./secureStorageContract";

const uiSmokeVaultKey = "tachyon.prism.uiSmokeVault.v1";

function uiSmokeLoad(): SecureVaultLoadResult {
  const raw = globalThis.localStorage?.getItem(uiSmokeVaultKey);
  if (!raw) return { version: 1, revision: 0, payload: {} };
  try {
    const parsed = JSON.parse(raw) as SecureVaultLoadResult;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || !parsed.payload) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new Error("secure-vault-corrupt");
  }
}

function persist(document: SecureVaultLoadResult): SecureVaultLoadResult {
  globalThis.localStorage?.setItem(uiSmokeVaultKey, JSON.stringify(document));
  return structuredClone(document);
}

function uiSmokeSave(
  section: string,
  value: unknown,
): SecureVaultLoadResult {
  const current = uiSmokeLoad();
  return persist({
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
    ? persist({ version: 1, revision: current.revision + 1, payload: nextPayload })
    : current;
  return { ...next, migratedSections };
}

export const secureStorageBackend: SecureStorageBackend = {
  available: () => true,
  clear: async () => {
    globalThis.localStorage?.removeItem(uiSmokeVaultKey);
  },
  load: async () => uiSmokeLoad(),
  migrate: async (payload) => uiSmokeMigrate(payload),
  saveSection: async (section, value) => uiSmokeSave(section, value),
};

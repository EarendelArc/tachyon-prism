import type {
  SecureStorageBackend,
  SecureVaultLoadResult,
  SecureVaultMigrationResult,
  SecureVaultPayload,
} from "./secureStorageContract";
import { invokeDesktop, isTauriRuntime } from "./tauri";

export const secureStorageBackend: SecureStorageBackend = {
  available: isTauriRuntime,
  clear: () => invokeDesktop<void>("clear_secure_vault"),
  load: () => invokeDesktop<SecureVaultLoadResult>("load_secure_vault"),
  migrate: (payload: SecureVaultPayload) =>
    invokeDesktop<SecureVaultMigrationResult>("migrate_secure_vault", { payload }),
  saveSection: (section: string, value: unknown) =>
    invokeDesktop<SecureVaultLoadResult>("save_secure_vault_section", {
      section,
      value,
    }),
};

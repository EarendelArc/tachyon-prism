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

export interface SecureStorageBackend {
  available(): boolean;
  clear(): Promise<void>;
  load(): Promise<SecureVaultLoadResult>;
  migrate(payload: SecureVaultPayload): Promise<SecureVaultMigrationResult>;
  saveSection(section: string, value: unknown): Promise<SecureVaultLoadResult>;
}

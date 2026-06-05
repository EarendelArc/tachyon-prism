import { invoke } from "@tauri-apps/api/core";

export interface ConfigDraftPaths {
  configDir: string;
  coreConfigPath: string;
  xrayConfigPath: string;
}

export async function getConfigPaths(): Promise<ConfigDraftPaths> {
  return invoke<ConfigDraftPaths>("config_paths");
}

export async function saveConfigDrafts(
  coreJson: string,
  xrayJson: string,
): Promise<ConfigDraftPaths> {
  return invoke<ConfigDraftPaths>("save_config_drafts", {
    coreJson,
    xrayJson,
  });
}

import { invokeDesktop, isTauriRuntime } from "./tauri";

export interface ConfigDraftPaths {
  configDir: string;
  coreConfigPath: string;
  xrayConfigPath: string;
}

export async function getConfigPaths(): Promise<ConfigDraftPaths> {
  if (!isTauriRuntime()) {
    return previewConfigPaths();
  }
  return invokeDesktop<ConfigDraftPaths>("config_paths");
}

export async function saveConfigDrafts(
  coreJson: string,
  xrayJson: string,
): Promise<ConfigDraftPaths> {
  if (!isTauriRuntime()) {
    return previewConfigPaths();
  }
  return invokeDesktop<ConfigDraftPaths>("save_config_drafts", {
    coreJson,
    xrayJson,
  });
}

function previewConfigPaths(): ConfigDraftPaths {
  return {
    configDir: "Preview mode",
    coreConfigPath: "Preview mode / client.json",
    xrayConfigPath: "Preview mode / xray-client.json",
  };
}

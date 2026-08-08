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

export async function commitValidatedTachyonCoreConfig(
  contents: string,
): Promise<ConfigDraftPaths> {
  if (!isTauriRuntime()) {
    return previewConfigPaths();
  }
  return invokeDesktop<ConfigDraftPaths>("commit_validated_tachyon_core_config", {
    contents,
  });
}

function previewConfigPaths(): ConfigDraftPaths {
  return {
    configDir: "Preview mode",
    coreConfigPath: "Preview mode / client.json",
    xrayConfigPath: "Preview mode / xray-client.json",
  };
}

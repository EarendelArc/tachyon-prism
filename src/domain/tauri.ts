import { invoke } from "@tauri-apps/api/core";

export class TauriUnavailableError extends Error {
  constructor(command: string) {
    super(`Tauri runtime is unavailable for command: ${command}`);
    this.name = "TauriUnavailableError";
  }
}

export function isTauriRuntime(): boolean {
  const root = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
    window?: { __TAURI_INTERNALS__?: unknown };
  };
  return Boolean(root.__TAURI_INTERNALS__ || root.window?.__TAURI_INTERNALS__);
}

export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new TauriUnavailableError(command);
  }
  return invoke<T>(command, args);
}

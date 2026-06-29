export interface PluginRuntimeState {
  enabled: boolean;
  installed: boolean;
  lastRunAt: string;
  runCount: number;
}

export type PluginStateSnapshot = Record<string, PluginRuntimeState>;

const storageKey = "tachyon.prism.plugins.v1";

export function emptyPluginState(): PluginRuntimeState {
  return {
    enabled: false,
    installed: false,
    lastRunAt: "",
    runCount: 0,
  };
}

export function normalizePluginState(
  value: unknown,
  pluginIds: readonly string[],
): PluginStateSnapshot {
  const raw = isRecord(value) ? value : {};
  return Object.fromEntries(
    pluginIds.map((id) => {
      const current = isRecord(raw[id]) ? raw[id] : {};
      return [
        id,
        {
          enabled: Boolean(current.enabled),
          installed: Boolean(current.installed),
          lastRunAt: typeof current.lastRunAt === "string" ? current.lastRunAt : "",
          runCount: numberValue(current.runCount),
        },
      ];
    }),
  );
}

export function loadPluginState(pluginIds: readonly string[]): PluginStateSnapshot {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    return normalizePluginState(raw ? JSON.parse(raw) : {}, pluginIds);
  } catch {
    return normalizePluginState({}, pluginIds);
  }
}

export function savePluginState(snapshot: PluginStateSnapshot): void {
  globalThis.localStorage?.setItem(storageKey, JSON.stringify(snapshot));
}

export function installPluginState(
  snapshot: PluginStateSnapshot,
  pluginId: string,
): PluginStateSnapshot {
  const current = snapshot[pluginId] ?? emptyPluginState();
  return {
    ...snapshot,
    [pluginId]: {
      ...current,
      enabled: true,
      installed: true,
    },
  };
}

export function togglePluginEnabled(
  snapshot: PluginStateSnapshot,
  pluginId: string,
): PluginStateSnapshot {
  const current = snapshot[pluginId] ?? emptyPluginState();
  if (!current.installed) {
    return installPluginState(snapshot, pluginId);
  }
  return {
    ...snapshot,
    [pluginId]: {
      ...current,
      enabled: !current.enabled,
    },
  };
}

export function recordPluginRun(
  snapshot: PluginStateSnapshot,
  pluginId: string,
  now = new Date(),
): PluginStateSnapshot {
  const current = snapshot[pluginId] ?? emptyPluginState();
  if (!current.installed || !current.enabled) {
    throw new Error("Plugin must be installed and enabled before running");
  }
  return {
    ...snapshot,
    [pluginId]: {
      ...current,
      lastRunAt: now.toISOString(),
      runCount: current.runCount + 1,
    },
  };
}

export function installedPluginCount(snapshot: PluginStateSnapshot): number {
  return Object.values(snapshot).filter((plugin) => plugin.installed).length;
}

export function enabledPluginCount(snapshot: PluginStateSnapshot): number {
  return Object.values(snapshot).filter((plugin) => plugin.installed && plugin.enabled).length;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

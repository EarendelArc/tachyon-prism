export interface TachyonServerProfile {
  id: string;
  name: string;
  address: string;
  port: number;
  psk: string;
  remark: string;
  updatedAt: string;
}

export interface TachyonServerSnapshot {
  profiles: TachyonServerProfile[];
  selectedProfileId: string;
}

export interface TachyonServerDraft {
  name: string;
  address: string;
  port: number;
  psk: string;
  remark: string;
}

const storageKey = "tachyon.prism.tachyonServers.v1";

export const emptyTachyonServerSnapshot: TachyonServerSnapshot = {
  profiles: [],
  selectedProfileId: "",
};

export const emptyTachyonServerDraft: TachyonServerDraft = {
  name: "",
  address: "",
  port: 443,
  psk: "",
  remark: "",
};

export function activeTachyonServer(
  snapshot: TachyonServerSnapshot,
): TachyonServerProfile | undefined {
  return snapshot.profiles.find((profile) => profile.id === snapshot.selectedProfileId);
}

export function tachyonServerEndpoint(
  profile: Pick<TachyonServerProfile, "address" | "port"> | undefined,
): string {
  if (!profile) {
    return "";
  }
  const address = profile.address.trim();
  if (!address || profile.port <= 0) {
    return "";
  }
  return `${address}:${profile.port}`;
}

export function upsertTachyonServerProfile(
  snapshot: TachyonServerSnapshot,
  draft: TachyonServerDraft,
  profileId = "",
): TachyonServerSnapshot {
  const profile = normalizeDraft(draft, profileId);
  const profiles = [
    ...snapshot.profiles.filter((item) => item.id !== profile.id),
    profile,
  ].sort((left, right) => left.name.localeCompare(right.name));
  return normalizeSnapshot({
    profiles,
    selectedProfileId: profile.id,
  });
}

export function selectTachyonServerProfile(
  snapshot: TachyonServerSnapshot,
  profileId: string,
): TachyonServerSnapshot {
  if (!snapshot.profiles.some((profile) => profile.id === profileId)) {
    throw new Error("Tachyon server profile no longer exists");
  }
  return normalizeSnapshot({
    ...snapshot,
    selectedProfileId: profileId,
  });
}

export function removeTachyonServerProfile(
  snapshot: TachyonServerSnapshot,
  profileId: string,
): TachyonServerSnapshot {
  const profiles = snapshot.profiles.filter((profile) => profile.id !== profileId);
  return normalizeSnapshot({
    profiles,
    selectedProfileId: profiles[0]?.id ?? "",
  });
}

export function draftFromTachyonServerProfile(
  profile: TachyonServerProfile | undefined,
): TachyonServerDraft {
  if (!profile) {
    return emptyTachyonServerDraft;
  }
  return {
    name: profile.name,
    address: profile.address,
    port: profile.port,
    psk: profile.psk,
    remark: profile.remark,
  };
}

export function loadTachyonServerSnapshot(): TachyonServerSnapshot {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) {
      return emptyTachyonServerSnapshot;
    }
    return normalizeSnapshot(JSON.parse(raw) as Partial<TachyonServerSnapshot>);
  } catch {
    return emptyTachyonServerSnapshot;
  }
}

export function saveTachyonServerSnapshot(snapshot: TachyonServerSnapshot): void {
  globalThis.localStorage?.setItem(storageKey, JSON.stringify(normalizeSnapshot(snapshot)));
}

function normalizeDraft(draft: TachyonServerDraft, profileId: string): TachyonServerProfile {
  const name = draft.name.trim();
  const address = normalizeAddress(draft.address);
  const port = normalizePort(draft.port);
  const psk = draft.psk.trim();
  if (!name) {
    throw new Error("Tachyon server name is required");
  }
  if (!address) {
    throw new Error("Tachyon server address is required");
  }
  if (port === 0) {
    throw new Error("Tachyon server port is required");
  }
  if (psk.length < 16) {
    throw new Error("Tachyon TGP PSK must be at least 16 characters");
  }
  return {
    id: profileId || stableProfileId(`${name}\n${address}\n${port}`),
    name,
    address,
    port,
    psk,
    remark: draft.remark.trim(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSnapshot(value: Partial<TachyonServerSnapshot>): TachyonServerSnapshot {
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.map(normalizeStoredProfile).filter((item): item is TachyonServerProfile => item !== null)
    : [];
  const selected = profiles.some((profile) => profile.id === value.selectedProfileId)
    ? value.selectedProfileId ?? ""
    : profiles[0]?.id ?? "";
  return {
    profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)),
    selectedProfileId: selected,
  };
}

function normalizeStoredProfile(value: unknown): TachyonServerProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = stringValue(value.name).trim();
  const address = normalizeAddress(stringValue(value.address));
  const port = normalizePort(numberValue(value.port));
  const psk = stringValue(value.psk).trim();
  if (!name || !address || port === 0 || psk.length < 16) {
    return null;
  }
  return {
    id: stringValue(value.id) || stableProfileId(`${name}\n${address}\n${port}`),
    name,
    address,
    port,
    psk,
    remark: stringValue(value.remark).trim(),
    updatedAt: stringValue(value.updatedAt),
  };
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/^tachyon:\/\//i, "").replace(/^tgp:\/\//i, "");
}

function normalizePort(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0;
}

function stableProfileId(raw: string): string {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tachyon-server-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number.parseInt(value, 10);
  }
  return 0;
}

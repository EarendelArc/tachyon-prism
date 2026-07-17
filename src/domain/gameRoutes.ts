export type GameRouteErrorCode =
  | "empty"
  | "format"
  | "address"
  | "prefix"
  | "default-route"
  | "duplicate";

export class GameRouteValidationError extends Error {
  readonly code: GameRouteErrorCode;

  constructor(code: GameRouteErrorCode) {
    super(code);
    this.name = "GameRouteValidationError";
    this.code = code;
  }
}

const gameRoutesStorageKey = "tachyon.prism.gameRoutes.v1";

export function normalizeGameRouteCidr(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new GameRouteValidationError("empty");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GameRouteValidationError("format");
  }

  const address = parts[0];
  const family = ipv4Parts(address) ? 4 : isIpv6Address(address) ? 6 : 0;
  if (!family) {
    throw new GameRouteValidationError("address");
  }
  if (!/^\d+$/.test(parts[1])) {
    throw new GameRouteValidationError("prefix");
  }
  const prefix = Number(parts[1]);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new GameRouteValidationError("prefix");
  }
  if (prefix === 0) {
    throw new GameRouteValidationError("default-route");
  }

  const normalizedAddress = family === 4
    ? ipv4Parts(address)!.join(".")
    : address.toLowerCase();
  return `${normalizedAddress}/${prefix}`;
}

export function normalizeGameRoutes(routes: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const cidr = normalizeGameRouteCidr(route);
    if (seen.has(cidr)) {
      throw new GameRouteValidationError("duplicate");
    }
    seen.add(cidr);
    normalized.push(cidr);
  }
  return normalized;
}

export function loadGameRoutes(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(gameRoutesStorageKey);
    if (!raw) {
      return [];
    }
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? normalizeGameRoutes(value.filter((route): route is string => typeof route === "string"))
      : [];
  } catch {
    return [];
  }
}

export function saveGameRoutes(routes: string[]): string[] {
  const normalized = normalizeGameRoutes(routes);
  globalThis.localStorage?.setItem(gameRoutesStorageKey, JSON.stringify(normalized));
  return normalized;
}

function ipv4Parts(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const number = Number(part);
    if (number > 255) {
      return null;
    }
    numbers.push(number);
  }
  return numbers;
}

function isIpv6Address(value: string): boolean {
  if (!value.includes(":") || value.includes("%")) {
    return false;
  }
  const compressed = value.split("::");
  if (compressed.length > 2) {
    return false;
  }
  const left = ipv6Units(compressed[0]);
  const right = compressed.length === 2 ? ipv6Units(compressed[1]) : [];
  if (left === null || right === null) {
    return false;
  }
  const units = left.length + right.length;
  return compressed.length === 2 ? units < 8 : units === 8;
}

function ipv6Units(value: string): string[] | null {
  if (!value) {
    return [];
  }
  const parts = value.split(":");
  const units: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (!part) {
      return null;
    }
    if (part.includes(".")) {
      if (index !== parts.length - 1 || !ipv4Parts(part)) {
        return null;
      }
      units.push("ipv4-high", "ipv4-low");
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
      units.push(part);
    } else {
      return null;
    }
  }
  return units;
}

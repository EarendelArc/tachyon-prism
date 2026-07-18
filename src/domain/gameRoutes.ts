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

  const parsed = parseIpAddress(parts[0]);
  if (!parsed) {
    throw new GameRouteValidationError("address");
  }
  if (!/^\d+$/.test(parts[1])) {
    throw new GameRouteValidationError("prefix");
  }
  const prefix = Number(parts[1]);
  const maxPrefix = parsed.bits;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new GameRouteValidationError("prefix");
  }
  if (prefix === 0) {
    throw new GameRouteValidationError("default-route");
  }

  const hostBits = BigInt(parsed.bits - prefix);
  const network = (parsed.value >> hostBits) << hostBits;
  const normalizedAddress = parsed.family === 4
    ? formatIpv4(network)
    : formatIpv6(network);
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
    if (!Array.isArray(value) || value.some((route) => typeof route !== "string")) {
      return [];
    }
    return normalizeGameRoutes(value);
  } catch {
    return [];
  }
}

export function saveGameRoutes(routes: string[]): string[] {
  const normalized = normalizeGameRoutes(routes);
  globalThis.localStorage?.setItem(gameRoutesStorageKey, JSON.stringify(normalized));
  return normalized;
}

interface ParsedIpAddress {
  bits: 32 | 128;
  family: 4 | 6;
  value: bigint;
}

function parseIpAddress(value: string): ParsedIpAddress | null {
  const ipv4 = ipv4Parts(value);
  if (ipv4) {
    return {
      bits: 32,
      family: 4,
      value: ipv4.reduce((address, part) => (address << 8n) | BigInt(part), 0n),
    };
  }
  const ipv6 = ipv6Parts(value);
  if (!ipv6) {
    return null;
  }
  return {
    bits: 128,
    family: 6,
    value: ipv6.reduce((address, part) => (address << 16n) | BigInt(part), 0n),
  };
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

function ipv6Parts(value: string): number[] | null {
  if (!value.includes(":") || value.includes("%")) {
    return null;
  }
  const compressed = value.split("::");
  if (compressed.length > 2) {
    return null;
  }
  const left = ipv6Units(compressed[0]);
  const right = compressed.length === 2 ? ipv6Units(compressed[1]) : [];
  if (left === null || right === null) {
    return null;
  }
  const units = left.length + right.length;
  if (compressed.length === 1) {
    return units === 8 ? left : null;
  }
  if (units >= 8) {
    return null;
  }
  return [...left, ...Array<number>(8 - units).fill(0), ...right];
}

function ipv6Units(value: string): number[] | null {
  if (!value) {
    return [];
  }
  const parts = value.split(":");
  const units: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (!part) {
      return null;
    }
    if (part.includes(".")) {
      if (index !== parts.length - 1 || !ipv4Parts(part)) {
        return null;
      }
      const ipv4 = ipv4Parts(part)!;
      units.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
      units.push(Number.parseInt(part, 16));
    } else {
      return null;
    }
  }
  return units;
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn))
    .join(".");
}

function formatIpv6(value: bigint): string {
  const groups = Array.from(
    { length: 8 },
    (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) {
      end += 1;
    }
    const length = end - start;
    if (length >= 2 && length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
    start = end;
  }
  const formatted = groups.map((group) => group.toString(16));
  if (bestStart < 0) {
    return formatted.join(":");
  }
  const before = formatted.slice(0, bestStart).join(":");
  const after = formatted.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

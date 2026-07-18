import { beforeEach, describe, expect, it } from "vitest";
import {
  GameRouteValidationError,
  loadGameRoutes,
  normalizeGameRouteCidr,
  normalizeGameRoutes,
  saveGameRoutes,
} from "../gameRoutes";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

describe("game route CIDRs", () => {
  it("normalizes supported IPv4 and IPv6 CIDRs", () => {
    expect(normalizeGameRouteCidr(" 203.0.113.42/24 ")).toBe("203.0.113.0/24");
    expect(normalizeGameRouteCidr("203.0.113.255/25")).toBe("203.0.113.128/25");
    expect(normalizeGameRouteCidr("2001:0DB8:0000:0001::1234/48")).toBe("2001:db8::/48");
    expect(normalizeGameRouteCidr("2001:db8:0:0:ffff::1/65")).toBe(
      "2001:db8:0:0:8000::/65",
    );
  });

  it.each([
    ["", "empty"],
    ["203.0.113.1", "format"],
    ["example.com/24", "address"],
    ["203.0.113.0/33", "prefix"],
    ["0.0.0.0/0", "default-route"],
    ["::/0", "default-route"],
  ])("rejects %s with %s", (value, code) => {
    try {
      normalizeGameRouteCidr(value);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GameRouteValidationError);
      expect((error as GameRouteValidationError).code).toBe(code);
    }
  });

  it("rejects duplicate routes", () => {
    expect(() => normalizeGameRoutes(["203.0.113.7/24", "203.0.113.200/24"]))
      .toThrowError(expect.objectContaining({ code: "duplicate" }));
    expect(() => normalizeGameRoutes(["2001:db8:0:1::1/48", "2001:0db8::abcd/48"]))
      .toThrowError(expect.objectContaining({ code: "duplicate" }));
  });

  it("persists an explicit empty or populated allow-list", () => {
    expect(loadGameRoutes()).toEqual([]);
    saveGameRoutes(["203.0.113.0/24", "2001:db8::/48"]);
    expect(loadGameRoutes()).toEqual(["203.0.113.0/24", "2001:db8::/48"]);
    saveGameRoutes([]);
    expect(loadGameRoutes()).toEqual([]);
  });

  it("fails closed to an empty list when stored data is malformed", () => {
    globalThis.localStorage?.setItem("tachyon.prism.gameRoutes.v1", '["not-a-cidr"]');
    expect(loadGameRoutes()).toEqual([]);
    globalThis.localStorage?.setItem(
      "tachyon.prism.gameRoutes.v1",
      '["203.0.113.0/24",42]',
    );
    expect(loadGameRoutes()).toEqual([]);
    globalThis.localStorage?.setItem(
      "tachyon.prism.gameRoutes.v1",
      '["203.0.113.7/24","203.0.113.200/24"]',
    );
    expect(loadGameRoutes()).toEqual([]);
  });
});

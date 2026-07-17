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
    expect(normalizeGameRouteCidr(" 203.0.113.0/24 ")).toBe("203.0.113.0/24");
    expect(normalizeGameRouteCidr("2001:DB8::/48")).toBe("2001:db8::/48");
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
    expect(() => normalizeGameRoutes(["203.0.113.0/24", "203.0.113.0/24"]))
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
  });
});

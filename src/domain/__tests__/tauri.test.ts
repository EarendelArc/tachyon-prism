import { afterEach, describe, expect, it } from "vitest";
import { isTauriRuntime } from "../tauri";

const root = globalThis as typeof globalThis & {
  __TAURI_INTERNALS__?: unknown;
  isTauri?: boolean;
};

describe("isTauriRuntime", () => {
  afterEach(() => {
    delete root.__TAURI_INTERNALS__;
    delete root.isTauri;
  });

  it("detects the Tauri v2 runtime marker", () => {
    root.isTauri = true;

    expect(isTauriRuntime()).toBe(true);
  });

  it("detects the legacy internals marker used by Tauri mocks", () => {
    root.__TAURI_INTERNALS__ = {};

    expect(isTauriRuntime()).toBe(true);
  });
});

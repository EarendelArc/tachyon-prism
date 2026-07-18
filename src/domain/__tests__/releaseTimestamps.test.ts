import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const normalizer = fileURLToPath(
  new URL("../../../.github/scripts/normalize-release-timestamps.py", import.meta.url),
);

describe("release asset timestamp normalization", () => {
  it("sets every staged file and directory timestamp without changing payload bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "prism-release-timestamps-"));
    const releaseDir = join(root, "release");
    const nestedDir = join(releaseDir, "nested");
    const first = join(releaseDir, "asset.bin");
    const second = join(nestedDir, "metadata.json");
    const epoch = 1_700_000_123;
    try {
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(first, Buffer.from([0, 1, 2, 3]));
      writeFileSync(second, '{"stable":true}\n', "utf8");
      const firstBytes = readFileSync(first);
      const secondBytes = readFileSync(second);

      const result = spawnSync("python", [normalizer, releaseDir, String(epoch)], {
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      for (const path of [first, second, nestedDir, releaseDir]) {
        expect(Math.trunc(statSync(path).mtimeMs / 1000)).toBe(epoch);
      }
      expect(readFileSync(first)).toEqual(firstBytes);
      expect(readFileSync(second)).toEqual(secondBytes);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

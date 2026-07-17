import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildCoreClientConfigDraft, stringifyDraft } from "../configDrafts";

const coreSourceDir = process.env.TACHYON_CORE_SOURCE_DIR?.trim()
  || resolve(process.cwd(), "..", "tachyon-core");
const itWithAdjacentCore = existsSync(join(coreSourceDir, "go.mod")) ? it : it.skip;

itWithAdjacentCore("validates Prism's real client.json with the adjacent Core source", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-core-contract-"));
  const configPath = join(tempDir, "client.json");
  const coreBinaryPath = join(
    tempDir,
    process.platform === "win32" ? "tachyon-core-contract.exe" : "tachyon-core-contract",
  );
  try {
    execFileSync(
      "mise",
      ["exec", "--", "go", "build", "-o", coreBinaryPath, "./cmd/tachyon-core"],
      { cwd: coreSourceDir, encoding: "utf8", timeout: 120000 },
    );
    writeFileSync(
      configPath,
      stringifyDraft(buildCoreClientConfigDraft({
        gameRoutes: ["203.0.113.0/24", "2001:db8::/48"],
        serverAddr: "relay.example.com:443",
        tgpServerAddr: "game-relay.example.com:443",
      })),
      "utf8",
    );

    const output = execFileSync(coreBinaryPath, ["validate", "--config", configPath], {
      encoding: "utf8",
      timeout: 8000,
    });
    expect(output).toContain("is valid");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

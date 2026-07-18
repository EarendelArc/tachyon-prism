import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildCoreClientConfigDraft, stringifyDraft } from "../configDrafts";

interface CoreContract {
  commit: string;
  repository: string;
  tag: string;
}

const sourceRepositoryDir = process.env.TACHYON_CORE_SOURCE_DIR?.trim()
  || resolve(process.cwd(), "..", "tachyon-core");
const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), "core-contract.json"), "utf8"),
) as CoreContract;

function coreGoCommand(): { args: string[]; command: string } {
  const explicit = process.env.GO_BINARY?.trim();
  if (explicit) {
    return { args: [], command: explicit };
  }
  const probe = spawnSync("go", ["version"], { encoding: "utf8" });
  return probe.status === 0
    ? { args: [], command: "go" }
    : { args: ["exec", "--", "go"], command: "mise" };
}

it("validates Prism's real client.json with the pinned Core release", () => {
  expect(contract.repository).toBe("tachyon-space/tachyon-core");
  expect(contract.tag).toMatch(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  expect(contract.commit).toMatch(/^[0-9a-f]{40}$/);
  if (!existsSync(join(sourceRepositoryDir, ".git"))) {
    throw new Error(`Pinned Core repository is missing: ${sourceRepositoryDir}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-core-contract-"));
  const coreSourceDir = join(tempDir, "tachyon-core");
  const configPath = join(tempDir, "client.json");
  const coreBinaryPath = join(
    tempDir,
    process.platform === "win32" ? "tachyon-core-contract.exe" : "tachyon-core-contract",
  );
  try {
    execFileSync(
      "git",
      ["clone", "--no-checkout", "--no-hardlinks", sourceRepositoryDir, coreSourceDir],
      { encoding: "utf8", timeout: 120000 },
    );
    execFileSync("git", ["checkout", "--detach", contract.commit], {
      cwd: coreSourceDir,
      encoding: "utf8",
      timeout: 30000,
    });
    const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: coreSourceDir,
      encoding: "utf8",
    }).trim();
    const actualTag = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      cwd: coreSourceDir,
      encoding: "utf8",
    }).trim();
    expect(actualCommit).toBe(contract.commit);
    expect(actualTag).toBe(contract.tag);

    const go = coreGoCommand();
    execFileSync(
      go.command,
      [
        ...go.args,
        "build",
        "-trimpath",
        "-ldflags",
        `-X main.Version=${contract.tag}`,
        "-o",
        coreBinaryPath,
        "./cmd/tachyon-core",
      ],
      { cwd: coreSourceDir, encoding: "utf8", timeout: 120000 },
    );
    const version = execFileSync(coreBinaryPath, ["version"], {
      encoding: "utf8",
      timeout: 8000,
    });
    expect(version).toContain(`tachyon-core ${contract.tag}`);
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

import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCoreClientConfigDraft, stringifyDraft } from "../configDrafts";

interface CoreContract {
  commit: string;
  repository: string;
  tag: string;
  tag_object: string;
}

interface GoTestEvent {
  Action?: string;
  Output?: string;
  Package?: string;
  Test?: string;
}

const sourceRepositoryDir = process.env.TACHYON_CORE_SOURCE_DIR?.trim()
  || resolve(process.cwd(), "..", "tachyon-core");
const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), "core-contract.json"), "utf8"),
) as CoreContract;
const expectedRuntimeVersion = "tachyon-core v0.1.0-alpha.22";
const windowsSimulationTests = [
  "TestParseGameRoutePrefixesNormalizesHostBits",
  "TestPlanSelectiveRoutesNormalizesAndDeduplicates",
  "TestWindowsRouteRowsRequireExactIdentityAndAttributes",
  "TestInstallRouteTransactionRollsBackInReverseOrder",
  "TestWindowsRouteJournalRecordFailureRollsBackCreatedRouteUnderLock",
] as const;

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

function commandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function generatedCoreDraft(gameRoutes: string[]): Record<string, unknown> {
  return buildCoreClientConfigDraft({
    gameRoutes,
    serverAddr: "198.51.100.8:443",
    tgpServerAddr: "198.51.100.8:443",
  });
}

function injectInvalidGameRoute(draft: Record<string, unknown>): void {
  const client = draft.client as Record<string, unknown>;
  const tun = client.tun as Record<string, unknown>;
  tun.game_routes = ["not-a-cidr"];
}

describe("pinned Tachyon Core release contract", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tachyon-prism-core-contract-"));
  const coreSourceDir = join(tempDir, "tachyon-core");
  const validConfigPath = join(tempDir, "client.json");
  const invalidConfigPath = join(tempDir, "client-invalid-route.json");
  const coreBinaryPath = join(
    tempDir,
    process.platform === "win32" ? "tachyon-core-contract.exe" : "tachyon-core-contract",
  );
  const go = coreGoCommand();
  let actualCommit = "";
  let actualTagObject = "";
  let actualPeeledCommit = "";

  beforeAll(() => {
    expect(contract.repository).toBe("EarendelArc/tachyon-core");
    expect(contract.tag).toBe("v0.1.0-alpha.22");
    expect(contract.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(contract.tag_object).toMatch(/^[0-9a-f]{40}$/);
    if (!existsSync(join(sourceRepositoryDir, ".git"))) {
      throw new Error(`Pinned Core repository is missing: ${sourceRepositoryDir}`);
    }

    execFileSync(
      "git",
      ["clone", "--no-checkout", "--no-hardlinks", sourceRepositoryDir, coreSourceDir],
      { encoding: "utf8", timeout: 120_000 },
    );
    const tagRef = `refs/tags/${contract.tag}`;
    expect(execFileSync("git", ["cat-file", "-t", tagRef], {
      cwd: coreSourceDir,
      encoding: "utf8",
    }).trim()).toBe("tag");
    actualTagObject = execFileSync("git", ["rev-parse", tagRef], {
      cwd: coreSourceDir,
      encoding: "utf8",
    }).trim();
    actualPeeledCommit = execFileSync("git", ["rev-parse", `${tagRef}^{}`], {
      cwd: coreSourceDir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "--detach", contract.commit], {
      cwd: coreSourceDir,
      encoding: "utf8",
      timeout: 30_000,
    });
    actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: coreSourceDir,
      encoding: "utf8",
    }).trim();

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
      { cwd: coreSourceDir, encoding: "utf8", timeout: 120_000 },
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("verifies the annotated release tag object and peeled commit", () => {
    expect(actualTagObject).toBe(contract.tag_object);
    expect(actualPeeledCommit).toBe(contract.commit);
    expect(actualCommit).toBe(contract.commit);
    const version = execFileSync(coreBinaryPath, ["version"], {
      encoding: "utf8",
      timeout: 8_000,
    });
    expect(version.split(" (built ", 1)[0]).toBe(expectedRuntimeVersion);
    expect(expectedRuntimeVersion).toBe(`tachyon-core ${contract.tag}`);
  });

  it("validates a real Prism draft and rejects an injected invalid game route", () => {
    writeFileSync(
      validConfigPath,
      stringifyDraft(generatedCoreDraft(["203.0.113.0/24", "2001:db8::/48"])),
      "utf8",
    );
    const valid = spawnSync(coreBinaryPath, ["validate", "--config", validConfigPath], {
      encoding: "utf8",
      timeout: 8_000,
    });
    expect(valid.status, commandOutput(valid)).toBe(0);
    expect(commandOutput(valid)).toContain("is valid");

    const invalidDraft = generatedCoreDraft(["203.0.113.0/24"]);
    injectInvalidGameRoute(invalidDraft);
    writeFileSync(invalidConfigPath, stringifyDraft(invalidDraft), "utf8");
    const invalid = spawnSync(coreBinaryPath, ["validate", "--config", invalidConfigPath], {
      encoding: "utf8",
      timeout: 8_000,
    });
    const invalidOutput = commandOutput(invalid);
    expect(invalid.status).not.toBe(0);
    expect(invalidOutput).toContain("client.tun.game_routes[0]");
    expect(invalidOutput).toContain("not-a-cidr");
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "fails unsupported selective routes before creating a TUN on Unix",
    () => {
      writeFileSync(
        validConfigPath,
        stringifyDraft(generatedCoreDraft(["203.0.113.0/24"])),
        "utf8",
      );
      const run = spawnSync(coreBinaryPath, ["run", "--config", validConfigPath], {
        encoding: "utf8",
        timeout: 8_000,
      });
      const output = commandOutput(run);
      expect(run.status).not.toBe(0);
      expect(output).toContain("selective TUN routes are not supported on this platform");
      expect(output).not.toContain("TUN device ready");
      expect(output).not.toContain("selective game routes ready");
    },
  );

  it.runIf(process.platform === "win32")(
    "executes every pinned Windows route simulation without enabling TUN",
    () => {
      const pattern = `^(${windowsSimulationTests.join("|")})$`;
      const result = spawnSync(
        go.command,
        [
          ...go.args,
          "test",
          "-json",
          "-count=1",
          "-run",
          pattern,
          "./internal/app",
          "./internal/tun",
        ],
        { cwd: coreSourceDir, encoding: "utf8", timeout: 120_000 },
      );
      const output = commandOutput(result);
      expect(result.status, output).toBe(0);
      const events = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GoTestEvent);

      for (const testName of windowsSimulationTests) {
        const testEvents = events.filter((event) => event.Test === testName);
        expect(testEvents.filter((event) => event.Action === "run"), testName).toHaveLength(1);
        expect(testEvents.filter((event) => event.Action === "pass"), testName).toHaveLength(1);
        expect(
          testEvents.filter((event) => ["fail", "skip"].includes(event.Action ?? "")),
          testName,
        ).toHaveLength(0);
      }
      expect(output).not.toContain("TACHYON_ALLOW_REAL_ROUTE_TEST");
      expect(output).not.toContain("TUN device ready");
    },
  );
});

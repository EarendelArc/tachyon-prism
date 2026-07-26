import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const verifier = fileURLToPath(
  new URL("../../../.github/scripts/verify-published-release.py", import.meta.url),
);
const coreContractPath = fileURLToPath(new URL("../../../core-contract.json", import.meta.url));
const coreContract = JSON.parse(readFileSync(coreContractPath, "utf8")) as Record<string, string>;
const tempDirs: string[] = [];
const commit = "a".repeat(40);
const tagObject = "b".repeat(40);
const sourceDateEpoch = 1_700_000_000;
const tools = { node: "26.4.0" };
const reproducibility = {
  installerByteReproducibilityGuaranteed: false,
  stagedAssetTimestampsNormalized: true,
};

const digest = (contents: Buffer | string) => createHash("sha256").update(contents).digest("hex");

function installerNames(): string[] {
  return [
    "tachyon-prism-windows-x64_Prism.exe",
    "tachyon-prism-windows-x64_Prism.msi",
    "tachyon-prism-windows-arm64_Prism.exe",
    "tachyon-prism-macos-x64_Prism.dmg",
    "tachyon-prism-macos-arm64_Prism.dmg",
    "tachyon-prism-linux-x64_Prism.deb",
    "tachyon-prism-linux-arm64_Prism.deb",
  ];
}

function writeMetadata(releaseDir: string, installers: string[], mutate?: (value: any) => void): void {
  const artifactDigests = Object.fromEntries(
    installers.map((name) => [name, `sha256:${digest(readFileSync(join(releaseDir, name)))}`]),
  );
  const metadata = {
    artifactDigests,
    coreContract,
    prism: {
      commit,
      sourceDateEpoch,
      tag: "v0.1.0-alpha.1",
      tagObject,
      tagVerification: "ref-commit",
    },
    reproducibility: { ...reproducibility },
    schemaVersion: 1,
    tools: { ...tools },
  };
  mutate?.(metadata);
  writeFileSync(join(releaseDir, "BUILD_METADATA.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

function writeManifest(releaseDir: string): void {
  const names = installerNamesFromDisk(releaseDir)
    .concat(["BUILD_METADATA.json", "RELEASE_NOTES.md", "RELEASE_NOTES.zh-CN.md"])
    .sort();
  writeFileSync(
    join(releaseDir, "SHA256SUMS.txt"),
    `${names.map((name) => `${digest(readFileSync(join(releaseDir, name)))}  ${name}`).join("\n")}\n`,
  );
}

function installerNamesFromDisk(releaseDir: string): string[] {
  return installerNames().map((name) => {
    if (name === "tachyon-prism-windows-arm64_Prism.exe") {
      try {
        readFileSync(join(releaseDir, name));
      } catch {
        return "tachyon-prism-windows-arm64_Prism.zip";
      }
    }
    return name;
  });
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "prism-release-assets-"));
  tempDirs.push(root);
  const releaseDir = join(root, "release");
  mkdirSync(releaseDir);
  for (const name of installerNames()) {
    writeFileSync(join(releaseDir, name), `payload:${name}\n`);
  }
  writeFileSync(join(releaseDir, "RELEASE_NOTES.md"), "# Release\n\nEnglish.\n");
  writeFileSync(join(releaseDir, "RELEASE_NOTES.zh-CN.md"), "# Release\n\nChinese.\n");
  writeMetadata(releaseDir, installerNames());
  writeManifest(releaseDir);
  return releaseDir;
}

function runVerifier(releaseDir: string) {
  return spawnSync(
    "python",
    [
      verifier,
      "--release-dir", releaseDir,
      "--tag", "v0.1.0-alpha.1",
      "--commit", commit,
      "--core-contract", coreContractPath,
      "--expected-tag-object", tagObject,
      "--expected-source-date-epoch", String(sourceDateEpoch),
      "--expected-tag-verification", "ref-commit",
      "--expected-reproducibility-json", JSON.stringify(reproducibility),
      "--expected-tools-json", JSON.stringify(tools),
    ],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("release asset and metadata verification", () => {
  it("accepts the exact staged schema", () => {
    const result = runVerifier(fixture());
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    ["tagObject", (value: any) => { value.prism.tagObject = "c".repeat(40); }],
    ["sourceDateEpoch", (value: any) => { value.prism.sourceDateEpoch += 1; }],
    ["tagVerification", (value: any) => { value.prism.tagVerification = "signature"; }],
    ["reproducibility", (value: any) => { value.reproducibility.stagedAssetTimestampsNormalized = false; }],
    ["tools", (value: any) => { value.tools.node = "0.0.0"; }],
    ["schema extension", (value: any) => { value.unexpected = true; }],
  ] as const)("rejects metadata %s drift even with a refreshed manifest", (_name, mutate) => {
    const releaseDir = fixture();
    writeMetadata(releaseDir, installerNames(), mutate);
    writeManifest(releaseDir);

    expect(runVerifier(releaseDir).status).not.toBe(0);
  });

  it("rejects a duplicate manifest entry", () => {
    const releaseDir = fixture();
    const manifest = join(releaseDir, "SHA256SUMS.txt");
    const first = readFileSync(manifest, "utf8").split(/\r?\n/)[0];
    writeFileSync(manifest, `${readFileSync(manifest, "utf8")}${first}\n`);

    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("duplicate manifest entry");
  });

  it("rejects an extra staged asset", () => {
    const releaseDir = fixture();
    writeFileSync(join(releaseDir, "EXTRA.txt"), "unexpected\n");

    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exactly 11 files");
  });

  it("rejects a missing staged asset", () => {
    const releaseDir = fixture();
    rmSync(join(releaseDir, "tachyon-prism-linux-arm64_Prism.deb"));

    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exactly 11 files");
  });

  it("rejects a wrong manifest digest", () => {
    const releaseDir = fixture();
    const manifest = join(releaseDir, "SHA256SUMS.txt");
    const contents = readFileSync(manifest, "utf8").replace(/^[0-9a-f]{64}/, "0".repeat(64));
    writeFileSync(manifest, contents);

    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("SHA256SUMS.txt digest mismatch");
  });

  it("rejects an installer suffix drift even when metadata and manifest agree", () => {
    const releaseDir = fixture();
    renameSync(
      join(releaseDir, "tachyon-prism-windows-arm64_Prism.exe"),
      join(releaseDir, "tachyon-prism-windows-arm64_Prism.zip"),
    );
    const installers = installerNamesFromDisk(releaseDir);
    writeMetadata(releaseDir, installers);
    writeManifest(releaseDir);

    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("installer layout");
  });

  it("rejects installer digest drift in metadata even when the manifest is refreshed", () => {
    const releaseDir = fixture();
    writeMetadata(releaseDir, installerNames(), (value) => {
      value.artifactDigests[installerNames()[0]] = `sha256:${"0".repeat(64)}`;
    });
    writeManifest(releaseDir);

    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("BUILD_METADATA.json digest mismatch");
  });
});

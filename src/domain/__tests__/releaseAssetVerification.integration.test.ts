import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
const preparer = fileURLToPath(
  new URL("../../../scripts/prepare_release_assets.py", import.meta.url),
);
const coreContractPath = fileURLToPath(new URL("../../../core-contract.json", import.meta.url));
const toolVersionsPath = fileURLToPath(new URL("../../../.tool-versions", import.meta.url));
const tempDirs: string[] = [];
const commit = "a".repeat(40);
const tagObject = "b".repeat(40);
const sourceDateEpoch = 1_700_000_000;
const tools = Object.fromEntries(
  readFileSync(toolVersionsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/, 2)),
);
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

function writeChecksums(releaseDir: string): void {
  const names = Array.from(
    new Set([
      ...installerNames().filter((name) => {
        try { readFileSync(join(releaseDir, name)); return true; } catch { return false; }
      }),
      "BUILD_METADATA.json",
      "RELEASE_INDEX.json",
      "RELEASE_MANIFEST.json",
      "RELEASE_NOTES.md",
      "RELEASE_NOTES.zh-CN.md",
    ]),
  ).sort();
  writeFileSync(
    join(releaseDir, "SHA256SUMS.txt"),
    `${names.map((name) => `${digest(readFileSync(join(releaseDir, name)))}  ${name}`).join("\n")}\n`,
  );
}

function refreshManifestEntry(releaseDir: string, name: string): void {
  const path = join(releaseDir, name);
  const manifestPath = join(releaseDir, "RELEASE_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const asset = manifest.assets.find((candidate: any) => candidate.name === name);
  if (!asset) throw new Error(`manifest entry missing for ${name}`);
  asset.sha256 = `sha256:${digest(readFileSync(path))}`;
  asset.size = statSync(path).size;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeChecksums(releaseDir);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "prism-release-assets-"));
  tempDirs.push(root);
  const releaseDir = join(root, "release");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(releaseDir);
  for (const name of installerNames()) {
    writeFileSync(join(releaseDir, name), `payload:${name}\n`);
  }
  for (const target of ["windows-x64", "windows-arm64", "macos-x64", "macos-arm64", "linux-x64", "linux-arm64"]) {
    const statusDir = join(artifactsDir, `tachyon-prism-${target}`, "release-status");
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, `${target}.txt`), target.startsWith("linux-")
      ? "not-applicable-unsigned\n"
      : "unsigned-no-credentials\n");
  }
  const prepared = spawnSync("python", [
    preparer,
    "--release-dir", releaseDir,
    "--artifacts-dir", artifactsDir,
    "--tag", "v0.1.0-alpha.1",
    "--commit", commit,
    "--tag-object", tagObject,
    "--source-date-epoch", String(sourceDateEpoch),
    "--core-contract", coreContractPath,
    "--tool-versions", toolVersionsPath,
  ], { encoding: "utf8" });
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  return releaseDir;
}

function runVerifier(releaseDir: string) {
  return spawnSync("python", [
    verifier,
    "--release-dir", releaseDir,
    "--tag", "v0.1.0-alpha.1",
    "--commit", commit,
    "--core-contract", coreContractPath,
    "--expected-tag-object", tagObject,
    "--expected-source-date-epoch", String(sourceDateEpoch),
    "--expected-tag-verification", "signature",
    "--expected-reproducibility-json", JSON.stringify(reproducibility),
    "--expected-tools-json", JSON.stringify(tools),
  ], { encoding: "utf8" });
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("release asset and metadata verification", () => {
  it("accepts the exact staged schema", () => {
    const result = runVerifier(fixture());
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    ["tagObject", (value: any) => { value.prism.tagObject = "c".repeat(40); }],
    ["sourceDateEpoch", (value: any) => { value.prism.sourceDateEpoch += 1; }],
    ["tagVerification", (value: any) => { value.prism.tagVerification = "ref-commit"; }],
    ["channel", (value: any) => { value.prism.channel = "stable"; }],
    ["prerelease", (value: any) => { value.prism.prerelease = false; }],
    ["reproducibility", (value: any) => { value.reproducibility.stagedAssetTimestampsNormalized = false; }],
    ["tools", (value: any) => { value.tools.node = "0.0.0"; }],
    ["schema extension", (value: any) => { value.unexpected = true; }],
  ] as const)("rejects metadata %s drift with refreshed integrity data", (_name, mutate) => {
    const releaseDir = fixture();
    const metadataPath = join(releaseDir, "BUILD_METADATA.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    mutate(metadata);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    refreshManifestEntry(releaseDir, "BUILD_METADATA.json");
    expect(runVerifier(releaseDir).status).not.toBe(0);
  });

  it("rejects a duplicate checksum entry", () => {
    const releaseDir = fixture();
    const checksumPath = join(releaseDir, "SHA256SUMS.txt");
    const first = readFileSync(checksumPath, "utf8").split(/\r?\n/)[0];
    writeFileSync(checksumPath, `${readFileSync(checksumPath, "utf8")}${first}\n`);
    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("duplicate checksum entry");
  });

  it.each([
    ["extra", (dir: string) => writeFileSync(join(dir, "EXTRA.txt"), "unexpected\n")],
    ["missing", (dir: string) => rmSync(join(dir, "tachyon-prism-linux-arm64_Prism.deb"))],
  ] as const)("rejects an %s staged asset", (_name, mutate) => {
    const releaseDir = fixture();
    mutate(releaseDir);
    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exactly 13 files");
  });

  it("rejects a wrong checksum digest", () => {
    const releaseDir = fixture();
    const checksumPath = join(releaseDir, "SHA256SUMS.txt");
    writeFileSync(checksumPath, readFileSync(checksumPath, "utf8").replace(/^[0-9a-f]{64}/, "0".repeat(64)));
    expect(runVerifier(releaseDir).stdout).toContain("SHA256SUMS.txt digest mismatch");
  });

  it("rejects installer format drift", () => {
    const releaseDir = fixture();
    renameSync(
      join(releaseDir, "tachyon-prism-windows-arm64_Prism.exe"),
      join(releaseDir, "tachyon-prism-windows-arm64_Prism.zip"),
    );
    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("installer layout");
  });

  it("rejects release index stable/preview drift", () => {
    const releaseDir = fixture();
    const indexPath = join(releaseDir, "RELEASE_INDEX.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    index.channels.stable.acceptsPrerelease = true;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    refreshManifestEntry(releaseDir, "RELEASE_INDEX.json");
    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("stable/preview runtime contract");
  });

  it("rejects manifest size drift even when its checksum is refreshed", () => {
    const releaseDir = fixture();
    const manifestPath = join(releaseDir, "RELEASE_MANIFEST.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.assets[0].size += 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeChecksums(releaseDir);
    const result = runVerifier(releaseDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("digest or size mismatch");
  });
});

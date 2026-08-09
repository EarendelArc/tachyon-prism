import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const governanceScript = fileURLToPath(
  new URL("../../../.github/scripts/check-release-governance.sh", import.meta.url),
);
const stageScript = fileURLToPath(
  new URL("../../../.github/scripts/stage-release-draft.sh", import.meta.url),
);
const publishScript = fileURLToPath(
  new URL("../../../.github/scripts/publish-staged-release.sh", import.meta.url),
);
const prepareScript = fileURLToPath(
  new URL("../../../scripts/prepare_release_assets.py", import.meta.url),
);
const coreContractPath = fileURLToPath(new URL("../../../core-contract.json", import.meta.url));
const toolVersionsPath = fileURLToPath(new URL("../../../.tool-versions", import.meta.url));
const releaseTools = Object.fromEntries(
  readFileSync(toolVersionsPath, "utf8").trim().split(/\r?\n/).map((line) => line.split(/\s+/, 2)),
);
const bashBinary = process.env.BASH_BINARY?.trim()
  || (process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash");
const tempDirs: string[] = [];
const shellPath = (path: string) => path.split("\\").join("/");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function executable(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

interface StagedRelease {
  releaseDir: string;
  notesEn: string;
  notesZh: string;
  assets: Array<{ digest: string; name: string; size: number }>;
}

function stageFixture(root: string): StagedRelease {
  const releaseDir = join(root, "release");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(releaseDir);
  const installers = [
    "tachyon-prism-windows-x64_Prism.exe",
    "tachyon-prism-windows-x64_Prism.msi",
    "tachyon-prism-windows-arm64_Prism.exe",
    "tachyon-prism-macos-x64_Prism.dmg",
    "tachyon-prism-macos-arm64_Prism.dmg",
    "tachyon-prism-linux-x64_Prism.deb",
    "tachyon-prism-linux-arm64_Prism.deb",
  ];
  for (const name of installers) {
    writeFileSync(join(releaseDir, name), `payload:${name}\n`, "utf8");
  }
  for (const target of ["windows-x64", "windows-arm64", "macos-x64", "macos-arm64", "linux-x64", "linux-arm64"]) {
    const statusDir = join(artifactsDir, `tachyon-prism-${target}`, "release-status");
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, `${target}.txt`), target.startsWith("linux-")
      ? "not-applicable-unsigned\n"
      : "unsigned-no-credentials\n");
  }
  const prepared = spawnSync("python", [
    prepareScript,
    "--release-dir", releaseDir,
    "--artifacts-dir", artifactsDir,
    "--tag", "v0.1.0-alpha.1",
    "--commit", "a".repeat(40),
    "--tag-object", "b".repeat(40),
    "--source-date-epoch", "1700000000",
    "--core-contract", coreContractPath,
    "--tool-versions", toolVersionsPath,
  ], { encoding: "utf8" });
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  const names = readFileSync(join(releaseDir, "SHA256SUMS.txt"), "utf8")
    .trim().split(/\r?\n/).map((line) => line.slice(66));
  names.push("SHA256SUMS.txt");
  return {
    releaseDir,
    notesEn: join(releaseDir, "RELEASE_NOTES.md"),
    notesZh: join(releaseDir, "RELEASE_NOTES.zh-CN.md"),
    assets: names.sort().map((name) => ({
      digest: `sha256:${sha256(join(releaseDir, name))}`,
      name,
      size: statSync(join(releaseDir, name)).size,
    })),
  };
}

function releaseBody(staged: StagedRelease): string {
  return `${readFileSync(staged.notesEn, "utf8").trimEnd()}\n\n---\n\n${readFileSync(staged.notesZh, "utf8").trimEnd()}`;
}

function releaseJson(
  staged: StagedRelease,
  overrides: Record<string, unknown> = {},
  assets = staged.assets,
): Record<string, unknown> {
  return {
    id: 4242,
    assets,
    body: releaseBody(staged),
    draft: true,
    immutable: false,
    name: "Tachyon Prism v0.1.0-alpha.1",
    prerelease: true,
    tag_name: "v0.1.0-alpha.1",
    target_commitish: "a".repeat(40),
    ...overrides,
  };
}

function commonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMMIT: "a".repeat(40),
    EXPECTED_REPRODUCIBILITY_JSON: JSON.stringify({
      installerByteReproducibilityGuaranteed: false,
      stagedAssetTimestampsNormalized: true,
    }),
    EXPECTED_SOURCE_DATE_EPOCH: "1700000000",
    EXPECTED_TAG_OBJECT: "b".repeat(40),
    EXPECTED_TAG_VERIFICATION: "signature",
    EXPECTED_TOOLS_JSON: JSON.stringify(releaseTools),
    GITHUB_REPOSITORY: "EarendelArc/tachyon-prism",
    VERSION: "v0.1.0-alpha.1",
    ...extra,
  };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
}

type GovernanceFailure =
  | "none" | "immutable-false" | "immutable-401" | "ruleset-list-api" | "no-ruleset"
  | "inactive" | "bypass" | "missing-rule" | "wrong-pattern" | "main-bypass"
  | "main-missing-check";

function runGovernance(failure: GovernanceFailure, ordinaryToken = false) {
  const root = mkdtempSync(join(tmpdir(), "prism-governance-"));
  tempDirs.push(root);
  const gh = join(root, "gh.sh");
  const log = join(root, "calls.log");
  executable(gh, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo \"$* TOKEN=${GH_TOKEN:-missing}\" >> \"${MOCK_LOG}\"",
    "joined=\"$*\"",
    "if [[ \"${joined}\" == *'/immutable-releases'* ]]; then",
    "  [[ \"${MOCK_FAILURE}\" != immutable-401 ]] || exit 1",
    "  [[ \"${MOCK_FAILURE}\" == immutable-false ]] && echo '{\"enabled\":false}' || echo '{\"enabled\":true}'",
    "  exit 0",
    "fi",
    "if [[ \"${joined}\" == *'/rulesets?includes_parents=false&per_page=100'* ]]; then",
    "  [[ \"${MOCK_FAILURE}\" != ruleset-list-api ]] || exit 1",
    "  [[ \"${MOCK_FAILURE}\" == no-ruleset ]] || printf '9001\\n9002\\n'",
    "  exit 0",
    "fi",
    "if [[ \"${joined}\" == *'/rulesets/9001'* ]]; then",
    "  enforcement=active; bypass='[]'; update=',{\"type\":\"update\"}'; pattern='refs/tags/v*'",
    "  [[ \"${MOCK_FAILURE}\" != inactive ]] || enforcement=disabled",
    "  [[ \"${MOCK_FAILURE}\" != bypass ]] || bypass='[{\"actor_id\":1}]'",
    "  [[ \"${MOCK_FAILURE}\" != missing-rule ]] || update=''",
    "  [[ \"${MOCK_FAILURE}\" != wrong-pattern ]] || pattern='refs/tags/release-*'",
    "  printf '{\"target\":\"tag\",\"enforcement\":\"%s\",\"bypass_actors\":%s,\"conditions\":{\"ref_name\":{\"include\":[\"%s\"],\"exclude\":[]}},\"rules\":[{\"type\":\"deletion\"},{\"type\":\"non_fast_forward\"}%s]}\\n' \"${enforcement}\" \"${bypass}\" \"${pattern}\" \"${update}\"",
    "  exit 0",
    "fi",
    "if [[ \"${joined}\" == *'/rulesets/9002'* ]]; then",
    "  bypass='[]'; context='Required CI gate'",
    "  [[ \"${MOCK_FAILURE}\" != main-bypass ]] || bypass='[{\"actor_id\":1}]'",
    "  [[ \"${MOCK_FAILURE}\" != main-missing-check ]] || context='Other check'",
    "  printf '{\"target\":\"branch\",\"enforcement\":\"active\",\"bypass_actors\":%s,\"conditions\":{\"ref_name\":{\"include\":[\"refs/heads/main\"],\"exclude\":[]}},\"rules\":[{\"type\":\"deletion\"},{\"type\":\"non_fast_forward\"},{\"type\":\"pull_request\"},{\"type\":\"required_status_checks\",\"parameters\":{\"strict_required_status_checks_policy\":true,\"required_status_checks\":[{\"context\":\"%s\"}]}}]}\\n' \"${bypass}\" \"${context}\"",
    "  exit 0",
    "fi",
    "exit 99",
    "",
  ].join("\n"));
  const env = commonEnv({
    GH_CLI: shellPath(gh),
    MOCK_FAILURE: failure,
    MOCK_LOG: shellPath(log),
    RELEASE_SETTINGS_TOKEN: "settings-token",
  });
  if (!ordinaryToken) delete env.GH_TOKEN;
  else env.GH_TOKEN = "contents-token";
  const result = spawnSync(bashBinary, [shellPath(governanceScript)], { encoding: "utf8", env });
  return { log: lines(log), result };
}

type StageMode = "fresh" | "full" | "partial" | "wrong-target" | "duplicate" | "extra"
  | "digest" | "size" | "public" | "multiple" | "list-api";

function runStage(mode: StageMode, options: { omitChinese?: boolean; settingsToken?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prism-stage-"));
  tempDirs.push(root);
  const staged = stageFixture(root);
  const log = join(root, "calls.log");
  const state = join(root, "state.txt");
  const output = join(root, "output.txt");
  const gh = join(root, "gh.sh");
  const verify = join(root, "verify.sh");
  const emptyJson = join(root, "empty.json");
  const partialJson = join(root, "partial.json");
  const fullJson = join(root, "full.json");
  const currentJson = join(root, "current.json");
  writeFileSync(emptyJson, JSON.stringify(releaseJson(staged, {}, [])));
  writeFileSync(partialJson, JSON.stringify(releaseJson(staged, {}, staged.assets.slice(0, -1))));
  writeFileSync(fullJson, JSON.stringify(releaseJson(staged)));
  let current = releaseJson(staged);
  if (mode === "wrong-target") current = releaseJson(staged, { target_commitish: "c".repeat(40) });
  if (mode === "duplicate") current = releaseJson(staged, {}, [...staged.assets, staged.assets[0]]);
  if (mode === "extra") current = releaseJson(staged, {}, [...staged.assets, { name: "EXTRA", digest: `sha256:${"0".repeat(64)}`, size: 1 }]);
  if (mode === "digest") current = releaseJson(staged, {}, staged.assets.map((asset, index) => index ? asset : { ...asset, digest: `sha256:${"0".repeat(64)}` }));
  if (mode === "size") current = releaseJson(staged, {}, staged.assets.map((asset, index) => index ? asset : { ...asset, size: asset.size + 1 }));
  if (mode === "public") current = releaseJson(staged, { draft: false, immutable: true });
  writeFileSync(currentJson, JSON.stringify(current));
  if (options.omitChinese) rmSync(staged.notesZh);
  writeFileSync(state, mode === "fresh" ? "none" : mode === "partial" ? "partial" : "current");
  executable(verify, "#!/usr/bin/env bash\nset -euo pipefail\necho VERIFY >> \"${MOCK_LOG}\"\n");
  executable(gh, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "joined=\"$*\"",
    "if [[ \"${joined}\" == *'/releases?per_page=100'* ]]; then",
    "  echo LIST >> \"${MOCK_LOG}\"",
    "  [[ \"${MOCK_MODE}\" != list-api ]] || exit 1",
    "  [[ \"${MOCK_MODE}\" == fresh ]] && exit 0",
    "  [[ \"${MOCK_MODE}\" != multiple ]] || { printf '4242\\n4243\\n'; exit 0; }",
    "  echo 4242; exit 0",
    "fi",
    "if [[ \"${joined}\" == *'--method POST'* ]]; then",
    "  echo POST >> \"${MOCK_LOG}\"; echo empty > \"${MOCK_STATE}\"; echo 4242; exit 0",
    "fi",
    "if [[ \"$1\" == release && \"$2\" == upload ]]; then",
    "  echo \"UPLOAD $(basename \"$4\")\" >> \"${MOCK_LOG}\"; echo full > \"${MOCK_STATE}\"; exit 0",
    "fi",
    "if [[ \"${joined}\" == *'/releases/4242'* ]]; then",
    "  echo GET >> \"${MOCK_LOG}\"",
    "  case \"$(cat \"${MOCK_STATE}\")\" in",
    "    empty) cat \"${MOCK_EMPTY_JSON}\" ;;",
    "    partial) cat \"${MOCK_PARTIAL_JSON}\" ;;",
    "    full) cat \"${MOCK_FULL_JSON}\" ;;",
    "    *) cat \"${MOCK_CURRENT_JSON}\" ;;",
    "  esac",
    "  exit 0",
    "fi",
    "echo \"UNEXPECTED ${joined}\" >> \"${MOCK_LOG}\"; exit 99",
    "",
  ].join("\n"));
  const env = commonEnv({
    GH_CLI: shellPath(gh),
    GH_TOKEN: "contents-token",
    GITHUB_OUTPUT: shellPath(output),
    MOCK_CURRENT_JSON: shellPath(currentJson),
    MOCK_EMPTY_JSON: shellPath(emptyJson),
    MOCK_FULL_JSON: shellPath(fullJson),
    MOCK_LOG: shellPath(log),
    MOCK_MODE: mode,
    MOCK_PARTIAL_JSON: shellPath(partialJson),
    MOCK_STATE: shellPath(state),
    PRERELEASE: "true",
    TAG_VERIFY_SCRIPT: shellPath(verify),
  });
  if (options.settingsToken) env.RELEASE_SETTINGS_TOKEN = "settings-token";
  else delete env.RELEASE_SETTINGS_TOKEN;
  const result = spawnSync(bashBinary, [
    shellPath(stageScript), shellPath(staged.notesEn), shellPath(staged.notesZh), shellPath(staged.releaseDir),
  ], { encoding: "utf8", env });
  return { log: lines(log), output: lines(output), result };
}

type PublishMode = "none" | "immutable-false" | "digest" | "size" | "non-prerelease"
  | "target" | "latest" | "latest-401" | "latest-404";

function runPublish(mode: PublishMode, settingsToken = false) {
  const root = mkdtempSync(join(tmpdir(), "prism-publish-"));
  tempDirs.push(root);
  const staged = stageFixture(root);
  const log = join(root, "calls.log");
  const state = join(root, "state.txt");
  const gh = join(root, "gh.sh");
  const verify = join(root, "verify.sh");
  const draftJson = join(root, "draft.json");
  const publishedJson = join(root, "published.json");
  writeFileSync(draftJson, JSON.stringify(releaseJson(staged)));
  let assets = staged.assets;
  if (mode === "digest") assets = assets.map((asset, index) => index ? asset : { ...asset, digest: `sha256:${"0".repeat(64)}` });
  if (mode === "size") assets = assets.map((asset, index) => index ? asset : { ...asset, size: asset.size + 1 });
  writeFileSync(publishedJson, JSON.stringify(releaseJson(staged, {
    draft: false,
    immutable: mode !== "immutable-false",
    prerelease: mode !== "non-prerelease",
    target_commitish: mode === "target" ? "c".repeat(40) : "a".repeat(40),
  }, assets)));
  writeFileSync(state, "draft");
  executable(verify, "#!/usr/bin/env bash\nset -euo pipefail\necho VERIFY >> \"${MOCK_LOG}\"\n");
  executable(gh, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "joined=\"$*\"",
    "if [[ \"${joined}\" == *'--include'* && \"${joined}\" == *'/releases/latest'* ]]; then",
    "  echo LATEST >> \"${MOCK_LOG}\"",
    "  case \"${MOCK_MODE}\" in",
    "    latest-401) printf 'HTTP/2 401 Unauthorized\\r\\n\\r\\n{\"message\":\"Bad credentials\"}\\n'; exit 1 ;;",
    "    latest-404) printf 'HTTP/2 404 Not Found\\r\\n\\r\\n{\"message\":\"Not Found\"}\\n'; exit 1 ;;",
    "    latest) tag=v0.1.0-alpha.1 ;;",
    "    *) tag=v0.0.9 ;;",
    "  esac",
    "  printf 'HTTP/2 200 OK\\r\\n\\r\\n{\"tag_name\":\"%s\"}\\n' \"${tag}\"; exit 0",
    "fi",
    "if [[ \"${joined}\" == *'--method PATCH'* ]]; then",
    "  echo PATCH >> \"${MOCK_LOG}\"; echo published > \"${MOCK_STATE}\"; echo '{}'; exit 0",
    "fi",
    "if [[ \"${joined}\" == *'/releases/4242'* ]]; then",
    "  if [[ \"$(cat \"${MOCK_STATE}\")\" == draft ]]; then echo GET_DRAFT >> \"${MOCK_LOG}\"; cat \"${MOCK_DRAFT_JSON}\"; else echo GET_PUBLISHED >> \"${MOCK_LOG}\"; cat \"${MOCK_PUBLISHED_JSON}\"; fi",
    "  exit 0",
    "fi",
    "echo \"UNEXPECTED ${joined}\" >> \"${MOCK_LOG}\"; exit 99",
    "",
  ].join("\n"));
  const env = commonEnv({
    GH_CLI: shellPath(gh),
    GH_TOKEN: "contents-token",
    MOCK_DRAFT_JSON: shellPath(draftJson),
    MOCK_LOG: shellPath(log),
    MOCK_MODE: mode,
    MOCK_PUBLISHED_JSON: shellPath(publishedJson),
    MOCK_STATE: shellPath(state),
    RELEASE_ID: "4242",
    TAG_VERIFY_SCRIPT: shellPath(verify),
  });
  if (settingsToken) env.RELEASE_SETTINGS_TOKEN = "settings-token";
  else delete env.RELEASE_SETTINGS_TOKEN;
  const result = spawnSync(bashBinary, [shellPath(publishScript), shellPath(staged.releaseDir)], {
    encoding: "utf8", env,
  });
  return { log: lines(log), result };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("A/C governance-only release checks", () => {
  it("accepts immutable releases and strict no-bypass rulesets with only the settings token", () => {
    const run = runGovernance("none");
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.log).toHaveLength(4);
    expect(run.log.every((line) => line.endsWith("TOKEN=settings-token"))).toBe(true);
  });

  it.each([
    ["immutable-false", "GitHub immutable releases must be enabled"],
    ["immutable-401", ""],
    ["ruleset-list-api", ""],
    ["no-ruleset", "repository has no rulesets"],
    ["inactive", "active, zero-bypass tag ruleset"],
    ["bypass", "active, zero-bypass tag ruleset"],
    ["missing-rule", "active, zero-bypass tag ruleset"],
    ["wrong-pattern", "active, zero-bypass tag ruleset"],
    ["main-bypass", "active, zero-bypass main ruleset"],
    ["main-missing-check", "active, zero-bypass main ruleset"],
  ] as const)("fails closed for governance fixture %s", (failure, message) => {
    const run = runGovernance(failure);
    expect(run.result.status).not.toBe(0);
    if (message) expect(run.result.stdout).toContain(message);
  });

  it("rejects an ordinary contents token in the governance process", () => {
    const run = runGovernance("none", true);
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toContain("GH_TOKEN must not be present");
    expect(run.log).toEqual([]);
  });
});

describe("B resumable private draft staging", () => {
  it("rejects missing Chinese notes before calling GitHub", () => {
    const run = runStage("fresh", { omitChinese: true });
    expect(run.result.status).not.toBe(0);
    expect(run.log).toEqual([]);
  });

  it("creates a fresh private draft, uploads exact assets, and never publishes it", () => {
    const run = runStage("fresh");
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    expect(run.log).toContain("POST");
    expect(run.log.filter((line) => line.startsWith("UPLOAD "))).toHaveLength(13);
    expect(run.log).not.toContain("PATCH");
    expect(run.output).toEqual(["release_id=4242"]);
  });

  it("resumes an exact complete draft without replacing assets", () => {
    const run = runStage("full");
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    expect(run.log).toEqual(["LIST", "GET", "GET"]);
  });

  it("resumes a partial exact draft by uploading only its missing asset", () => {
    const run = runStage("partial");
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    expect(run.log.filter((line) => line.startsWith("UPLOAD "))).toHaveLength(1);
    expect(run.log).not.toContain("POST");
  });

  it.each([
    ["wrong-target", "target_commitish"],
    ["duplicate", "duplicate asset"],
    ["extra", "unexpected asset"],
    ["digest", "digest mismatch"],
    ["size", "size mismatch"],
    ["public", "draft"],
  ] as const)("rejects contaminated existing draft fixture %s", (mode, message) => {
    const run = runStage(mode);
    expect(run.result.status).not.toBe(0);
    expect(run.result.stdout).toContain(message);
    expect(run.log.some((line) => line.startsWith("UPLOAD "))).toBe(false);
  });

  it("rejects the settings token in a contents-write stage", () => {
    const run = runStage("fresh", { settingsToken: true });
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toContain("RELEASE_SETTINGS_TOKEN must not be present");
    expect(run.log).toEqual([]);
  });

  it("rejects multiple releases for the same tag", () => {
    const run = runStage("multiple");
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toContain("multiple releases already exist");
  });

  it("fails closed when the same-tag release listing API fails", () => {
    const run = runStage("list-api");
    expect(run.result.status).not.toBe(0);
    expect(run.log).toEqual(["LIST"]);
  });
});

describe("D publication and immutable readback", () => {
  it("verifies the private draft, publishes once, and verifies immutable readback", () => {
    const run = runPublish("none");
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    expect(run.log).toEqual(["GET_DRAFT", "VERIFY", "PATCH", "GET_PUBLISHED", "LATEST"]);
  });

  it("does not patch until the complete private draft has passed validation", () => {
    const run = runPublish("none");
    expect(run.log.indexOf("GET_DRAFT")).toBeLessThan(run.log.indexOf("PATCH"));
    expect(run.log.indexOf("VERIFY")).toBeLessThan(run.log.indexOf("PATCH"));
  });

  it.each([
    ["immutable-false", "immutable"],
    ["digest", "digest mismatch"],
    ["size", "size mismatch"],
    ["non-prerelease", "prerelease"],
    ["target", "target_commitish"],
    ["latest", "unexpectedly became GitHub latest"],
  ] as const)("fails post-publication verification for %s", (mode, message) => {
    const run = runPublish(mode);
    expect(run.result.status).not.toBe(0);
    expect(run.log).toContain("PATCH");
    expect(`${run.result.stdout}\n${run.result.stderr}`).toContain(message);
  });

  it("fails closed when the Latest recheck returns 401", () => {
    const run = runPublish("latest-401");
    expect(run.result.status).not.toBe(0);
    expect(`${run.result.stdout}\n${run.result.stderr}`).toContain("HTTP 401");
  });

  it("accepts only an explicit Latest 404 as no stable release", () => {
    const run = runPublish("latest-404");
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
  });

  it("rejects the settings token in the publication process", () => {
    const run = runPublish("none", true);
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toContain("RELEASE_SETTINGS_TOKEN must not be present");
    expect(run.log).toEqual([]);
  });
});

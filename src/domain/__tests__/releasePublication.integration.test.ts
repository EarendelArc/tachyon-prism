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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const publishScript = fileURLToPath(
  new URL("../../../.github/scripts/publish-release.sh", import.meta.url),
);
const prepareScript = fileURLToPath(
  new URL("../../../scripts/prepare_release_assets.py", import.meta.url),
);
const coreContractPath = fileURLToPath(new URL("../../../core-contract.json", import.meta.url));
const toolVersionsPath = fileURLToPath(new URL("../../../.tool-versions", import.meta.url));
const releaseTools = Object.fromEntries(
  readFileSync(toolVersionsPath, "utf8").trim().split(/\r?\n/).map((line) => line.split(/\s+/, 2)),
);
const tempDirs: string[] = [];
const bashBinary = process.env.BASH_BINARY?.trim()
  || (process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash");

const shellPath = (path: string) => path.split("\\").join("/");
const digest = (contents: Buffer | string) => createHash("sha256").update(contents).digest("hex");

function executable(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

type Failure =
  | "body-chinese-missing"
  | "body-english-missing"
  | "body-order"
  | "body-paragraph"
  | "digest"
  | "size"
  | "governance-bypass"
  | "governance-immutable-api"
  | "governance-immutable"
  | "governance-inactive"
  | "governance-missing-rule"
  | "governance-no-ruleset"
  | "governance-wrong-pattern"
  | "governance-main-bypass"
  | "governance-main-missing-check"
  | "governance-main-wrong-pattern"
  | "immutable"
  | "non-prerelease"
  | "latest"
  | "latest-401"
  | "latest-403"
  | "latest-404"
  | "latest-500"
  | "latest-network"
  | "none"
  | "patch-draft"
  | "patch-published"
  | "remote-duplicate"
  | "remote-extra"
  | "remote-missing"
  | "remote-metadata-digest"
  | "ruleset-list-api"
  | "target"
  | "upload";

function stageRelease(releaseDir: string, omitChinese: boolean): {
  notesEn: string;
  notesZh: string;
  remoteAssets: Array<{ digest: string; name: string; size: number }>;
} {
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
  const artifactsDir = join(releaseDir, "..", "artifacts");
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
  const notesEn = join(releaseDir, "RELEASE_NOTES.md");
  const notesZh = join(releaseDir, "RELEASE_NOTES.zh-CN.md");
  if (!omitChinese) {
    // Prepared above.
  } else {
    rmSync(notesZh);
  }
  const remoteNames = [
    ...installers,
    "BUILD_METADATA.json",
    "RELEASE_INDEX.json",
    "RELEASE_MANIFEST.json",
    "RELEASE_NOTES.md",
    ...(omitChinese ? [] : ["RELEASE_NOTES.zh-CN.md"]),
    "SHA256SUMS.txt",
  ].sort();
  return {
    notesEn,
    notesZh,
    remoteAssets: remoteNames.map((name) => ({
      digest: `sha256:${digest(readFileSync(join(releaseDir, name)))}`,
      name,
      size: statSync(join(releaseDir, name)).size,
    })),
  };
}

function runPublication(failAt: Failure, omitChinese = false) {
  const root = mkdtempSync(join(tmpdir(), "prism-release-publication-"));
  tempDirs.push(root);
  const releaseDir = join(root, "release");
  const logPath = join(root, "calls.log");
  const statePath = join(root, "release.state");
  const releaseJsonPath = join(root, "release.json");
  const ghPath = join(root, "mock-gh.sh");
  const verifyPath = join(root, "mock-verify.sh");
  mkdirSync(releaseDir);
  const staged = stageRelease(releaseDir, omitChinese);
  const english = readFileSync(staged.notesEn, "utf8").trimEnd();
  const chinese = omitChinese ? "" : readFileSync(staged.notesZh, "utf8").trimEnd();
  let remoteAssets = staged.remoteAssets.map((asset, index) => (
    failAt === "digest" && index === 0
      ? { ...asset, digest: `sha256:${"0".repeat(64)}` }
      : failAt === "size" && index === 0
        ? { ...asset, size: asset.size + 1 }
        : asset
  ));
  if (failAt === "remote-extra") {
    remoteAssets = [...remoteAssets, { digest: `sha256:${"1".repeat(64)}`, name: "EXTRA.txt", size: 1 }];
  } else if (failAt === "remote-missing") {
    remoteAssets = remoteAssets.slice(1);
  } else if (failAt === "remote-duplicate") {
    remoteAssets = [...remoteAssets, remoteAssets[0]];
  } else if (failAt === "remote-metadata-digest") {
    remoteAssets = remoteAssets.map((asset) => asset.name === "BUILD_METADATA.json"
      ? { ...asset, digest: `sha256:${"2".repeat(64)}` }
      : asset);
  }
  const releaseBody = failAt === "body-english-missing"
    ? chinese
    : failAt === "body-chinese-missing"
      ? english
      : failAt === "body-order"
        ? `${chinese}\n\n---\n\n${english}`
        : failAt === "body-paragraph"
          ? `${english.replace("This is an immutable", "This is a modified")}\n\n---\n\n${chinese}`
        : `${english}\n\n---\n\n${chinese}`;
  writeFileSync(
    releaseJsonPath,
    JSON.stringify({
      assets: remoteAssets,
      body: releaseBody,
      draft: false,
      immutable: failAt !== "immutable",
      prerelease: failAt !== "non-prerelease",
      tag_name: "v0.1.0-alpha.1",
      target_commitish: failAt === "target" ? "c".repeat(40) : "a".repeat(40),
    }),
    "utf8",
  );
  executable(
    verifyPath,
    ["#!/usr/bin/env bash", "set -euo pipefail", "echo VERIFY >> \"${MOCK_LOG}\"", ""].join("\n"),
  );
  executable(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "joined=\"$*\"",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/releases?per_page=100\"* ]]; then",
      "  echo LIST >> \"${MOCK_LOG}\"",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/immutable-releases\"* ]]; then",
      "  echo GET_IMMUTABLE >> \"${MOCK_LOG}\"",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-immutable-api ]] || exit 75",
      "  [[ \"${MOCK_FAIL_AT}\" == governance-immutable ]] && echo '{\"enabled\":false}' || echo '{\"enabled\":true}'",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/rulesets?includes_parents=false&per_page=100\"* ]]; then",
      "  echo GET_RULESET_LIST >> \"${MOCK_LOG}\"",
      "  [[ \"${MOCK_FAIL_AT}\" != ruleset-list-api ]] || exit 74",
      "  if [[ \"${MOCK_FAIL_AT}\" != governance-no-ruleset ]]; then printf '9001\\n9002\\n'; fi",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/rulesets/9001\"* ]]; then",
      "  echo GET_RULESET_DETAIL >> \"${MOCK_LOG}\"",
      "  bypass='[]'",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-bypass ]] || bypass='[{\"actor_id\":1,\"actor_type\":\"OrganizationAdmin\",\"bypass_mode\":\"always\"}]'",
      "  update_rule=',{\"type\":\"update\"}'",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-missing-rule ]] || update_rule=''",
      "  enforcement=active",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-inactive ]] || enforcement=disabled",
      "  pattern='refs/tags/v*'",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-wrong-pattern ]] || pattern='refs/tags/release-*'",
      "  printf '{\"id\":9001,\"target\":\"tag\",\"enforcement\":\"%s\",\"bypass_actors\":%s,\"conditions\":{\"ref_name\":{\"include\":[\"%s\"],\"exclude\":[]}},\"rules\":[{\"type\":\"deletion\"},{\"type\":\"non_fast_forward\"}%s]}\\n' \"${enforcement}\" \"${bypass}\" \"${pattern}\" \"${update_rule}\"",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/rulesets/9002\"* ]]; then",
      "  echo GET_MAIN_RULESET_DETAIL >> \"${MOCK_LOG}\"",
      "  bypass='[]'",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-main-bypass ]] || bypass='[{\"actor_id\":1,\"actor_type\":\"RepositoryRole\",\"bypass_mode\":\"always\"}]'",
      "  pattern='refs/heads/main'",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-main-wrong-pattern ]] || pattern='refs/heads/trunk'",
      "  context='Required CI gate'",
      "  [[ \"${MOCK_FAIL_AT}\" != governance-main-missing-check ]] || context='Other check'",
      "  printf '{\"id\":9002,\"target\":\"branch\",\"enforcement\":\"active\",\"bypass_actors\":%s,\"conditions\":{\"ref_name\":{\"include\":[\"%s\"],\"exclude\":[]}},\"rules\":[{\"type\":\"deletion\"},{\"type\":\"non_fast_forward\"},{\"type\":\"pull_request\"},{\"type\":\"required_status_checks\",\"parameters\":{\"strict_required_status_checks_policy\":true,\"required_status_checks\":[{\"context\":\"%s\"}]}}]}\\n' \"${bypass}\" \"${pattern}\" \"${context}\"",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"--method POST\"* ]]; then",
      "  echo POST >> \"${MOCK_LOG}\"",
      "  echo draft > \"${MOCK_STATE}\"",
      "  echo 4242",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == release && \"$2\" == upload ]]; then",
      "  echo UPLOAD >> \"${MOCK_LOG}\"",
      "  [[ \"${MOCK_FAIL_AT}\" != upload ]] || exit 71",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"--method PATCH\"* ]]; then",
      "  echo PATCH >> \"${MOCK_LOG}\"",
      "  if [[ \"${MOCK_FAIL_AT}\" == patch-published ]]; then",
      "    echo published > \"${MOCK_STATE}\"",
      "    exit 72",
      "  fi",
      "  [[ \"${MOCK_FAIL_AT}\" != patch-draft ]] || exit 73",
      "  echo published > \"${MOCK_STATE}\"",
      "  echo '{}'",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"--include\"* && \"${joined}\" == *\"/releases/latest\"* ]]; then",
      "  echo LATEST >> \"${MOCK_LOG}\"",
      "  case \"${MOCK_FAIL_AT}\" in",
      "    latest-401) printf 'HTTP/2 401 Unauthorized\\r\\nContent-Type: application/json\\r\\n\\r\\n{\"message\":\"Bad credentials\"}\\n'; exit 1 ;;",
      "    latest-403) printf 'HTTP/2 403 Forbidden\\r\\nContent-Type: application/json\\r\\n\\r\\n{\"message\":\"Forbidden\"}\\n'; exit 1 ;;",
      "    latest-404) printf 'HTTP/2 404 Not Found\\r\\nContent-Type: application/json\\r\\n\\r\\n{\"message\":\"Not Found\"}\\n'; exit 1 ;;",
      "    latest-500) printf 'HTTP/2 500 Internal Server Error\\r\\nContent-Type: application/json\\r\\n\\r\\n{\"message\":\"Failure\"}\\n'; exit 1 ;;",
      "    latest-network) echo 'network unavailable' >&2; exit 1 ;;",
      "    latest) tag=v0.1.0-alpha.1 ;;",
      "    *) tag=v0.0.9 ;;",
      "  esac",
      "  printf 'HTTP/2 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{\"tag_name\":\"%s\"}\\n' \"${tag}\"",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"--method DELETE\"* ]]; then",
      "  echo \"DELETE ${joined}\" >> \"${MOCK_LOG}\"",
      "  echo deleted > \"${MOCK_STATE}\"",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/releases/4242\"* ]]; then",
      "  state=$(<\"${MOCK_STATE}\")",
      "  if [[ \"${joined}\" == *\"--jq\"* ]]; then",
      "    echo \"GET_CLEANUP ${joined}\" >> \"${MOCK_LOG}\"",
      "    draft=true",
      "    [[ \"${state}\" != published ]] || draft=false",
      "    printf '4242\\t%s\\tv0.1.0-alpha.1\\n' \"${draft}\"",
      "  else",
      "    echo \"GET_READBACK ${joined}\" >> \"${MOCK_LOG}\"",
      "    cat \"${MOCK_RELEASE_JSON}\"",
      "  fi",
      "  exit 0",
      "fi",
      "echo \"unexpected gh call: ${joined}\" >&2",
      "exit 99",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    bashBinary,
    [shellPath(publishScript), shellPath(staged.notesEn), shellPath(staged.notesZh), shellPath(releaseDir)],
    {
      encoding: "utf8",
      env: {
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
        GH_CLI: shellPath(ghPath),
        GITHUB_REPOSITORY: "EarendelArc/tachyon-prism",
        RELEASE_SETTINGS_TOKEN: "governance-test-token",
        MOCK_FAIL_AT: failAt,
        MOCK_LOG: shellPath(logPath),
        MOCK_RELEASE_JSON: shellPath(releaseJsonPath),
        MOCK_STATE: shellPath(statePath),
        PRERELEASE: "true",
        TAG_VERIFY_SCRIPT: shellPath(verifyPath),
        VERSION: "v0.1.0-alpha.1",
      },
    },
  );
  return {
    log: existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split(/\r?\n/) : [],
    result,
    state: existsSync(statePath) ? readFileSync(statePath, "utf8").trim() : "not-created",
  };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("release publication transaction", () => {
  it("rejects a release with no Chinese notes before any GitHub write", () => {
    const run = runPublication("none", true);

    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toContain("Chinese release notes are missing");
    expect(run.log).toEqual([]);
    expect(run.state).toBe("not-created");
  });

  it("cleans only its draft release ID when upload fails", () => {
    const run = runPublication("upload");

    expect(run.result.status).not.toBe(0);
    expect(run.log.slice(0, 8)).toEqual([
      "LIST",
      "GET_IMMUTABLE",
      "GET_RULESET_LIST",
      "GET_RULESET_DETAIL",
      "GET_MAIN_RULESET_DETAIL",
      "VERIFY",
      "POST",
      "UPLOAD",
    ]);
    expect(run.log).toContainEqual(expect.stringContaining("GET_CLEANUP api repos/EarendelArc/tachyon-prism/releases/4242"));
    expect(run.log).toContainEqual(expect.stringContaining("DELETE api --method DELETE repos/EarendelArc/tachyon-prism/releases/4242"));
    expect(run.state).toBe("deleted");
  });

  it("cleans its still-draft release ID when publish PATCH fails", () => {
    const run = runPublication("patch-draft");

    expect(run.result.status).not.toBe(0);
    expect(run.log).toContain("PATCH");
    expect(run.log).toContainEqual(expect.stringContaining("DELETE api --method DELETE repos/EarendelArc/tachyon-prism/releases/4242"));
    expect(run.state).toBe("deleted");
  });

  it("never deletes a release that became official before PATCH reported failure", () => {
    const run = runPublication("patch-published");

    expect(run.result.status).not.toBe(0);
    expect(run.log).toContain("PATCH");
    expect(run.log.some((line) => line.startsWith("DELETE "))).toBe(false);
    expect(run.state).toBe("published");
    expect(run.result.stderr).toContain("refusing deletion");
  });

  it("fails closed when published immutable state is false", () => {
    const run = runPublication("immutable");

    expect(run.result.status).not.toBe(0);
    expect(run.log).toContainEqual(expect.stringContaining("GET_READBACK"));
    expect(run.log).toContain("LATEST");
    expect(run.log.some((line) => line.startsWith("DELETE "))).toBe(false);
    expect(run.state).toBe("published");
    expect(run.result.stdout).toContain("immutable");
  });

  it.each([
    ["digest", "digest mismatch"],
    ["size", "size mismatch"],
    ["latest", "unexpectedly became GitHub latest"],
    ["non-prerelease", "prerelease"],
    ["target", "target_commitish"],
  ] as const)("fails closed for a mismatched published %s", (failure, message) => {
    const run = runPublication(failure);

    expect(run.result.status).not.toBe(0);
    expect(run.log.some((line) => line.startsWith("DELETE "))).toBe(false);
    expect(run.state).toBe("published");
    expect(`${run.result.stdout}\n${run.result.stderr}`).toContain(message);
  });

  it.each([
    "governance-immutable",
    "governance-immutable-api",
    "governance-inactive",
    "governance-bypass",
    "governance-missing-rule",
    "governance-no-ruleset",
    "governance-wrong-pattern",
    "governance-main-bypass",
    "governance-main-missing-check",
    "governance-main-wrong-pattern",
    "ruleset-list-api",
  ] as const)("fails before every GitHub write when %s is detected", (failure) => {
    const run = runPublication(failure);

    expect(run.result.status).not.toBe(0);
    expect(run.log).toContain("LIST");
    expect(run.log.some((line) => ["POST", "UPLOAD", "PATCH"].includes(line))).toBe(false);
    expect(run.log.some((line) => line.startsWith("DELETE "))).toBe(false);
    expect(run.state).toBe("not-created");
  });

  it("accepts only an explicit HTTP 404 as no GitHub Latest release", () => {
    const run = runPublication("latest-404");

    expect(run.result.status, `${run.result.stdout}\n${run.result.stderr}`).toBe(0);
    expect(run.state).toBe("published");
  });

  it.each([
    ["latest-401", "HTTP 401"],
    ["latest-403", "HTTP 403"],
    ["latest-500", "HTTP 500"],
    ["latest-network", "did not contain an HTTP status line"],
  ] as const)("fails closed when GitHub Latest returns %s", (failure, message) => {
    const run = runPublication(failure);

    expect(run.result.status).not.toBe(0);
    expect(run.state).toBe("published");
    expect(`${run.result.stdout}\n${run.result.stderr}`).toContain(message);
  });

  it.each([
    "body-english-missing",
    "body-chinese-missing",
    "body-order",
    "body-paragraph",
  ] as const)("rejects published bilingual body mutation %s", (failure) => {
    const run = runPublication(failure);

    expect(run.result.status).not.toBe(0);
    expect(run.state).toBe("published");
    expect(run.result.stdout).toContain("published release body");
  });

  it.each([
    "remote-extra",
    "remote-missing",
    "remote-duplicate",
  ] as const)("rejects published asset-set mutation %s", (failure) => {
    const run = runPublication(failure);

    expect(run.result.status).not.toBe(0);
    expect(run.result.stdout).toMatch(/exact 13 staged assets|duplicate asset/);
  });

  it("rejects a published BUILD_METADATA digest drift", () => {
    const run = runPublication("remote-metadata-digest");

    expect(run.result.status).not.toBe(0);
    expect(run.result.stdout).toContain("published digest mismatch for BUILD_METADATA.json");
  });

  it("publishes and verifies the exact remote release state", () => {
    const run = runPublication("none");

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.log).toEqual([
      "LIST",
      "GET_IMMUTABLE",
      "GET_RULESET_LIST",
      "GET_RULESET_DETAIL",
      "GET_MAIN_RULESET_DETAIL",
      "VERIFY",
      "POST",
      "UPLOAD",
      "PATCH",
      "GET_READBACK api repos/EarendelArc/tachyon-prism/releases/4242",
      "LATEST",
    ]);
    expect(run.state).toBe("published");
  });
});

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
const coreContract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../core-contract.json", import.meta.url)), "utf8"),
) as Record<string, string>;
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

type Failure = "digest" | "immutable" | "latest" | "none" | "patch-draft" | "patch-published" | "target" | "upload";

function stageRelease(releaseDir: string, omitChinese: boolean): {
  notesEn: string;
  notesZh: string;
  remoteAssets: Array<{ digest: string; name: string }>;
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
  const notesEn = join(releaseDir, "RELEASE_NOTES.md");
  const notesZh = join(releaseDir, "RELEASE_NOTES.zh-CN.md");
  writeFileSync(notesEn, "# Tachyon Prism\n\nEnglish notes.\n", "utf8");
  if (!omitChinese) {
    writeFileSync(notesZh, "# Tachyon Prism\n\n中文发布说明。\n", "utf8");
  }
  const artifactDigests = Object.fromEntries(
    installers.map((name) => [name, `sha256:${digest(readFileSync(join(releaseDir, name)))}`]),
  );
  writeFileSync(
    join(releaseDir, "BUILD_METADATA.json"),
    `${JSON.stringify({
      artifactDigests,
      coreContract,
      prism: {
        commit: "a".repeat(40),
        sourceDateEpoch: 1_700_000_000,
        tag: "v0.1.0-alpha.1",
        tagObject: "b".repeat(40),
        tagVerification: "ref-commit",
      },
      reproducibility: {
        installerByteReproducibilityGuaranteed: false,
        stagedAssetTimestampsNormalized: true,
      },
      schemaVersion: 1,
      tools: { node: "26.4.0" },
    }, null, 2)}\n`,
    "utf8",
  );
  const manifestNames = [
    ...installers,
    "BUILD_METADATA.json",
    "RELEASE_NOTES.md",
    ...(omitChinese ? [] : ["RELEASE_NOTES.zh-CN.md"]),
  ].sort();
  writeFileSync(
    join(releaseDir, "SHA256SUMS.txt"),
    `${manifestNames.map((name) => `${digest(readFileSync(join(releaseDir, name)))}  ${name}`).join("\n")}\n`,
    "utf8",
  );
  const remoteNames = [...manifestNames, "SHA256SUMS.txt"].sort();
  return {
    notesEn,
    notesZh,
    remoteAssets: remoteNames.map((name) => ({
      digest: `sha256:${digest(readFileSync(join(releaseDir, name)))}`,
      name,
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
  const remoteAssets = staged.remoteAssets.map((asset, index) => (
    failAt === "digest" && index === 0 ? { ...asset, digest: `sha256:${"0".repeat(64)}` } : asset
  ));
  writeFileSync(
    releaseJsonPath,
    JSON.stringify({
      assets: remoteAssets,
      body: `${english}\n\n---\n\n${chinese}`,
      draft: false,
      immutable: failAt !== "immutable",
      prerelease: true,
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
      "if [[ \"$1\" == api && \"${joined}\" == *\"--paginate\"* ]]; then",
      "  echo LIST >> \"${MOCK_LOG}\"",
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
      "if [[ \"$1\" == api && \"${joined}\" == *\"/releases/latest\"* ]]; then",
      "  echo LATEST >> \"${MOCK_LOG}\"",
      "  [[ \"${MOCK_FAIL_AT}\" != latest ]] && echo v0.0.9 || echo v0.1.0-alpha.1",
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
        EXPECTED_TAG_OBJECT: "b".repeat(40),
        GH_CLI: shellPath(ghPath),
        GITHUB_REPOSITORY: "EarendelArc/tachyon-prism",
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
    expect(run.log.slice(0, 4)).toEqual(["LIST", "VERIFY", "POST", "UPLOAD"]);
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
    ["latest", "unexpectedly became GitHub latest"],
    ["target", "target_commitish"],
  ] as const)("fails closed for a mismatched published %s", (failure, message) => {
    const run = runPublication(failure);

    expect(run.result.status).not.toBe(0);
    expect(run.log.some((line) => line.startsWith("DELETE "))).toBe(false);
    expect(run.state).toBe("published");
    expect(run.result.stdout).toContain(message);
  });

  it("publishes and verifies the exact remote release state", () => {
    const run = runPublication("none");

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.log).toEqual([
      "LIST",
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

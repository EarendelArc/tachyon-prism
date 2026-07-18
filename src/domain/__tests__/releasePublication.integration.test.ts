import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const publishScript = fileURLToPath(
  new URL("../../../.github/scripts/publish-release.sh", import.meta.url),
);
const tempDirs: string[] = [];
const bashBinary = process.env.BASH_BINARY?.trim()
  || (process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash");

const shellPath = (path: string) => path.split("\\").join("/");

function executable(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function runPublication(failAt: "none" | "patch-draft" | "patch-published" | "upload") {
  const root = mkdtempSync(join(tmpdir(), "prism-release-publication-"));
  tempDirs.push(root);
  const releaseDir = join(root, "release");
  const notesPath = join(releaseDir, "RELEASE_NOTES.md");
  const logPath = join(root, "calls.log");
  const statePath = join(root, "release.state");
  const ghPath = join(root, "mock-gh.sh");
  const verifyPath = join(root, "mock-verify.sh");
  mkdirSync(releaseDir);
  writeFileSync(notesPath, "release notes\n", "utf8");
  writeFileSync(join(releaseDir, "asset.bin"), "asset payload\n", "utf8");
  executable(
    verifyPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "echo VERIFY >> \"${MOCK_LOG}\"",
      "exit 0",
      "",
    ].join("\n"),
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
      "if [[ \"$1\" == api && \"${joined}\" == *\"--method DELETE\"* ]]; then",
      "  echo \"DELETE ${joined}\" >> \"${MOCK_LOG}\"",
      "  echo deleted > \"${MOCK_STATE}\"",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == api && \"${joined}\" == *\"/releases/4242\"* ]]; then",
      "  echo \"GET ${joined}\" >> \"${MOCK_LOG}\"",
      "  state=$(<\"${MOCK_STATE}\")",
      "  draft=true",
      "  [[ \"${state}\" != published ]] || draft=false",
      "  printf '4242\\t%s\\tv0.1.0-alpha.1\\n' \"${draft}\"",
      "  exit 0",
      "fi",
      "echo \"unexpected gh call: ${joined}\" >&2",
      "exit 99",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    bashBinary,
    [shellPath(publishScript), shellPath(notesPath), shellPath(releaseDir)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COMMIT: "a".repeat(40),
        EXPECTED_TAG_OBJECT: "b".repeat(40),
        GH_CLI: shellPath(ghPath),
        GITHUB_REPOSITORY: "tachyon-space/tachyon-prism",
        MOCK_FAIL_AT: failAt,
        MOCK_LOG: shellPath(logPath),
        MOCK_STATE: shellPath(statePath),
        PRERELEASE: "true",
        TAG_VERIFY_SCRIPT: shellPath(verifyPath),
        VERSION: "v0.1.0-alpha.1",
      },
    },
  );
  return {
    log: readFileSync(logPath, "utf8").trim().split(/\r?\n/),
    result,
    state: readFileSync(statePath, "utf8").trim(),
  };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("release publication transaction", () => {
  it("cleans only its draft release ID when upload fails", () => {
    const run = runPublication("upload");

    expect(run.result.status).not.toBe(0);
    expect(run.log.slice(0, 4)).toEqual(["LIST", "VERIFY", "POST", "UPLOAD"]);
    expect(run.log).toContainEqual(expect.stringContaining("GET api repos/tachyon-space/tachyon-prism/releases/4242"));
    expect(run.log).toContainEqual(expect.stringContaining("DELETE api --method DELETE repos/tachyon-space/tachyon-prism/releases/4242"));
    expect(run.state).toBe("deleted");
  });

  it("cleans its still-draft release ID when publish PATCH fails", () => {
    const run = runPublication("patch-draft");

    expect(run.result.status).not.toBe(0);
    expect(run.log.slice(0, 3)).toEqual(["LIST", "VERIFY", "POST"]);
    expect(run.log).toContain("PATCH");
    expect(run.log).toContainEqual(expect.stringContaining("DELETE api --method DELETE repos/tachyon-space/tachyon-prism/releases/4242"));
    expect(run.state).toBe("deleted");
  });

  it("never deletes a release that became official before PATCH reported failure", () => {
    const run = runPublication("patch-published");

    expect(run.result.status).not.toBe(0);
    expect(run.log).toContain("PATCH");
    expect(run.log).toContainEqual(expect.stringContaining("GET api repos/tachyon-space/tachyon-prism/releases/4242"));
    expect(run.log.some((line) => line.startsWith("DELETE "))).toBe(false);
    expect(run.state).toBe("published");
    expect(run.result.stderr).toContain("refusing deletion");
  });

  it("publishes successfully without running cleanup", () => {
    const run = runPublication("none");

    expect(run.result.status).toBe(0);
    expect(run.log).toEqual(["LIST", "VERIFY", "POST", "UPLOAD", "PATCH"]);
    expect(run.state).toBe("published");
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const verifyScript = fileURLToPath(
  new URL("../../../.github/scripts/verify-release-tag.sh", import.meta.url),
);
const bashBinary = process.env.BASH_BINARY?.trim()
  || (process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash");
const tempDirs: string[] = [];
const shellPath = (path: string) => path.split("\\").join("/");

function repository(tagKind: "annotated" | "lightweight") {
  const root = mkdtempSync(join(tmpdir(), "prism-release-tag-"));
  tempDirs.push(root);
  const remote = join(root, "remote.git");
  const local = join(root, "local");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", local]);
  execFileSync("git", ["config", "user.name", "Prism Release Test"], { cwd: local });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: local });
  writeFileSync(join(local, "payload.txt"), "release\n", "utf8");
  execFileSync("git", ["add", "payload.txt"], { cwd: local });
  execFileSync("git", ["commit", "-m", "release fixture"], { cwd: local });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: local, encoding: "utf8" }).trim();
  const tag = tagKind === "annotated" ? "v0.1.0-alpha.2" : "v0.1.0-alpha.1";
  execFileSync("git", tagKind === "annotated"
    ? ["tag", "-a", tag, "-m", "annotated release"]
    : ["tag", tag], { cwd: local });
  writeFileSync(join(local, "payload.txt"), "next\n", "utf8");
  execFileSync("git", ["add", "payload.txt"], { cwd: local });
  execFileSync("git", ["commit", "-m", "next fixture"], { cwd: local });
  const wrongCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: local,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: local });
  execFileSync("git", ["push", "origin", `refs/tags/${tag}`], { cwd: local });
  const tagObject = execFileSync("git", ["rev-parse", `refs/tags/${tag}`], {
    cwd: local,
    encoding: "utf8",
  }).trim();
  return { commit, local, tag, tagObject, wrongCommit };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("release tag verification", () => {
  it("rejects a lightweight release tag", () => {
    const fixture = repository("lightweight");
    const result = spawnSync(
      bashBinary,
      [shellPath(verifyScript), fixture.tag, fixture.commit, "origin", fixture.tagObject],
      { cwd: fixture.local, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be an annotated tag object");
  });

  it("rejects an unsigned annotated tag even with exact object and peeled commit", () => {
    const fixture = repository("annotated");
    const result = spawnSync(
      bashBinary,
      [shellPath(verifyScript), fixture.tag, fixture.commit, "origin", fixture.tagObject],
      { cwd: fixture.local, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cryptographically valid signature");
  });

  it("rejects an annotated tag that peels to the wrong commit", () => {
    const fixture = repository("annotated");
    const result = spawnSync(
      bashBinary,
      [shellPath(verifyScript), fixture.tag, fixture.wrongCommit, "origin", fixture.tagObject],
      { cwd: fixture.local, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("points to");
  });

  it("rejects a moved tag object", () => {
    const fixture = repository("annotated");
    const result = spawnSync(
      bashBinary,
      [shellPath(verifyScript), fixture.tag, fixture.commit, "origin", "c".repeat(40)],
      { cwd: fixture.local, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("object changed");
  });
});

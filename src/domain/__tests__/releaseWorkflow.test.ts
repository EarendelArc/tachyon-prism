import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
);

const readReleaseWorkflow = () => readFileSync(releaseWorkflowPath, "utf8");

const getReleaseBaseCommand = (workflow: string) => {
  const match = workflow.match(/release_base="\$\((?<command>.+)\)"/);
  if (!match?.groups?.command) {
    throw new Error("release_base command not found");
  }
  return match.groups.command;
};

const normalizeWithReleaseBaseCommand = (command: string, base: string) => {
  const source = command.match(/^(?<source>printf '%s'|echo)\s+"\$\{base\}"\s+\|\s+tr '(?<from>[^']+)' '(?<to>[^']+)'$/);
  if (!source?.groups) {
    throw new Error(`unsupported release_base command: ${command}`);
  }

  const input = source.groups.source === "echo" ? `${base}\n` : base;
  const from = source.groups.from === "\\t" ? "\t" : source.groups.from.replace("\\t", "\t");
  const to = source.groups.to;

  return Array.from(input, (character) => {
    const index = from.indexOf(character);
    return index === -1 ? character : to[Math.min(index, to.length - 1)];
  }).join("");
};

const getReleaseChecksumCommands = (workflow: string) => {
  const match = workflow.match(/\(cd release && (?<commands>.+)\)/);
  if (!match?.groups?.commands) {
    throw new Error("release checksum commands not found");
  }
  return match.groups.commands.split("&&").map((command) => command.trim());
};

describe("release workflow checksum assets", () => {
  it("normalizes bundled asset names without introducing a trailing dot", () => {
    const workflow = readReleaseWorkflow();
    const command = getReleaseBaseCommand(workflow);

    const normalized = normalizeWithReleaseBaseCommand(
      command,
      "Tachyon Prism_0.1.0_x64-setup.exe",
    );

    expect(normalized).toBe("Tachyon.Prism_0.1.0_x64-setup.exe");
    expect(normalized).not.toMatch(/\.$/);
    expect(`release/tachyon-prism-windows-x64_${normalized}`).not.toContain(".exe.");
  });

  it("verifies generated release checksums before upload", () => {
    const workflow = readReleaseWorkflow();
    const commands = getReleaseChecksumCommands(workflow);

    expect(commands).toEqual([
      "sha256sum * > SHA256SUMS.txt",
      "sha256sum --check SHA256SUMS.txt",
    ]);
  });

  it("includes release notes in generated checksums", () => {
    const workflow = readReleaseWorkflow();
    const notesIndex = workflow.indexOf("} > release/RELEASE_NOTES.md");
    const checksumsIndex = workflow.indexOf("(cd release && sha256sum * > SHA256SUMS.txt");

    expect(notesIndex).toBeGreaterThan(-1);
    expect(checksumsIndex).toBeGreaterThan(-1);
    expect(notesIndex).toBeLessThan(checksumsIndex);
    expect(workflow).toContain("gh release upload \"${VERSION}\" release/* --clobber");
  });

  it("publishes alpha release limitations in GitHub release notes", () => {
    const workflow = readReleaseWorkflow();

    expect(workflow).toContain("This is an alpha Tachyon Prism desktop release.");
    expect(workflow).toContain("System proxy one-click takeover is disabled by default.");
    expect(workflow).toContain("Tachyon TUN one-click takeover is disabled by default.");
    expect(workflow).toContain(
      "Real VPS, real client, and real game UDP acceleration paths still need field testing.",
    );
    expect(workflow).toContain("Bundles are unsigned and not notarized");
  });
});

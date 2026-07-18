import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
);
const ciWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
);
const coreContractPath = fileURLToPath(
  new URL("../../../core-contract.json", import.meta.url),
);
const publicationScriptPath = fileURLToPath(
  new URL("../../../.github/scripts/publish-release.sh", import.meta.url),
);

const readReleaseWorkflow = () => readFileSync(releaseWorkflowPath, "utf8");
const readPublicationScript = () => readFileSync(publicationScriptPath, "utf8");

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
    const publication = readPublicationScript();
    expect(publication).toContain('"${gh_cli}" release upload "${VERSION}" "${release_dir}"/*');
    expect(publication).not.toContain("--clobber");
  });

  it("uses generated release notes when creating the draft through the GitHub API", () => {
    const publication = readPublicationScript();

    expect(publication).toContain('"${gh_cli}" api --method POST');
    expect(publication).toContain('-f body="$(<"${release_notes}")"');
    expect(publication).toContain("-F draft=true");
    expect(publication).not.toContain("gh release edit");
    expect(publication).not.toContain("--clobber");
  });

  it("publishes alpha release limitations in GitHub release notes", () => {
    const workflow = readReleaseWorkflow();

    expect(workflow).toContain("This is an alpha Tachyon Prism desktop release.");
    expect(workflow).toContain("It is not stable or complete yet.");
    expect(workflow).toContain("System proxy one-click takeover is disabled by default.");
    expect(workflow).toContain("Tachyon TUN one-click takeover is disabled by default.");
    expect(workflow).toContain(
      "Real VPS, real client, and real game UDP acceleration paths still need field testing.",
    );
    expect(workflow).toContain("Bundles are unsigned and not notarized");
  });

  it("pins every downstream release job to the verified tag commit", () => {
    const workflow = readReleaseWorkflow();
    const publication = readPublicationScript();

    expect(workflow).toContain("Verify remote tag object and peeled commit");
    expect(workflow).toContain("EXPECTED_TAG_OBJECT: ${{ needs.prepare.outputs.tag_object }}");
    expect(workflow.match(/ref: \$\{\{ needs\.prepare\.outputs\.commit \}\}/g)).toHaveLength(3);
    expect(workflow.match(/bash \.github\/scripts\/verify-release-tag\.sh/g)).toHaveLength(1);
    expect(publication).toContain('bash "${tag_verify_script}" "${VERSION}" "${COMMIT}" origin "${EXPECTED_TAG_OBJECT}"');
    expect(publication.indexOf('bash "${tag_verify_script}"')).toBeLessThan(
      publication.indexOf('release_id=$("${gh_cli}" api --method POST'),
    );
  });

  it("uses same-tag concurrency and a fail-on-existing draft publication transaction", () => {
    const workflow = readReleaseWorkflow();
    const publication = readPublicationScript();

    expect(workflow).toContain("group: prism-release-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}");
    expect(workflow).toContain("bash .github/scripts/publish-release.sh");
    expect(publication).toContain("release ${VERSION} already exists");
    expect(publication).toContain("trap 'cleanup_failed_draft $?' EXIT");
    expect(publication.match(/release upload/g)).toHaveLength(1);
    expect(publication).toContain('"${gh_cli}" api --method PATCH');
    expect(publication).toContain('"${gh_cli}" api --method DELETE');
    expect(publication).toContain('"${current_draft}" != "true"');
  });

  it("records reproducible Prism and Core source metadata", () => {
    const workflow = readReleaseWorkflow();

    expect(workflow).toContain("SOURCE_DATE_EPOCH: ${{ needs.prepare.outputs.source_date_epoch }}");
    expect(workflow).toContain("BUILD_METADATA.json");
    expect(workflow).toContain('"coreContract": core');
    expect(workflow).toContain('"sourceDateEpoch": int(os.environ["SOURCE_DATE_EPOCH"])');
    expect(workflow).toContain('"installerByteReproducibilityGuaranteed": False');
    expect(workflow).toContain('"stagedAssetTimestampsNormalized": True');
    expect(workflow).toContain(
      'python .github/scripts/normalize-release-timestamps.py release "${SOURCE_DATE_EPOCH}"',
    );
  });

  it("checks out the exact Core release pin in CI and Release", () => {
    const contract = JSON.parse(readFileSync(coreContractPath, "utf8")) as {
      commit: string;
      repository: string;
      tag: string;
    };
    const workflows = [readFileSync(ciWorkflowPath, "utf8"), readReleaseWorkflow()];

    expect(contract.tag).toBe("v0.1.0-alpha.19");
    expect(contract.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const workflow of workflows) {
      expect(workflow).toContain(`repository: ${contract.repository}`);
      expect(workflow).toContain(`ref: ${contract.commit}`);
      expect(workflow).toContain("fetch-depth: 0");
      expect(workflow).toContain("npm run test:core-contract");
    }
  });
});

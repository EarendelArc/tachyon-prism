#!/usr/bin/env python3
"""Validate Prism's release tag, version, and CI/release workflow contract."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_CORE = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
STABLE_TAG = re.compile(rf"^v({VERSION_CORE})$")
PRERELEASE_TAG = re.compile(
    rf"^v({VERSION_CORE})-(?:alpha|beta|rc|pre|preview)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*$"
)

EXPECTED_MATRIX = [
    {
        "asset_name": "windows-x64",
        "os": "windows-latest",
        "rust_target": "x86_64-pc-windows-msvc",
        "bundle_args": "--bundles nsis,msi",
        "signing_kind": "windows",
    },
    {
        "asset_name": "windows-arm64",
        "os": "windows-11-arm",
        "rust_target": "aarch64-pc-windows-msvc",
        "bundle_args": "--bundles nsis",
        "signing_kind": "windows",
    },
    {
        "asset_name": "macos-x64",
        "os": "macos-15-intel",
        "rust_target": "x86_64-apple-darwin",
        "bundle_args": "--bundles dmg",
        "signing_kind": "macos",
    },
    {
        "asset_name": "macos-arm64",
        "os": "macos-15",
        "rust_target": "aarch64-apple-darwin",
        "bundle_args": "--bundles dmg",
        "signing_kind": "macos",
    },
    {
        "asset_name": "linux-x64",
        "os": "ubuntu-22.04",
        "rust_target": "x86_64-unknown-linux-gnu",
        "bundle_args": "--bundles deb",
        "signing_kind": "none",
    },
    {
        "asset_name": "linux-arm64",
        "os": "ubuntu-24.04-arm",
        "rust_target": "aarch64-unknown-linux-gnu",
        "bundle_args": "--bundles deb",
        "signing_kind": "none",
    },
]


def fail(message: str) -> None:
    raise ValueError(message)


def classify_tag(tag: str) -> tuple[str, str]:
    stable = STABLE_TAG.fullmatch(tag)
    if stable:
        return "stable", stable.group(1)
    prerelease = PRERELEASE_TAG.fullmatch(tag)
    if prerelease:
        return "prerelease", prerelease.group(1)
    fail(
        "invalid release tag; use vMAJOR.MINOR.PATCH for stable or "
        "vMAJOR.MINOR.PATCH-(alpha|beta|rc|pre|preview)[.N] for prerelease"
    )


def project_versions() -> dict[str, str]:
    tauri = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    cargo_text = (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    package_block = cargo_text.split("[package]", 1)[1].split("[", 1)[0]
    cargo_match = re.search(r'^version\s*=\s*"([^"]+)"', package_block, re.MULTILINE)
    if not cargo_match:
        fail("src-tauri/Cargo.toml [package] version is missing")
    return {
        "package.json": str(package["version"]),
        "src-tauri/Cargo.toml": cargo_match.group(1),
        "src-tauri/tauri.conf.json": str(tauri["version"]),
    }


def validate_versions(expected: str | None = None) -> None:
    versions = project_versions()
    distinct = set(versions.values())
    if len(distinct) != 1:
        fail("project versions disagree: " + ", ".join(f"{path}={value}" for path, value in versions.items()))
    actual = next(iter(distinct))
    if expected is not None and actual != expected:
        fail(f"release tag version {expected} does not match project version {actual}")


def extract_matrix(path: Path, job_name: str) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8")
    job_match = re.search(rf"(?ms)^  {re.escape(job_name)}:\s*$\n(.*?)(?=^  [A-Za-z0-9_-]+:\s*$|\Z)", text)
    if not job_match:
        fail(f"{path.relative_to(ROOT)} has no {job_name!r} job")
    entries: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in job_match.group(1).splitlines():
        start = re.match(r"^          - asset_name:\s*(.+?)\s*$", line)
        if start:
            if current is not None:
                entries.append(current)
            current = {"asset_name": start.group(1).strip('"\'')}
            continue
        field = re.match(r"^            (os|rust_target|bundle_args|signing_kind):\s*(.+?)\s*$", line)
        if current is not None and field:
            current[field.group(1)] = field.group(2).strip('"\'')
    if current is not None:
        entries.append(current)
    return entries


def validate_workflows() -> None:
    release_path = ROOT / ".github" / "workflows" / "release.yml"
    ci_path = ROOT / ".github" / "workflows" / "ci.yml"
    publication_path = ROOT / ".github" / "scripts" / "publish-release.sh"
    tag_verification_path = ROOT / ".github" / "scripts" / "verify-release-tag.sh"
    published_verification_path = ROOT / ".github" / "scripts" / "verify-published-release.py"
    governance_verification_path = ROOT / ".github" / "scripts" / "verify-release-governance.py"
    latest_response_parser_path = ROOT / ".github" / "scripts" / "parse-latest-release-response.py"
    core_contract_test_path = ROOT / "src" / "domain" / "__tests__" / "coreConfigContract.live.test.ts"
    package_path = ROOT / "package.json"
    tauri_config_path = ROOT / "src-tauri" / "tauri.conf.json"
    bundle_verifier_path = ROOT / "scripts" / "verify_production_bundle.py"
    release_matrix = extract_matrix(release_path, "build")
    ci_matrix = extract_matrix(ci_path, "rust")
    if release_matrix != EXPECTED_MATRIX:
        fail(f"release matrix drifted from contract: {release_matrix!r}")
    if ci_matrix != EXPECTED_MATRIX:
        fail(f"CI matrix drifted from release contract: {ci_matrix!r}")

    release = release_path.read_text(encoding="utf-8")
    ci = ci_path.read_text(encoding="utf-8")
    publication = publication_path.read_text(encoding="utf-8")
    tag_verification = tag_verification_path.read_text(encoding="utf-8")
    published_verification = published_verification_path.read_text(encoding="utf-8")
    governance_verification = governance_verification_path.read_text(encoding="utf-8")
    latest_response_parser = latest_response_parser_path.read_text(encoding="utf-8")
    core_contract_test = core_contract_test_path.read_text(encoding="utf-8")
    package = json.loads(package_path.read_text(encoding="utf-8"))
    tauri_config = json.loads(tauri_config_path.read_text(encoding="utf-8"))
    bundle_verifier = bundle_verifier_path.read_text(encoding="utf-8")
    core_contract = json.loads((ROOT / "core-contract.json").read_text(encoding="utf-8"))
    core_repository = str(core_contract["repository"])
    core_commit = str(core_contract["commit"])
    core_tag = str(core_contract["tag"])
    core_tag_object = str(core_contract["tag_object"])
    if core_repository != "EarendelArc/tachyon-core":
        fail(f"core-contract.json repository must be EarendelArc/tachyon-core, found {core_repository}")
    obsolete_core_owner = "tachyon-space" + "/tachyon-core"
    scan_roots = [ROOT / ".github", ROOT / "docs", ROOT / "scripts", ROOT / "src"]
    stale_owner_paths = []
    for scan_root in scan_roots:
        for path in scan_root.rglob("*"):
            if not path.is_file() or "node_modules" in path.parts or "__pycache__" in path.parts:
                continue
            try:
                if obsolete_core_owner in path.read_text(encoding="utf-8"):
                    stale_owner_paths.append(str(path.relative_to(ROOT)))
            except UnicodeDecodeError:
                continue
    if stale_owner_paths:
        fail("obsolete Core repository owner remains in: " + ", ".join(sorted(stale_owner_paths)))
    if not re.fullmatch(r"[0-9a-f]{40}", core_commit):
        fail("core-contract.json commit must be a full lowercase SHA-1")
    if not re.fullmatch(r"[0-9a-f]{40}", core_tag_object):
        fail("core-contract.json tag_object must be a full lowercase SHA-1")
    if not re.fullmatch(r"v[0-9A-Za-z][0-9A-Za-z._-]*", core_tag):
        fail("core-contract.json tag is invalid")

    required_fragments = [
        "python scripts/validate_release.py --check-workflows",
        "--signing-kind ${{ matrix.signing_kind }}",
        "Verify bundle payload exists",
        "tsp = $true",
        "if-no-files-found: error",
        "Verify remote tag object and peeled commit",
        "EXPECTED_TAG_OBJECT: ${{ needs.prepare.outputs.tag_object }}",
        "ref: ${{ needs.prepare.outputs.commit }}",
        "group: prism-release-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
        "release/RELEASE_NOTES.zh-CN.md",
        "bash .github/scripts/publish-release.sh",
        "release payload must contain exactly 7 installers",
        "verify-published-release.py",
        'python .github/scripts/normalize-release-timestamps.py release "${SOURCE_DATE_EPOCH}"',
        "BUILD_METADATA.json",
        '"schemaVersion": 1',
        '"artifactDigests": artifact_digests',
        '"installerByteReproducibilityGuaranteed": False',
        '"stagedAssetTimestampsNormalized": True',
        "SOURCE_DATE_EPOCH: ${{ needs.prepare.outputs.source_date_epoch }}",
        "EXPECTED_SOURCE_DATE_EPOCH: ${{ needs.prepare.outputs.source_date_epoch }}",
        "EXPECTED_TAG_VERIFICATION: ${{ needs.prepare.outputs.verification }}",
        "EXPECTED_REPRODUCIBILITY_JSON:",
        'export EXPECTED_TOOLS_JSON="$(python -c',
        "GOVERNANCE_TOKEN: ${{ secrets.RELEASE_GOVERNANCE_TOKEN }}",
        "SHA256SUMS.txt",
        "SIGNING_STATUS",
    ]
    missing = [fragment for fragment in required_fragments if fragment not in release]
    if missing:
        fail("release workflow is missing contract guards: " + ", ".join(missing))
    bundle_scan_command = "python scripts/verify_production_bundle.py --dist dist"
    if bundle_scan_command not in ci:
        fail("CI does not explicitly scan the production renderer bundle")
    if bundle_scan_command not in release:
        fail("release builds do not scan the production renderer bundle")
    if "python scripts/verify_production_bundle.py --self-test" not in ci:
        fail("CI does not exercise the production bundle scanner's negative fixtures")
    if "python scripts/verify_production_bundle.py --self-test" not in release:
        fail("release preparation does not exercise the production bundle scanner")
    web_build = str(package.get("scripts", {}).get("web:build", ""))
    if "npm run verify:production-bundle" not in web_build:
        fail("web:build does not fail closed on the production bundle scan")
    if tauri_config.get("build", {}).get("beforeBuildCommand") != "npm run web:build":
        fail("Tauri release builds bypass the production bundle scan")
    scanner_guards = [
        "tachyon.prism.uiSmokeVault.v1",
        "secureStorageBackend.ui-smoke",
        "uiSmokeLoad",
        "uiSmokeSave",
        "uiSmokeMigrate",
    ]
    missing_scanner_guards = [guard for guard in scanner_guards if guard not in bundle_verifier]
    if missing_scanner_guards:
        fail("production bundle scanner is missing guards: " + ", ".join(missing_scanner_guards))
    publication_fragments = [
        "trap 'cleanup_failed_draft $?' EXIT",
        'bash "${tag_verify_script}" "${VERSION}" "${COMMIT}" origin "${EXPECTED_TAG_OBJECT}"',
        '[[ -s "${release_notes_zh}" ]]',
        'release_id=$("${gh_cli}" api --method POST',
        '-F draft=true',
        '"${gh_cli}" release upload "${VERSION}" "${release_dir}"/*',
        '"${gh_cli}" api --method PATCH',
        '"${gh_cli}" api --method DELETE',
        '"${current_draft}" != "true"',
        '"repos/${GITHUB_REPOSITORY}/releases/latest"',
        '"repos/${GITHUB_REPOSITORY}/immutable-releases"',
        '"repos/${GITHUB_REPOSITORY}/rulesets?includes_parents=false&per_page=100"',
        'python "${governance_verify_script}"',
        '"${gh_cli}" api --include',
        'python "${latest_response_parser}"',
        '--release-json "${readback_file}"',
        '--latest-tag "${latest_tag}"',
        '--expected-tag-object "${EXPECTED_TAG_OBJECT}"',
        '--expected-source-date-epoch "${EXPECTED_SOURCE_DATE_EPOCH}"',
        '--expected-tag-verification "${EXPECTED_TAG_VERIFICATION}"',
        '--expected-reproducibility-json "${EXPECTED_REPRODUCIBILITY_JSON}"',
        '--expected-tools-json "${EXPECTED_TOOLS_JSON}"',
        "release ${VERSION} already exists",
    ]
    missing_publication = [fragment for fragment in publication_fragments if fragment not in publication]
    if missing_publication:
        fail("publication script is missing transaction guards: " + ", ".join(missing_publication))
    governance_index = publication.index('python "${governance_verify_script}"')
    verify_index = publication.index('bash "${tag_verify_script}"')
    create_index = publication.index('release_id=$("${gh_cli}" api --method POST')
    if not governance_index < verify_index < create_index:
        fail("governance and final tag verification must immediately precede draft creation")

    forbidden = ['gh release edit', '--clobber']
    present = [fragment for fragment in forbidden if fragment in release or fragment in publication]
    if present:
        fail("release workflow contains replace-in-place operations: " + ", ".join(present))
    if release.count("ref: ${{ needs.prepare.outputs.commit }}") != 4:
        fail("release jobs are not all pinned to the verified Prism commit")
    if publication.count('release upload "${VERSION}" "${release_dir}"/*') != 1:
        fail("release assets must be uploaded exactly once")
    if '[[ "${tag_type}" == "tag" ]]' not in tag_verification:
        fail("release tag verification must require an annotated tag object")
    if '[[ "${tag_type}" == "commit" ]]' in tag_verification:
        fail("release tag verification still accepts lightweight tags")
    published_guards = [
        '"immutable": True',
        'len(names) != 11',
        'len(installers) != 7',
        'len(manifest) != 10',
        'latest_tag == tag',
        'remote[name] != expected_digest',
        'set(metadata) != {',
        'prism.get("tagObject") != expected_tag_object',
        'prism.get("sourceDateEpoch") != expected_source_date_epoch',
        'metadata.get("reproducibility") != expected_reproducibility',
        'metadata.get("tools") != expected_tools',
    ]
    missing_published = [guard for guard in published_guards if guard not in published_verification]
    if missing_published:
        fail("published release verification is missing guards: " + ", ".join(missing_published))
    governance_guards = [
        'REQUIRED_RULE_TYPES = {"deletion", "non_fast_forward", "update"}',
        'RELEASE_TAG_PATTERN = "refs/tags/v*"',
        'ruleset.get("target") != "tag"',
        'ruleset.get("enforcement") != "active"',
        'if not isinstance(bypass_actors, list) or bypass_actors:',
        'immutable.get("enabled") is not True',
    ]
    missing_governance = [guard for guard in governance_guards if guard not in governance_verification]
    if missing_governance:
        fail("release governance verification is missing guards: " + ", ".join(missing_governance))
    latest_guards = [
        "if status == 404:",
        "if status != 200:",
        "if command_status != 0:",
        'payload.get("tag_name")',
    ]
    missing_latest = [guard for guard in latest_guards if guard not in latest_response_parser]
    if missing_latest:
        fail("Latest response parser is missing fail-closed guards: " + ", ".join(missing_latest))
    windows_contract_tests = [
        "TestParseGameRoutePrefixesNormalizesHostBits",
        "TestPlanSelectiveRoutesNormalizesAndDeduplicates",
        "TestWindowsRouteRowsRequireExactIdentityAndAttributes",
        "TestInstallRouteTransactionRollsBackInReverseOrder",
        "TestWindowsRouteJournalRecordFailureRollsBackCreatedRouteUnderLock",
    ]
    missing_windows_tests = [name for name in windows_contract_tests if name not in core_contract_test]
    if missing_windows_tests:
        fail("Windows Core contract is missing tests: " + ", ".join(missing_windows_tests))
    for fragment in ('event.Action === "run"', 'event.Action === "pass"', '["fail", "skip"]'):
        if fragment not in core_contract_test:
            fail(f"Windows Core JSON event proof is missing {fragment!r}")

    core_fragments = [
        f"repository: {core_repository}",
        f"ref: {core_commit}",
        "path: tachyon-core",
        "fetch-depth: 0",
        "npm run test:core-contract",
        "python .github/scripts/verify-core-contract.py tachyon-core",
    ]
    for workflow_name, workflow in (("CI", ci), ("release", release)):
        missing_core = [fragment for fragment in core_fragments if fragment not in workflow]
        if missing_core:
            fail(f"{workflow_name} workflow is missing pinned Core contract: {missing_core!r}")


def write_outputs(path: Path, tag: str, channel: str) -> None:
    prerelease = "true" if channel == "prerelease" else "false"
    with path.open("a", encoding="utf-8", newline="\n") as output:
        output.write(f"tag={tag}\nchannel={channel}\nprerelease={prerelease}\n")


SIGNING_VARIABLES = {
    "windows": ("WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD", "WINDOWS_TIMESTAMP_URL"),
    "macos": (
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_API_ISSUER",
        "APPLE_API_KEY",
        "APPLE_API_PRIVATE_KEY",
    ),
}


def signing_policy(kind: str, channel: str) -> tuple[bool, str]:
    if kind == "none":
        return False, "not-applicable-unsigned"
    names = SIGNING_VARIABLES[kind]
    present = [name for name in names if os.environ.get(name)]
    if len(present) == len(names):
        status = "signed-and-notarized" if kind == "macos" else "authenticode-signed"
        return True, status
    if not present and channel == "prerelease":
        return False, "unsigned-no-credentials"
    missing = sorted(set(names) - set(present))
    fail(
        f"{kind} signing credentials are incomplete, or stable signing credentials are absent; "
        f"missing: {', '.join(missing)}"
    )


def write_signing_env(path: Path, enabled: bool, status: str) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as output:
        output.write(f"SIGNING_ENABLED={'true' if enabled else 'false'}\nSIGNING_STATUS={status}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-workflows", action="store_true")
    parser.add_argument("--tag")
    parser.add_argument("--channel", choices=("auto", "stable", "prerelease"), default="auto")
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--signing-kind", choices=("none", "windows", "macos"))
    parser.add_argument("--release-channel", choices=("stable", "prerelease"))
    parser.add_argument("--github-env", type=Path)
    args = parser.parse_args()

    try:
        validate_versions()
        if args.check_workflows:
            validate_workflows()
        if args.tag:
            actual_channel, version = classify_tag(args.tag)
            if args.channel != "auto" and args.channel != actual_channel:
                fail(f"tag {args.tag} is {actual_channel}, but workflow requested {args.channel}")
            validate_versions(version)
            if args.github_output:
                write_outputs(args.github_output, args.tag, actual_channel)
            print(f"release tag valid: tag={args.tag} channel={actual_channel} version={version}")
        elif args.channel != "auto" or args.github_output:
            fail("--tag is required with --channel or --github-output")
        if args.signing_kind:
            if not args.release_channel or not args.github_env:
                fail("--signing-kind requires --release-channel and --github-env")
            enabled, status = signing_policy(args.signing_kind, args.release_channel)
            write_signing_env(args.github_env, enabled, status)
            if status == "unsigned-no-credentials":
                print(f"::warning::Publishing an explicitly unsigned prerelease {args.signing_kind} artifact")
            print(f"signing policy valid: kind={args.signing_kind} status={status}")
        elif args.release_channel or args.github_env:
            fail("--release-channel and --github-env require --signing-kind")
        if args.check_workflows:
            print("release workflow contract valid: 6 targets, CI/release matrices match")
    except (KeyError, IndexError, json.JSONDecodeError, OSError, ValueError) as error:
        print(f"release validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

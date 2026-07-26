#!/usr/bin/env python3
"""Fail-closed validation for staged and published Prism release assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


AUXILIARY_ASSETS = {
    "BUILD_METADATA.json",
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.zh-CN.md",
    "SHA256SUMS.txt",
}
INSTALLER_LAYOUT = {
    "tachyon-prism-windows-x64_": {".exe", ".msi"},
    "tachyon-prism-windows-arm64_": {".exe"},
    "tachyon-prism-macos-x64_": {".dmg"},
    "tachyon-prism-macos-arm64_": {".dmg"},
    "tachyon-prism-linux-x64_": {".deb"},
    "tachyon-prism-linux-arm64_": {".deb"},
}
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
FULL_OBJECT_ID = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")


def fail(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installer_names(names: set[str]) -> set[str]:
    installers = names - AUXILIARY_ASSETS
    if len(installers) != 7:
        fail(f"release must contain exactly 7 installers, found {len(installers)}")
    unmatched = set(installers)
    for prefix, suffixes in INSTALLER_LAYOUT.items():
        matched = {name for name in installers if name.startswith(prefix)}
        actual_suffixes = {Path(name).suffix.lower() for name in matched}
        if actual_suffixes != suffixes or len(matched) != len(suffixes):
            fail(
                f"installer layout for {prefix} must be {sorted(suffixes)}, "
                f"found {sorted(matched)}"
            )
        unmatched -= matched
    if unmatched:
        fail(f"unexpected installer assets: {sorted(unmatched)}")
    return installers


def parse_manifest(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\]+)", line)
        if not match:
            fail(f"invalid SHA256SUMS.txt line {line_number}: {line!r}")
        digest, name = match.groups()
        if name in entries:
            fail(f"duplicate manifest entry: {name}")
        entries[name] = digest
    return entries


def validate_metadata(
    path: Path,
    installers: set[str],
    local_digests: dict[str, str],
    tag: str,
    commit: str,
    core_contract_path: Path,
    expected_tag_object: str,
    expected_source_date_epoch: int,
    expected_tag_verification: str,
    expected_reproducibility: dict[str, object],
    expected_tools: dict[str, object],
) -> None:
    metadata = json.loads(path.read_text(encoding="utf-8"))
    core = json.loads(core_contract_path.read_text(encoding="utf-8"))
    if set(metadata) != {
        "artifactDigests",
        "coreContract",
        "prism",
        "reproducibility",
        "schemaVersion",
        "tools",
    }:
        fail("BUILD_METADATA.json must contain the exact schemaVersion 1 top-level fields")
    if metadata.get("schemaVersion") != 1:
        fail("BUILD_METADATA.json schemaVersion must be 1")
    prism = metadata.get("prism")
    if not isinstance(prism, dict):
        fail("BUILD_METADATA.json prism object is missing")
    if set(prism) != {
        "commit",
        "sourceDateEpoch",
        "tag",
        "tagObject",
        "tagVerification",
    }:
        fail("BUILD_METADATA.json prism object has an incomplete or extended schema")
    if prism.get("tag") != tag or prism.get("commit") != commit:
        fail("BUILD_METADATA.json Prism tag or full commit does not match the release")
    if prism.get("tagObject") != expected_tag_object:
        fail("BUILD_METADATA.json Prism tagObject does not match the verified tag object")
    if prism.get("sourceDateEpoch") != expected_source_date_epoch:
        fail("BUILD_METADATA.json sourceDateEpoch does not match the verified commit epoch")
    if prism.get("tagVerification") != expected_tag_verification:
        fail("BUILD_METADATA.json tagVerification does not match the prepare result")
    if metadata.get("coreContract") != core:
        fail("BUILD_METADATA.json Core contract does not match core-contract.json")
    for field in ("repository", "tag", "tag_object", "commit"):
        if not str(core.get(field, "")):
            fail(f"core-contract.json is missing {field}")
    digests = metadata.get("artifactDigests")
    if not isinstance(digests, dict) or set(digests) != installers:
        fail("BUILD_METADATA.json artifactDigests must cover exactly the 7 installers")
    for name in sorted(installers):
        if digests[name] != f"sha256:{local_digests[name]}":
            fail(f"BUILD_METADATA.json digest mismatch for {name}")
    if metadata.get("reproducibility") != expected_reproducibility:
        fail("BUILD_METADATA.json reproducibility contract does not match the expected object")
    if metadata.get("tools") != expected_tools:
        fail("BUILD_METADATA.json tools contract does not match the expected object")


def validate_staged(
    release_dir: Path,
    tag: str,
    commit: str,
    core_contract_path: Path,
    expected_tag_object: str,
    expected_source_date_epoch: int,
    expected_tag_verification: str,
    expected_reproducibility: dict[str, object],
    expected_tools: dict[str, object],
) -> tuple[set[str], dict[str, str]]:
    if not release_dir.is_dir():
        fail(f"release directory is missing: {release_dir}")
    paths = sorted(path for path in release_dir.iterdir() if path.is_file())
    names = {path.name for path in paths}
    if len(names) != 11 or len(paths) != 11:
        fail(f"release must contain exactly 11 files, found {len(paths)}")
    if not AUXILIARY_ASSETS.issubset(names):
        fail(f"release auxiliary assets are incomplete: {sorted(AUXILIARY_ASSETS - names)}")
    installers = installer_names(names)
    local_digests = {path.name: sha256(path) for path in paths}
    manifest = parse_manifest(release_dir / "SHA256SUMS.txt")
    expected_manifest = names - {"SHA256SUMS.txt"}
    if set(manifest) != expected_manifest or len(manifest) != 10:
        fail("SHA256SUMS.txt must cover exactly the other 10 release assets")
    for name, digest in manifest.items():
        if digest != local_digests[name]:
            fail(f"SHA256SUMS.txt digest mismatch for {name}")
    validate_metadata(
        release_dir / "BUILD_METADATA.json",
        installers,
        local_digests,
        tag,
        commit,
        core_contract_path,
        expected_tag_object,
        expected_source_date_epoch,
        expected_tag_verification,
        expected_reproducibility,
        expected_tools,
    )
    return names, local_digests


def validate_published(
    release_json_path: Path,
    release_dir: Path,
    names: set[str],
    local_digests: dict[str, str],
    tag: str,
    commit: str,
    prerelease: bool,
    latest_tag: str,
) -> None:
    release = json.loads(release_json_path.read_text(encoding="utf-8"))
    expected_body = (
        (release_dir / "RELEASE_NOTES.md").read_text(encoding="utf-8").rstrip()
        + "\n\n---\n\n"
        + (release_dir / "RELEASE_NOTES.zh-CN.md").read_text(encoding="utf-8").rstrip()
    )
    expected_fields = {
        "tag_name": tag,
        "target_commitish": commit,
        "draft": False,
        "prerelease": prerelease,
        "immutable": True,
        "body": expected_body,
    }
    for field, expected in expected_fields.items():
        if release.get(field) != expected:
            fail(f"published release {field} is {release.get(field)!r}, expected {expected!r}")
    if prerelease and latest_tag == tag:
        fail("prerelease unexpectedly became GitHub latest")
    if not prerelease and latest_tag != tag:
        fail(f"stable release is not GitHub latest; latest is {latest_tag!r}")

    assets = release.get("assets")
    if not isinstance(assets, list):
        fail("published release assets are missing")
    remote = {str(asset.get("name")): str(asset.get("digest", "")) for asset in assets}
    if len(assets) != 11 or len(remote) != 11 or set(remote) != names:
        fail("published release must contain the exact 11 staged assets")
    for name in sorted(names):
        expected_digest = f"sha256:{local_digests[name]}"
        if remote[name] != expected_digest:
            fail(f"published digest mismatch for {name}: {remote[name]!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--core-contract", type=Path, default=Path("core-contract.json"))
    parser.add_argument("--expected-tag-object", required=True)
    parser.add_argument("--expected-source-date-epoch", type=int, required=True)
    parser.add_argument("--expected-tag-verification", required=True)
    parser.add_argument("--expected-reproducibility-json", required=True)
    parser.add_argument("--expected-tools-json", required=True)
    parser.add_argument("--release-json", type=Path)
    parser.add_argument("--prerelease", choices=("true", "false"))
    parser.add_argument("--latest-tag")
    args = parser.parse_args()
    try:
        if not FULL_OBJECT_ID.fullmatch(args.commit):
            fail("commit must be a full object ID")
        if not FULL_OBJECT_ID.fullmatch(args.expected_tag_object):
            fail("expected tag object must be a full object ID")
        expected_reproducibility = json.loads(args.expected_reproducibility_json)
        expected_tools = json.loads(args.expected_tools_json)
        if not isinstance(expected_reproducibility, dict) or set(expected_reproducibility) != {
            "installerByteReproducibilityGuaranteed",
            "stagedAssetTimestampsNormalized",
        } or not all(isinstance(value, bool) for value in expected_reproducibility.values()):
            fail("expected reproducibility JSON must contain exactly the two boolean schema fields")
        if not isinstance(expected_tools, dict) or not expected_tools:
            fail("expected tools JSON must be a non-empty object")
        if not all(isinstance(name, str) and isinstance(value, str) for name, value in expected_tools.items()):
            fail("expected tools JSON keys and values must be strings")
        if args.expected_source_date_epoch <= 0:
            fail("expected source date epoch must be positive")
        if args.expected_tag_verification not in {"ref-commit", "signature"}:
            fail("expected tag verification must be ref-commit or signature")
        names, digests = validate_staged(
            args.release_dir,
            args.tag,
            args.commit,
            args.core_contract,
            args.expected_tag_object,
            args.expected_source_date_epoch,
            args.expected_tag_verification,
            expected_reproducibility,
            expected_tools,
        )
        if args.release_json:
            if args.prerelease is None or args.latest_tag is None:
                fail("published validation requires --prerelease and --latest-tag")
            validate_published(
                args.release_json,
                args.release_dir,
                names,
                digests,
                args.tag,
                args.commit,
                args.prerelease == "true",
                "" if args.latest_tag == "__NONE__" else args.latest_tag,
            )
        print("release asset contract valid: 7 installers, 11 assets, 10 manifest entries")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"release asset validation failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

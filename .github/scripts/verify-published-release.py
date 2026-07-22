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
) -> None:
    metadata = json.loads(path.read_text(encoding="utf-8"))
    core = json.loads(core_contract_path.read_text(encoding="utf-8"))
    if metadata.get("schemaVersion") != 1:
        fail("BUILD_METADATA.json schemaVersion must be 1")
    prism = metadata.get("prism")
    if not isinstance(prism, dict):
        fail("BUILD_METADATA.json prism object is missing")
    if prism.get("tag") != tag or prism.get("commit") != commit:
        fail("BUILD_METADATA.json Prism tag or full commit does not match the release")
    if not FULL_OBJECT_ID.fullmatch(str(prism.get("tagObject", ""))):
        fail("BUILD_METADATA.json Prism tagObject must be a full object ID")
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


def validate_staged(
    release_dir: Path,
    tag: str,
    commit: str,
    core_contract_path: Path,
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
    parser.add_argument("--release-json", type=Path)
    parser.add_argument("--prerelease", choices=("true", "false"))
    parser.add_argument("--latest-tag")
    args = parser.parse_args()
    try:
        if not FULL_OBJECT_ID.fullmatch(args.commit):
            fail("commit must be a full object ID")
        names, digests = validate_staged(
            args.release_dir,
            args.tag,
            args.commit,
            args.core_contract,
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

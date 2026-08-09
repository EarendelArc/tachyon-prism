#!/usr/bin/env python3
"""Fail-closed validation for staged and published Prism prerelease assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


AUXILIARY_ASSETS = {
    "BUILD_METADATA.json",
    "RELEASE_INDEX.json",
    "RELEASE_MANIFEST.json",
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
TARGET_INFO = {
    "windows-x64": ("windows", "x86_64"),
    "windows-arm64": ("windows", "aarch64"),
    "macos-x64": ("macos", "x86_64"),
    "macos-arm64": ("macos", "aarch64"),
    "linux-x64": ("linux", "x86_64"),
    "linux-arm64": ("linux", "aarch64"),
}
FULL_OBJECT_ID = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
PREVIEW_TAG = re.compile(
    r"^v\d+\.\d+\.\d+-(?:alpha|beta|rc|pre|preview)(?:[.-][0-9A-Za-z]+)*$"
)


def fail(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_object(path: Path, description: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{description} must be a JSON object")
    return value


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


def parse_checksums(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\]+)", line)
        if not match:
            fail(f"invalid SHA256SUMS.txt line {line_number}: {line!r}")
        digest, name = match.groups()
        if name in entries:
            fail(f"duplicate checksum entry: {name}")
        entries[name] = digest
    return entries


def expected_target_records(
    installers: set[str], local_digests: dict[str, str], local_sizes: dict[str, int]
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for name in sorted(installers):
        target = next(
            target for target in TARGET_INFO if name.startswith(f"tachyon-prism-{target}_")
        )
        platform, arch = TARGET_INFO[target]
        records.append(
            {
                "arch": arch,
                "format": Path(name).suffix.lower().lstrip("."),
                "name": name,
                "platform": platform,
                "sha256": f"sha256:{local_digests[name]}",
                "size": local_sizes[name],
                "target": target,
            }
        )
    return records


def validate_metadata(
    path: Path,
    installers: set[str],
    local_digests: dict[str, str],
    tag: str,
    commit: str,
    core_contract_path: Path,
    expected_tag_object: str,
    expected_source_date_epoch: int,
    expected_reproducibility: dict[str, object],
    expected_tools: dict[str, object],
) -> None:
    metadata = load_object(path, "BUILD_METADATA.json")
    core = load_object(core_contract_path, "core-contract.json")
    if set(metadata) != {
        "artifactDigests", "coreContract", "prism", "reproducibility", "schemaVersion", "tools"
    } or metadata.get("schemaVersion") != 2:
        fail("BUILD_METADATA.json must contain the exact schemaVersion 2 fields")
    prism = metadata.get("prism")
    if not isinstance(prism, dict) or set(prism) != {
        "channel", "commit", "prerelease", "sourceDateEpoch", "tag", "tagObject", "tagVerification"
    }:
        fail("BUILD_METADATA.json prism object has an incomplete or extended schema")
    expected_prism = {
        "channel": "preview",
        "commit": commit,
        "prerelease": True,
        "sourceDateEpoch": expected_source_date_epoch,
        "tag": tag,
        "tagObject": expected_tag_object,
        "tagVerification": "signature",
    }
    if prism != expected_prism:
        fail("BUILD_METADATA.json Prism identity or signed prerelease contract does not match")
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
        fail("BUILD_METADATA.json reproducibility contract does not match")
    if metadata.get("tools") != expected_tools:
        fail("BUILD_METADATA.json tools contract does not match")


def validate_index(
    path: Path, targets: list[dict[str, object]], tag: str, commit: str, tag_object: str
) -> None:
    index = load_object(path, "RELEASE_INDEX.json")
    expected = {
        "channels": {
            "preview": {"acceptsPrerelease": True, "prefersPrerelease": True},
            "stable": {"acceptsPrerelease": False, "prefersPrerelease": False},
        },
        "release": {
            "channel": "preview",
            "commit": commit,
            "manifest": "RELEASE_MANIFEST.json",
            "prerelease": True,
            "tag": tag,
            "tagObject": tag_object,
        },
        "repository": "EarendelArc/tachyon-prism",
        "schemaVersion": 1,
        "targets": targets,
    }
    if index != expected:
        fail("RELEASE_INDEX.json does not match the stable/preview runtime contract")


def validate_manifest(
    path: Path,
    names: set[str],
    installers: set[str],
    local_digests: dict[str, str],
    local_sizes: dict[str, int],
    tag: str,
    commit: str,
    tag_object: str,
) -> None:
    manifest = load_object(path, "RELEASE_MANIFEST.json")
    if set(manifest) != {
        "assetCountTotal", "assets", "channel", "checksumAsset", "commit",
        "manifestSelfCoveredBy", "prerelease", "schemaVersion", "sha256EntryCount", "tag", "tagObject"
    }:
        fail("RELEASE_MANIFEST.json has an incomplete or extended schema")
    if {
        "assetCountTotal": manifest.get("assetCountTotal"),
        "channel": manifest.get("channel"),
        "checksumAsset": manifest.get("checksumAsset"),
        "commit": manifest.get("commit"),
        "manifestSelfCoveredBy": manifest.get("manifestSelfCoveredBy"),
        "prerelease": manifest.get("prerelease"),
        "schemaVersion": manifest.get("schemaVersion"),
        "sha256EntryCount": manifest.get("sha256EntryCount"),
        "tag": manifest.get("tag"),
        "tagObject": manifest.get("tagObject"),
    } != {
        "assetCountTotal": 13,
        "channel": "preview",
        "checksumAsset": "SHA256SUMS.txt",
        "commit": commit,
        "manifestSelfCoveredBy": "SHA256SUMS.txt",
        "prerelease": True,
        "schemaVersion": 1,
        "sha256EntryCount": 12,
        "tag": tag,
        "tagObject": tag_object,
    }:
        fail("RELEASE_MANIFEST.json identity or count contract does not match")
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        fail("RELEASE_MANIFEST.json assets must be an array")
    expected_names = names - {"RELEASE_MANIFEST.json", "SHA256SUMS.txt"}
    actual_names = [str(asset.get("name")) for asset in assets if isinstance(asset, dict)]
    if len(assets) != 11 or len(set(actual_names)) != 11 or set(actual_names) != expected_names:
        fail("RELEASE_MANIFEST.json must cover exactly 11 non-recursive payload assets")
    for asset in assets:
        if not isinstance(asset, dict):
            fail("RELEASE_MANIFEST.json asset entry must be an object")
        name = str(asset.get("name"))
        if asset.get("sha256") != f"sha256:{local_digests[name]}" or asset.get("size") != local_sizes[name]:
            fail(f"RELEASE_MANIFEST.json digest or size mismatch for {name}")
        if name in installers:
            target = next(target for target in TARGET_INFO if name.startswith(f"tachyon-prism-{target}_"))
            platform, arch = TARGET_INFO[target]
            expected = {
                "arch": arch,
                "format": Path(name).suffix.lower().lstrip("."),
                "kind": "installer",
                "name": name,
                "platform": platform,
                "sha256": f"sha256:{local_digests[name]}",
                "size": local_sizes[name],
                "target": target,
            }
        else:
            expected = {
                "kind": "metadata", "name": name,
                "sha256": f"sha256:{local_digests[name]}", "size": local_sizes[name]
            }
        if asset != expected:
            fail(f"RELEASE_MANIFEST.json schema mismatch for {name}")


def validate_staged(
    release_dir: Path,
    tag: str,
    commit: str,
    core_contract_path: Path,
    expected_tag_object: str,
    expected_source_date_epoch: int,
    expected_reproducibility: dict[str, object],
    expected_tools: dict[str, object],
) -> tuple[set[str], dict[str, str], dict[str, int]]:
    if not release_dir.is_dir():
        fail(f"release directory is missing: {release_dir}")
    paths = sorted(path for path in release_dir.iterdir() if path.is_file())
    names = {path.name for path in paths}
    if len(names) != 13 or len(paths) != 13:
        fail(f"release must contain exactly 13 files, found {len(paths)}")
    if not AUXILIARY_ASSETS.issubset(names):
        fail(f"release auxiliary assets are incomplete: {sorted(AUXILIARY_ASSETS - names)}")
    installers = installer_names(names)
    local_digests = {path.name: sha256(path) for path in paths}
    local_sizes = {path.name: path.stat().st_size for path in paths}
    checksums = parse_checksums(release_dir / "SHA256SUMS.txt")
    expected_checksums = names - {"SHA256SUMS.txt"}
    if set(checksums) != expected_checksums or len(checksums) != 12:
        fail("SHA256SUMS.txt must cover exactly the other 12 release assets")
    for name, digest in checksums.items():
        if digest != local_digests[name]:
            fail(f"SHA256SUMS.txt digest mismatch for {name}")
    targets = expected_target_records(installers, local_digests, local_sizes)
    validate_metadata(
        release_dir / "BUILD_METADATA.json", installers, local_digests, tag, commit,
        core_contract_path, expected_tag_object, expected_source_date_epoch,
        expected_reproducibility, expected_tools,
    )
    validate_index(release_dir / "RELEASE_INDEX.json", targets, tag, commit, expected_tag_object)
    validate_manifest(
        release_dir / "RELEASE_MANIFEST.json", names, installers, local_digests,
        local_sizes, tag, commit, expected_tag_object,
    )
    return names, local_digests, local_sizes


def validate_remote_release(
    release_json_path: Path,
    release_dir: Path,
    names: set[str],
    local_digests: dict[str, str],
    local_sizes: dict[str, int],
    tag: str,
    commit: str,
    latest_tag: str,
    expected_state: str,
) -> None:
    release = load_object(release_json_path, "published release")
    expected_body = (
        (release_dir / "RELEASE_NOTES.md").read_text(encoding="utf-8").rstrip()
        + "\n\n---\n\n"
        + (release_dir / "RELEASE_NOTES.zh-CN.md").read_text(encoding="utf-8").rstrip()
    )
    expected_fields: dict[str, object] = {
        "tag_name": tag,
        "target_commitish": commit,
        "name": f"Tachyon Prism {tag}",
        "draft": expected_state == "draft",
        "prerelease": True,
        "body": expected_body,
    }
    if expected_state == "published":
        expected_fields["immutable"] = True
    for field, expected in expected_fields.items():
        if release.get(field) != expected:
            fail(f"remote release {field} is {release.get(field)!r}, expected {expected!r}")
    if expected_state == "published" and latest_tag == tag:
        fail("prerelease unexpectedly became GitHub latest")
    assets = release.get("assets")
    if not isinstance(assets, list):
        fail("published release assets are missing")
    remote: dict[str, dict[str, object]] = {}
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            fail("published release contains a malformed asset")
        name = str(asset["name"])
        if name in remote:
            fail(f"published release contains duplicate asset {name}")
        remote[name] = asset
    if len(assets) != 13 or set(remote) != names:
        fail("published release must contain the exact 13 staged assets")
    for name in sorted(names):
        expected_digest = f"sha256:{local_digests[name]}"
        if remote[name].get("digest") != expected_digest:
            fail(f"published digest mismatch for {name}: {remote[name].get('digest')!r}")
        if remote[name].get("size") != local_sizes[name]:
            fail(f"published size mismatch for {name}: {remote[name].get('size')!r}")


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
    parser.add_argument("--expected-state", choices=("draft", "published"))
    parser.add_argument("--latest-tag")
    args = parser.parse_args()
    try:
        if not PREVIEW_TAG.fullmatch(args.tag):
            fail("tag must be a supported Prism prerelease tag")
        if not FULL_OBJECT_ID.fullmatch(args.commit):
            fail("commit must be a full object ID")
        if not FULL_OBJECT_ID.fullmatch(args.expected_tag_object):
            fail("expected tag object must be a full object ID")
        if args.expected_tag_verification != "signature":
            fail("expected tag verification must be signature")
        expected_reproducibility = json.loads(args.expected_reproducibility_json)
        expected_tools = json.loads(args.expected_tools_json)
        if not isinstance(expected_reproducibility, dict) or set(expected_reproducibility) != {
            "installerByteReproducibilityGuaranteed", "stagedAssetTimestampsNormalized"
        } or not all(isinstance(value, bool) for value in expected_reproducibility.values()):
            fail("expected reproducibility JSON must contain exactly the two boolean fields")
        if not isinstance(expected_tools, dict) or not expected_tools or not all(
            isinstance(name, str) and isinstance(value, str) for name, value in expected_tools.items()
        ):
            fail("expected tools JSON must be a non-empty string map")
        if args.expected_source_date_epoch <= 0:
            fail("expected source date epoch must be positive")
        names, digests, sizes = validate_staged(
            args.release_dir, args.tag, args.commit, args.core_contract,
            args.expected_tag_object, args.expected_source_date_epoch,
            expected_reproducibility, expected_tools,
        )
        if args.release_json:
            if args.expected_state is None:
                fail("remote validation requires --expected-state")
            if args.expected_state == "published" and args.latest_tag is None:
                fail("published validation requires --latest-tag")
            validate_remote_release(
                args.release_json, args.release_dir, names, digests, sizes,
                args.tag, args.commit,
                "" if args.latest_tag in {None, "__NONE__"} else args.latest_tag,
                args.expected_state,
            )
        print("release asset contract valid: 6 targets, 7 installers, 13 assets, 12 checksum entries")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"release asset validation failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

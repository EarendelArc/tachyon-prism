#!/usr/bin/env python3
"""Validate that an existing draft can be resumed without replacing assets."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def fail(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-json", type=Path, required=True)
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--notes-en", type=Path, required=True)
    parser.add_argument("--notes-zh", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--missing-output", type=Path)
    args = parser.parse_args()
    try:
        release = json.loads(args.release_json.read_text(encoding="utf-8"))
        if not isinstance(release, dict):
            fail("draft release response must be an object")
        expected_body = (
            args.notes_en.read_text(encoding="utf-8").rstrip()
            + "\n\n---\n\n"
            + args.notes_zh.read_text(encoding="utf-8").rstrip()
        )
        expected = {
            "tag_name": args.tag,
            "target_commitish": args.commit,
            "name": f"Tachyon Prism {args.tag}",
            "body": expected_body,
            "draft": True,
            "prerelease": True,
        }
        for field, value in expected.items():
            if release.get(field) != value:
                fail(f"existing draft {field} is {release.get(field)!r}, expected {value!r}")
        release_id = release.get("id")
        if not isinstance(release_id, int) or release_id <= 0:
            fail("existing draft has an invalid release id")

        local_paths = sorted(path for path in args.release_dir.iterdir() if path.is_file())
        local = {path.name: path for path in local_paths}
        if len(local_paths) != 13 or len(local) != 13:
            fail("local release directory must contain exactly 13 unique assets")
        assets = release.get("assets")
        if not isinstance(assets, list):
            fail("existing draft assets must be an array")
        seen: set[str] = set()
        for asset in assets:
            if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
                fail("existing draft contains a malformed asset")
            name = asset["name"]
            if name in seen:
                fail(f"existing draft contains duplicate asset {name}")
            seen.add(name)
            if name not in local:
                fail(f"existing draft contains unexpected asset {name}")
            expected_digest = f"sha256:{sha256(local[name])}"
            if asset.get("digest") != expected_digest:
                fail(f"existing draft digest mismatch for {name}")
            if asset.get("size") != local[name].stat().st_size:
                fail(f"existing draft size mismatch for {name}")
        missing = sorted(set(local) - seen)
        if args.missing_output:
            args.missing_output.write_text("".join(f"{name}\n" for name in missing), encoding="utf-8")
        print(f"resumable draft valid: id={release_id}, existing={len(seen)}, missing={len(missing)}")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"resumable draft validation failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

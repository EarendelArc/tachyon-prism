#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"Core contract verification failed: {message}")


def git(core_dir: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", f"safe.directory={core_dir.resolve().as_posix()}", *args],
        cwd=core_dir,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"git {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    core_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / "tachyon-core"
    contract = json.loads((root / "core-contract.json").read_text(encoding="utf-8"))
    for field in ("commit", "tag_object"):
        if not re.fullmatch(r"[0-9a-f]{40}", str(contract.get(field, ""))):
            fail(f"{field} must be a full lowercase SHA-1")
    tag = str(contract.get("tag", ""))
    if not re.fullmatch(r"v[0-9A-Za-z][0-9A-Za-z._-]*", tag):
        fail("tag is invalid")
    if not (core_dir / ".git").exists():
        fail(f"repository is missing: {core_dir}")

    tag_ref = f"refs/tags/{tag}"
    if git(core_dir, "cat-file", "-t", tag_ref) != "tag":
        fail(f"{tag_ref} is not an annotated tag")
    if git(core_dir, "rev-parse", tag_ref) != contract["tag_object"]:
        fail("annotated tag object does not match the pin")
    if git(core_dir, "rev-parse", f"{tag_ref}^{{}}") != contract["commit"]:
        fail("annotated tag does not peel to the pinned commit")
    if git(core_dir, "rev-parse", "HEAD") != contract["commit"]:
        fail("checked-out Core HEAD does not match the pinned commit")
    print(
        f"Verified {tag}: tag object {contract['tag_object']} -> commit {contract['commit']}"
    )


if __name__ == "__main__":
    main()

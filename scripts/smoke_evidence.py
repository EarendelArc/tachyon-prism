from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Iterable


COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def current_git_commit(root: Path) -> str:
    completed = subprocess.run(
        [
            "git",
            "-c",
            f"safe.directory={root.as_posix()}",
            "-C",
            str(root),
            "rev-parse",
            "HEAD",
        ],
        check=True,
        capture_output=True,
        encoding="utf-8",
        errors="strict",
        timeout=15,
    )
    commit = completed.stdout.strip().lower()
    if not COMMIT_PATTERN.fullmatch(commit):
        raise RuntimeError(f"git rev-parse returned an invalid commit: {commit!r}")
    return commit


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_clean_worktree(root: Path) -> None:
    completed = subprocess.run(
        [
            "git",
            "-c",
            f"safe.directory={root.as_posix()}",
            "-C",
            str(root),
            "status",
            "--porcelain",
            "--untracked-files=all",
        ],
        check=True,
        capture_output=True,
        encoding="utf-8",
        errors="strict",
        timeout=15,
    )
    if completed.stdout.strip():
        raise RuntimeError("evidence generation requires a clean Git worktree")


def evidence_file_entry(root: Path, path: Path, role: str) -> dict[str, Any]:
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    try:
        relative = resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"evidence file is outside artifact root: {resolved_path}") from error
    if not resolved_path.is_file() or resolved_path.is_symlink():
        raise ValueError(f"evidence file must be a regular non-symlink file: {resolved_path}")
    return {
        "path": relative.as_posix(),
        "role": role,
        "sizeBytes": resolved_path.stat().st_size,
        "sha256": sha256_file(resolved_path),
    }


def build_evidence_manifest(
    root: Path,
    commit: str,
    files: Iterable[tuple[Path, str]],
) -> dict[str, Any]:
    if not COMMIT_PATTERN.fullmatch(commit):
        raise ValueError(f"invalid evidence commit: {commit!r}")
    entries = [evidence_file_entry(root, path, role) for path, role in files]
    entries.sort(key=lambda entry: entry["path"])
    paths = [entry["path"] for entry in entries]
    if len(paths) != len(set(paths)):
        raise ValueError("evidence manifest contains duplicate paths")
    return {
        "schemaVersion": 1,
        "artifactType": "tachyon-prism-ui-smoke-evidence",
        "gitCommit": commit,
        "hashAlgorithm": "sha256",
        "files": entries,
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

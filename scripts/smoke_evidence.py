from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path
from typing import Any, Callable, Iterable


COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
WINDOWS_REPARSE_POINT = 0x400


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


def _absolute_lexical(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _is_symlink_or_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & WINDOWS_REPARSE_POINT
    )


def _identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _stable_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _path_components(path: Path) -> list[Path]:
    anchor = Path(path.anchor)
    components = [anchor]
    current = anchor
    for part in path.parts[1:]:
        current /= part
        components.append(current)
    return components


def _capture_path_identities(path: Path) -> list[tuple[Path, tuple[int, int]]]:
    components = _path_components(path)
    captured: list[tuple[Path, tuple[int, int]]] = []
    for index, component in enumerate(components):
        metadata = os.lstat(component)
        if _is_symlink_or_reparse(metadata):
            raise ValueError(f"evidence path component is a symlink or reparse point: {component}")
        if index < len(components) - 1 and not stat.S_ISDIR(metadata.st_mode):
            raise ValueError(f"evidence parent component is not a directory: {component}")
        captured.append((component, _identity(metadata)))
    return captured


def _open_file_no_follow(path: Path) -> int:
    file_flags = os.O_RDONLY
    file_flags |= getattr(os, "O_BINARY", 0)
    file_flags |= getattr(os, "O_CLOEXEC", 0)
    file_flags |= getattr(os, "O_NOFOLLOW", 0)
    if os.name != "posix":
        return os.open(path, file_flags)

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_flags |= getattr(os, "O_CLOEXEC", 0)
    directory_descriptor = os.open(path.anchor, directory_flags)
    try:
        for component in path.parts[1:-1]:
            next_descriptor = os.open(
                component,
                directory_flags,
                dir_fd=directory_descriptor,
            )
            os.close(directory_descriptor)
            directory_descriptor = next_descriptor
        return os.open(path.name, file_flags, dir_fd=directory_descriptor)
    finally:
        os.close(directory_descriptor)


def secure_file_measure(
    path: Path,
    *,
    _after_open: Callable[[], None] | None = None,
) -> tuple[str, int]:
    lexical_path = _absolute_lexical(path)
    before_components = _capture_path_identities(lexical_path)
    final_before = os.lstat(lexical_path)
    if not stat.S_ISREG(final_before.st_mode):
        raise ValueError(f"evidence file must be a regular file: {lexical_path}")

    descriptor = _open_file_no_follow(lexical_path)
    try:
        opened = os.fstat(descriptor)
        if _is_symlink_or_reparse(opened) or not stat.S_ISREG(opened.st_mode):
            raise ValueError(f"evidence descriptor is not a regular no-follow file: {lexical_path}")
        if _identity(opened) != _identity(final_before):
            raise ValueError(f"evidence file changed while opening: {lexical_path}")
        opened_identity = _stable_identity(opened)
        if _after_open is not None:
            _after_open()

        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
            after_read = os.fstat(source.fileno())
        if _stable_identity(after_read) != opened_identity:
            raise ValueError(f"evidence file changed while reading: {lexical_path}")
    finally:
        os.close(descriptor)

    after_components = _capture_path_identities(lexical_path)
    if len(after_components) != len(before_components) or any(
        before_path != after_path or before_identity != after_identity
        for (before_path, before_identity), (after_path, after_identity) in zip(
            before_components, after_components, strict=True
        )
    ):
        raise ValueError(f"evidence path identity changed after reading: {lexical_path}")
    return digest.hexdigest(), after_read.st_size


def sha256_file(path: Path) -> str:
    digest, _ = secure_file_measure(path)
    return digest


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
    resolved_root = _absolute_lexical(root)
    resolved_path = _absolute_lexical(path)
    try:
        relative = resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"evidence file is outside artifact root: {resolved_path}") from error
    digest, size = secure_file_measure(resolved_path)
    return {
        "path": relative.as_posix(),
        "role": role,
        "sizeBytes": size,
        "sha256": digest,
    }


def build_evidence_manifest(
    root: Path,
    commit: str,
    files: Iterable[tuple[Path, str]],
    *,
    artifact_type: str = "tachyon-prism-renderer-fixture-evidence",
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
        "artifactType": artifact_type,
        "gitCommit": commit,
        "hashAlgorithm": "sha256",
        "files": entries,
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

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
    digest, size, _ = _secure_file_read(path, _after_open=_after_open, capture=False)
    return digest, size


def secure_file_bytes(path: Path) -> bytes:
    _, _, content = _secure_file_read(path, capture=True)
    assert content is not None
    return content


def _secure_file_read(
    path: Path,
    *,
    _after_open: Callable[[], None] | None = None,
    capture: bool,
) -> tuple[str, int, bytes | None]:
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
        captured = bytearray() if capture else None
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                if captured is not None:
                    captured.extend(chunk)
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
    return digest.hexdigest(), after_read.st_size, bytes(captured) if captured is not None else None


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


def read_secure_json(path: Path) -> dict[str, Any]:
    payload, _, _ = read_secure_json_with_measure(path)
    return payload


def read_secure_json_with_measure(path: Path) -> tuple[dict[str, Any], str, int]:
    content = secure_file_bytes(path)
    payload = json.loads(content.decode("utf-8", errors="strict"))
    if not isinstance(payload, dict):
        raise ValueError(f"evidence JSON must be an object: {path}")
    return payload, hashlib.sha256(content).hexdigest(), len(content)


def verify_evidence_manifest(
    root: Path,
    manifest_path: Path,
    commit: str,
    artifact_type: str,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], str, int]:
    manifest, manifest_digest, manifest_size = read_secure_json_with_measure(manifest_path)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("artifactType") != artifact_type
        or manifest.get("gitCommit") != commit
        or manifest.get("hashAlgorithm") != "sha256"
        or not isinstance(manifest.get("files"), list)
    ):
        raise ValueError(f"invalid evidence manifest metadata: {manifest_path}")
    entries: dict[str, dict[str, Any]] = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict):
            raise ValueError(f"invalid evidence manifest entry: {manifest_path}")
        relative = entry.get("path")
        digest = entry.get("sha256")
        size = entry.get("sizeBytes")
        role = entry.get("role")
        if (
            not isinstance(relative, str)
            or not relative
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or not isinstance(role, str)
            or not role
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
        ):
            raise ValueError(f"invalid evidence manifest entry fields: {manifest_path}")
        if relative in entries:
            raise ValueError(f"duplicate evidence manifest path: {relative}")
        actual_digest, actual_size = secure_file_measure(root / relative)
        if actual_digest != digest or actual_size != size:
            raise ValueError(f"evidence manifest mismatch: {relative}")
        entries[relative] = entry
    return manifest, entries, manifest_digest, manifest_size


def verify_layered_evidence_tree(
    root: Path,
    result_path: Path,
    renderer_manifest_path: Path,
    native_manifest_path: Path,
    commit: str,
) -> None:
    result, result_digest, result_size = read_secure_json_with_measure(result_path)
    if (
        result.get("status") != "layered-evidence-complete"
        or result.get("schemaVersion") != 2
        or result.get("artifactType") != "tachyon-prism-layered-evidence-index"
        or result.get("gitCommit") != commit
    ):
        raise ValueError("invalid layered evidence RESULT metadata")
    renderer = result.get("rendererFixtureEvidence")
    native = result.get("nativeBuildEvidence")
    if not isinstance(renderer, dict) or not isinstance(native, dict):
        raise ValueError("layered evidence RESULT sections are missing")
    if (
        renderer.get("status") != "passed"
        or renderer.get("executionSubject") != "vite-ui-smoke-renderer-fixture"
        or renderer.get("nativeExecutableExecuted") is not False
        or native.get("status") != "built-not-executed"
        or result.get("causalClaims")
        != {
            "rendererFixtureExecutionProven": True,
            "nativeExecutableExecutionProven": False,
            "screenshotsProducedByNativeExecutable": False,
        }
    ):
        raise ValueError("layered evidence causal claims are invalid")

    _, renderer_entries, renderer_manifest_digest, _ = verify_evidence_manifest(
        root,
        renderer_manifest_path,
        commit,
        "tachyon-prism-renderer-fixture-evidence",
    )
    _, native_entries, native_manifest_digest, _ = verify_evidence_manifest(
        root,
        native_manifest_path,
        commit,
        "tachyon-prism-native-build-evidence",
    )
    manifest_specs = (
        (renderer.get("manifest"), renderer_manifest_path),
        (native.get("manifest"), native_manifest_path),
    )
    for (reference, manifest_path), digest in zip(
        manifest_specs,
        (renderer_manifest_digest, native_manifest_digest),
        strict=True,
    ):
        if not isinstance(reference, dict):
            raise ValueError("layered evidence manifest reference is missing")
        if reference.get("path") != manifest_path.name or reference.get("sha256") != digest:
            raise ValueError(f"layered evidence manifest reference mismatch: {manifest_path.name}")

    referenced_paths: list[str] = []
    runs = renderer.get("runs")
    if not isinstance(runs, list) or len(runs) != 2:
        raise ValueError("layered evidence must reference exactly two renderer runs")
    for run in runs:
        if not isinstance(run, dict) or not isinstance(run.get("screenshots"), list):
            raise ValueError("invalid renderer run reference")
        references = [run.get("result"), *run["screenshots"]]
        for reference in references:
            _verify_result_file_reference(reference, renderer_entries)
            referenced_paths.append(reference["path"])
    executable = native.get("executable")
    _verify_result_file_reference(executable, native_entries)
    referenced_paths.append(executable["path"])
    if len(referenced_paths) != len(set(referenced_paths)):
        raise ValueError("layered RESULT contains duplicate artifact references")
    if set(referenced_paths) != set(renderer_entries) | set(native_entries):
        raise ValueError("layered RESULT does not reference every manifested artifact exactly")

    expected = {
        result_path.relative_to(root).as_posix(),
        renderer_manifest_path.relative_to(root).as_posix(),
        native_manifest_path.relative_to(root).as_posix(),
        *renderer_entries,
        *native_entries,
    }
    actual: set[str] = set()
    for directory, directories, files in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for name in directories:
            metadata = os.lstat(directory_path / name)
            if _is_symlink_or_reparse(metadata):
                raise ValueError(f"evidence tree contains a linked directory: {directory_path / name}")
        for name in files:
            path = directory_path / name
            metadata = os.lstat(path)
            if _is_symlink_or_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
                raise ValueError(f"evidence tree contains a non-regular file: {path}")
            actual.add(path.relative_to(root).as_posix())
    if actual != expected:
        raise ValueError(
            f"evidence tree membership mismatch: missing={sorted(expected - actual)}, "
            f"unexpected={sorted(actual - expected)}"
        )
    # Re-check all expected values only after RESULT and both manifests are complete.
    all_entries = {**renderer_entries, **native_entries}
    for relative, entry in sorted(all_entries.items()):
        digest, size = secure_file_measure(root / relative)
        if digest != entry["sha256"] or size != entry["sizeBytes"]:
            raise ValueError(f"final evidence tree mismatch: {relative}")
    for reference, manifest_path in manifest_specs:
        digest, _ = secure_file_measure(manifest_path)
        if reference["sha256"] != digest:
            raise ValueError(f"final evidence manifest mismatch: {manifest_path.name}")
    final_result_digest, final_result_size = secure_file_measure(result_path)
    if (final_result_digest, final_result_size) != (result_digest, result_size):
        raise ValueError("final layered evidence RESULT changed during verification")


def _verify_result_file_reference(
    reference: Any, entries: dict[str, dict[str, Any]]
) -> None:
    if not isinstance(reference, dict) or not isinstance(reference.get("path"), str):
        raise ValueError("invalid layered evidence file reference")
    entry = entries.get(reference["path"])
    if entry is None or reference != {
        "path": entry["path"],
        "sha256": entry["sha256"],
        "sizeBytes": entry["sizeBytes"],
    }:
        raise ValueError(f"layered evidence file reference mismatch: {reference.get('path')}")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from prism_ui_smoke import EDGE
from smoke_evidence import (
    build_evidence_manifest,
    current_git_commit,
    ensure_clean_worktree,
    secure_file_measure,
    sha256_file,
    write_json,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = ROOT / "artifacts" / "ui-smoke-runs"
DEFAULT_EXECUTABLE = ROOT / "src-tauri" / "target" / "release" / "tachyon-prism.exe"
RENDERER_MANIFEST_NAME = "RENDERER_EVIDENCE_MANIFEST.json"
NATIVE_MANIFEST_NAME = "NATIVE_BUILD_MANIFEST.json"
LEGACY_COMBINED_MANIFEST_NAME = "EVIDENCE_MANIFEST.json"
KEY_SCREENSHOTS = {
    "overview-desktop.png",
    "subscriptions-desktop.png",
    "configs-desktop.png",
    "routing-modes-desktop.png",
    "plugins-desktop.png",
    "settings-core-desktop-zh-CN.png",
    "settings-core-desktop-en.png",
}


def run_once(edge: Path, output_dir: Path, label: str, commit: str) -> dict[str, Any]:
    shutil.rmtree(output_dir, ignore_errors=True)
    command = [
        sys.executable,
        str(ROOT / "scripts" / "prism_ui_smoke.py"),
        "--edge",
        str(edge),
        "--out",
        str(output_dir),
        "--port",
        "0",
        "--run-label",
        label,
    ]
    completed = subprocess.run(command, cwd=ROOT, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"{label} exited with code {completed.returncode}")
    result_path = output_dir / "RESULT.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if result.get("status") != "passed" or result.get("gitCommit") != commit:
        raise RuntimeError(f"{label} produced invalid evidence: {result}")
    screenshots = sorted(output_dir.glob("*.png"), key=lambda path: path.name)
    missing = sorted(KEY_SCREENSHOTS - {path.name for path in screenshots})
    if missing:
        raise RuntimeError(f"{label} omitted required screenshots: {missing}")
    return {
        "label": label,
        "resultPath": result_path,
        "screenshots": screenshots,
    }


def manifest_reference(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": entry["path"],
        "sha256": entry["sha256"],
        "sizeBytes": entry["sizeBytes"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default=str(EDGE))
    parser.add_argument("--out", default=str(DEFAULT_ARTIFACTS))
    parser.add_argument("--executable", default=str(DEFAULT_EXECUTABLE))
    args = parser.parse_args()

    artifacts = Path(os.path.abspath(args.out))
    artifacts.mkdir(parents=True, exist_ok=True)
    result_path = artifacts / "RESULT.json"
    error_path = artifacts / "ERROR.json"
    renderer_manifest_path = artifacts / RENDERER_MANIFEST_NAME
    native_manifest_path = artifacts / NATIVE_MANIFEST_NAME
    legacy_manifest_path = artifacts / LEGACY_COMBINED_MANIFEST_NAME
    result_path.unlink(missing_ok=True)
    error_path.unlink(missing_ok=True)
    renderer_manifest_path.unlink(missing_ok=True)
    native_manifest_path.unlink(missing_ok=True)
    legacy_manifest_path.unlink(missing_ok=True)
    commit = current_git_commit(ROOT)
    try:
        ensure_clean_worktree(ROOT)
        edge = Path(args.edge).resolve()
        if not edge.is_file():
            raise FileNotFoundError(f"Edge executable not found: {edge}")
        executable = Path(os.path.abspath(args.executable))
        source_measure_before = secure_file_measure(executable)
        runs = [
            run_once(edge, artifacts / "run-1", "run-1", commit),
            run_once(edge, artifacts / "run-2", "run-2", commit),
        ]
        subject_dir = artifacts / "subject"
        shutil.rmtree(subject_dir, ignore_errors=True)
        subject_dir.mkdir(parents=True, exist_ok=True)
        subject_executable = subject_dir / executable.name
        shutil.copy2(executable, subject_executable)
        source_measure_after = secure_file_measure(executable)
        subject_measure = secure_file_measure(subject_executable)
        if source_measure_before != source_measure_after or subject_measure != source_measure_before:
            raise RuntimeError("native build executable changed during evidence copy")

        renderer_files: list[tuple[Path, str]] = []
        for run in runs:
            renderer_files.append((run["resultPath"], "renderer-run-result"))
            renderer_files.extend(
                (path, "renderer-fixture-screenshot") for path in run["screenshots"]
            )
        renderer_manifest = build_evidence_manifest(
            artifacts,
            commit,
            renderer_files,
            artifact_type="tachyon-prism-renderer-fixture-evidence",
        )
        native_manifest = build_evidence_manifest(
            artifacts,
            commit,
            [(subject_executable, "native-build-executable-not-executed")],
            artifact_type="tachyon-prism-native-build-evidence",
        )
        write_json(renderer_manifest_path, renderer_manifest)
        write_json(native_manifest_path, native_manifest)
        renderer_entries = {
            entry["path"]: entry for entry in renderer_manifest["files"]
        }
        native_entries = {entry["path"]: entry for entry in native_manifest["files"]}

        run_references = []
        for run in runs:
            result_relative = run["resultPath"].relative_to(artifacts).as_posix()
            screenshot_relatives = [
                path.relative_to(artifacts).as_posix() for path in run["screenshots"]
            ]
            run_references.append(
                {
                    "label": run["label"],
                    "result": manifest_reference(renderer_entries[result_relative]),
                    "screenshots": [
                        manifest_reference(renderer_entries[path])
                        for path in screenshot_relatives
                    ],
                }
            )
        subject_relative = subject_executable.relative_to(artifacts).as_posix()
        result = {
            "status": "layered-evidence-complete",
            "schemaVersion": 2,
            "artifactType": "tachyon-prism-layered-evidence-index",
            "gitCommit": commit,
            "rendererFixtureEvidence": {
                "status": "passed",
                "executionSubject": "vite-ui-smoke-renderer-fixture",
                "nativeExecutableExecuted": False,
                "runs": run_references,
                "manifest": {
                    "path": RENDERER_MANIFEST_NAME,
                    "sha256": sha256_file(renderer_manifest_path),
                },
            },
            "nativeBuildEvidence": {
                "status": "built-not-executed",
                "executable": manifest_reference(native_entries[subject_relative]),
                "manifest": {
                    "path": NATIVE_MANIFEST_NAME,
                    "sha256": sha256_file(native_manifest_path),
                },
            },
            "causalClaims": {
                "rendererFixtureExecutionProven": True,
                "nativeExecutableExecutionProven": False,
                "screenshotsProducedByNativeExecutable": False,
            },
        }
        write_json(result_path, result)
    except Exception as error:
        write_json(
            error_path,
            {
                "status": "failed",
                "gitCommit": commit,
                "errorType": type(error).__name__,
                "error": str(error),
            },
        )
        raise
    print(f"Two Prism UI smoke runs passed. Evidence: {result_path}")


if __name__ == "__main__":
    main()

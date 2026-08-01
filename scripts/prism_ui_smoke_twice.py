from __future__ import annotations

import argparse
import json
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
    sha256_file,
    write_json,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = ROOT / "artifacts" / "ui-smoke-runs"
DEFAULT_EXECUTABLE = ROOT / "src-tauri" / "target" / "release" / "tachyon-prism.exe"
MANIFEST_NAME = "EVIDENCE_MANIFEST.json"
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

    artifacts = Path(args.out).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    result_path = artifacts / "RESULT.json"
    error_path = artifacts / "ERROR.json"
    manifest_path = artifacts / MANIFEST_NAME
    result_path.unlink(missing_ok=True)
    error_path.unlink(missing_ok=True)
    manifest_path.unlink(missing_ok=True)
    commit = current_git_commit(ROOT)
    try:
        ensure_clean_worktree(ROOT)
        edge = Path(args.edge).resolve()
        if not edge.is_file():
            raise FileNotFoundError(f"Edge executable not found: {edge}")
        executable = Path(args.executable).resolve()
        if not executable.is_file():
            raise FileNotFoundError(f"Prism executable not found: {executable}")
        runs = [
            run_once(edge, artifacts / "run-1", "run-1", commit),
            run_once(edge, artifacts / "run-2", "run-2", commit),
        ]
        subject_dir = artifacts / "subject"
        shutil.rmtree(subject_dir, ignore_errors=True)
        subject_dir.mkdir(parents=True, exist_ok=True)
        subject_executable = subject_dir / executable.name
        shutil.copy2(executable, subject_executable)

        evidence_files: list[tuple[Path, str]] = [(subject_executable, "subject-executable")]
        for run in runs:
            evidence_files.append((run["resultPath"], "run-result"))
            evidence_files.extend((path, "screenshot") for path in run["screenshots"])
        manifest = build_evidence_manifest(artifacts, commit, evidence_files)
        write_json(manifest_path, manifest)
        entries = {entry["path"]: entry for entry in manifest["files"]}

        run_references = []
        for run in runs:
            result_relative = run["resultPath"].relative_to(artifacts).as_posix()
            screenshot_relatives = [
                path.relative_to(artifacts).as_posix() for path in run["screenshots"]
            ]
            run_references.append(
                {
                    "label": run["label"],
                    "result": manifest_reference(entries[result_relative]),
                    "screenshots": [
                        manifest_reference(entries[path])
                        for path in screenshot_relatives
                    ],
                }
            )
        subject_relative = subject_executable.relative_to(artifacts).as_posix()
        result = {
            "status": "passed",
            "schemaVersion": 1,
            "artifactType": "tachyon-prism-ui-smoke-evidence",
            "gitCommit": commit,
            "runs": run_references,
            "subjectExecutable": manifest_reference(entries[subject_relative]),
            "manifest": {
                "path": MANIFEST_NAME,
                "sha256": sha256_file(manifest_path),
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

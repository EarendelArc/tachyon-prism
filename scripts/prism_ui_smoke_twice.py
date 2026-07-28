from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from prism_ui_smoke import EDGE
from smoke_evidence import current_git_commit, write_json


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = ROOT / "artifacts" / "ui-smoke-runs"


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
    return {
        "label": label,
        "artifactDirectory": str(output_dir),
        "result": str(result_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default=str(EDGE))
    parser.add_argument("--out", default=str(DEFAULT_ARTIFACTS))
    args = parser.parse_args()

    artifacts = Path(args.out).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    result_path = artifacts / "RESULT.json"
    error_path = artifacts / "ERROR.json"
    result_path.unlink(missing_ok=True)
    error_path.unlink(missing_ok=True)
    commit = current_git_commit(ROOT)
    try:
        edge = Path(args.edge).resolve()
        if not edge.is_file():
            raise FileNotFoundError(f"Edge executable not found: {edge}")
        runs = [
            run_once(edge, artifacts / "run-1", "run-1", commit),
            run_once(edge, artifacts / "run-2", "run-2", commit),
        ]
        result = {"status": "passed", "gitCommit": commit, "runs": runs}
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

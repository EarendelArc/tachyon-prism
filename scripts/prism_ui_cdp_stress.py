from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

from prism_ui_smoke import EDGE, sanitize_diagnostic_text
from smoke_evidence import current_git_commit, write_json


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = ROOT / "artifacts" / "ui-cdp-stress"
ITERATION_TIMEOUT_SECONDS = 120


def stop_tree(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=10)


def run_iteration(edge: Path, output_dir: Path, index: int) -> dict[str, Any]:
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
        f"cdp-stress-{index}",
        "--startup-only",
    ]
    options: dict[str, Any] = {"cwd": ROOT}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        options["start_new_session"] = True
    process = subprocess.Popen(command, **options)
    try:
        return_code = process.wait(timeout=ITERATION_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        stop_tree(process)
        raise RuntimeError(f"stress iteration {index} exceeded the hard timeout") from error
    if return_code != 0:
        raise RuntimeError(f"stress iteration {index} exited with code {return_code}")
    result = json.loads((output_dir / "RESULT.json").read_text(encoding="utf-8"))
    if result.get("status") != "passed" or result.get("scope") != "startup-cdp-stress":
        raise RuntimeError(f"stress iteration {index} returned invalid status")
    if result.get("viewport") != {"width": 800, "height": 540}:
        raise RuntimeError(f"stress iteration {index} changed the evidence viewport")
    if not (output_dir / "overview-desktop.png").is_file():
        raise RuntimeError(f"stress iteration {index} omitted its overview screenshot")
    return {"iteration": index, "port": result["port"], "status": "passed"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default=str(EDGE))
    parser.add_argument("--out", default=str(DEFAULT_ARTIFACTS))
    parser.add_argument("--iterations", type=int, default=6)
    args = parser.parse_args()
    if not 2 <= args.iterations <= 20:
        raise ValueError("iterations must be between 2 and 20")
    output_dir = Path(args.out).resolve()
    shutil.rmtree(output_dir, ignore_errors=True)
    output_dir.mkdir(parents=True)
    commit = current_git_commit(ROOT)
    try:
        edge = Path(args.edge).resolve()
        runs = [
            run_iteration(edge, output_dir / f"run-{index}", index)
            for index in range(1, args.iterations + 1)
        ]
        write_json(
            output_dir / "RESULT.json",
            {"status": "passed", "gitCommit": commit, "iterations": runs},
        )
    except Exception as error:
        write_json(
            output_dir / "ERROR.json",
            {
                "status": "failed",
                "gitCommit": commit,
                "errorType": type(error).__name__,
                "error": sanitize_diagnostic_text(str(error)),
            },
        )
        raise
    print(f"Prism CDP stress fixture passed {args.iterations} independent iterations.")


if __name__ == "__main__":
    main()

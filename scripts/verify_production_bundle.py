#!/usr/bin/env python3
"""Fail closed if the production renderer contains the UI-smoke plaintext vault."""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path


FORBIDDEN_FRAGMENTS = (
    b"tachyon.prism.uiSmokeVault.v1",
    b"secureStorageBackend.ui-smoke",
    b"uiSmokeLoad",
    b"uiSmokeSave",
    b"uiSmokeMigrate",
)


def verify_bundle(directory: Path) -> None:
    if not directory.is_dir():
        raise ValueError(f"production bundle directory does not exist: {directory}")
    files = sorted(path for path in directory.rglob("*") if path.is_file())
    if not files:
        raise ValueError(f"production bundle is empty: {directory}")
    findings: list[str] = []
    for path in files:
        content = path.read_bytes()
        for fragment in FORBIDDEN_FRAGMENTS:
            if fragment in content:
                findings.append(f"{path}: {fragment.decode('ascii')}")
    if findings:
        raise ValueError(
            "UI-smoke plaintext vault leaked into the production bundle:\n"
            + "\n".join(findings)
        )


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="prism-bundle-scan-") as raw:
        root = Path(raw)
        clean = root / "clean"
        clean.mkdir()
        (clean / "app.js").write_text("console.log('production')", encoding="utf-8")
        verify_bundle(clean)

        for index, fragment in enumerate(FORBIDDEN_FRAGMENTS):
            tainted = root / f"tainted-{index}"
            tainted.mkdir()
            (tainted / "app.js").write_bytes(b"prefix:" + fragment + b":suffix")
            try:
                verify_bundle(tainted)
            except ValueError as error:
                if fragment.decode("ascii") not in str(error):
                    raise AssertionError("scanner did not identify the leaked fragment") from error
            else:
                raise AssertionError(f"scanner accepted forbidden fragment: {fragment!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.dist and not args.self_test:
        parser.error("at least one of --dist or --self-test is required")
    try:
        if args.self_test:
            self_test()
        if args.dist:
            verify_bundle(args.dist)
    except (OSError, ValueError, AssertionError) as error:
        print(f"production bundle verification failed: {error}")
        return 1
    print("production bundle contains no UI-smoke plaintext vault")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

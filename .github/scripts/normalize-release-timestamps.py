#!/usr/bin/env python3

from __future__ import annotations

import os
from pathlib import Path
import sys


def fail(message: str) -> None:
    raise SystemExit(f"release timestamp normalization failed: {message}")


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: normalize-release-timestamps.py <release-dir> <source-date-epoch>")
    root = Path(sys.argv[1])
    if not root.is_dir():
        fail(f"release directory does not exist: {root}")
    try:
        epoch = int(sys.argv[2])
    except ValueError:
        fail("SOURCE_DATE_EPOCH must be an integer")
    if epoch < 0:
        fail("SOURCE_DATE_EPOCH must not be negative")

    paths = sorted(root.rglob("*"))
    if any(path.is_symlink() for path in paths):
        fail("release directory must not contain symlinks")
    timestamp_ns = epoch * 1_000_000_000
    for path in paths:
        if path.is_file():
            os.utime(path, ns=(timestamp_ns, timestamp_ns))
    for path in sorted((path for path in paths if path.is_dir()), reverse=True):
        os.utime(path, ns=(timestamp_ns, timestamp_ns))
    os.utime(root, ns=(timestamp_ns, timestamp_ns))
    print(f"normalized {sum(path.is_file() for path in paths)} release asset timestamps to {epoch}")


if __name__ == "__main__":
    main()
